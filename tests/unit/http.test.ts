import { describe, expect, it } from "vitest";
import { HttpClient, ResponseTooLargeError, userAgentFor, type Transport, type TransportResponse } from "../../src/http/client";
import { assertAllowedUrl, BlockedDestinationError, createGuardedLookup, isBlockedAddress } from "../../src/http/guard";

const respond = (status: number, body = "{}", headers: Record<string, string> = {}): TransportResponse => ({ status, body, headers });

function scripted(responses: Array<TransportResponse | Error>) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const transport: Transport = async (url, headers) => {
    requests.push({ url: url.toString(), headers });
    const next = responses.shift();
    if (!next) throw new Error("No scripted response");
    if (next instanceof Error) throw next;
    return next;
  };
  const sleeps: number[] = [];
  const client = new HttpClient({
    transport,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    hostIntervalMs: {},
  });
  return { client, requests, sleeps };
}

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["104.18.0.1", "8.8.8.8", "2606:4700::1111"])("allows %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("assertAllowedUrl", () => {
  it.each(["http://example.com", "https://localhost/x", "https://127.0.0.1/", "https://[::1]/", "https://user:pw@example.com/", "ftp://example.com"])(
    "rejects %s",
    (url) => {
      expect(() => assertAllowedUrl(new URL(url))).toThrow(BlockedDestinationError);
    },
  );

  it("accepts a public https URL", () => {
    expect(() => assertAllowedUrl(new URL("https://boards-api.greenhouse.io/v1/boards/x"))).not.toThrow();
  });
});

describe("guarded DNS lookup", () => {
  const lookup = (addresses: string[]) =>
    new Promise<{ error: Error | null; address?: unknown }>((resolve) => {
      const guarded = createGuardedLookup((_hostname, callback) =>
        callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))),
      );
      guarded("host.test", {}, (error: Error | null, address: unknown) => resolve({ error, address }));
    });

  it("rejects a hostname that resolves to a private address", async () => {
    expect((await lookup(["10.0.0.1"])).error).toBeInstanceOf(BlockedDestinationError);
  });

  it("rejects when any resolved address is private", async () => {
    expect((await lookup(["8.8.8.8", "169.254.169.254"])).error).toBeInstanceOf(BlockedDestinationError);
  });

  it("passes a public address", async () => {
    expect((await lookup(["8.8.8.8"])).error).toBeNull();
  });
});

describe("HttpClient", () => {
  const url = "https://example.test/a";

  it("returns the body and ETag", async () => {
    const { client } = scripted([respond(200, "ok", { etag: '"v1"' })]);
    expect(await client.get(url)).toEqual({ kind: "ok", status: 200, body: "ok", etag: '"v1"' });
  });

  it("posts JSON with the same checks as a GET", async () => {
    const sent: Array<{ method?: string; body?: string; type?: string }> = [];
    const responses = [respond(503), respond(200, '{"ok":true}')];
    const client = new HttpClient({
      transport: async (_url, headers, options) => {
        sent.push({ method: options.method, body: options.body, type: headers["content-type"] });
        return responses.shift()!;
      },
      sleep: async () => {},
      random: () => 0,
      hostIntervalMs: {},
    });
    expect(await client.postJson("https://api.example.com/jobs", { limit: 20 })).toMatchObject({ kind: "ok", body: '{"ok":true}' });
    expect(sent).toEqual([
      { method: "POST", body: '{"limit":20}', type: "application/json" },
      { method: "POST", body: '{"limit":20}', type: "application/json" },
    ]);
  });

  it("sends If-None-Match and reports 304", async () => {
    const { client, requests } = scripted([respond(304)]);
    expect((await client.get(url, { etag: '"v1"' })).kind).toBe("not_modified");
    expect(requests[0]?.headers["if-none-match"]).toBe('"v1"');
  });

  it("retries a 503 a bounded number of times", async () => {
    const { client, requests } = scripted([respond(503), respond(503), respond(503), respond(503), respond(200)]);
    const result = await client.get(url);
    expect(result).toMatchObject({ kind: "failed", status: 503 });
    expect(requests).toHaveLength(4);
  });

  it("recovers after a transient network error", async () => {
    const { client } = scripted([new Error("ECONNRESET"), respond(200)]);
    expect((await client.get(url)).kind).toBe("ok");
  });

  it("honors Retry-After in seconds", async () => {
    const { client, sleeps } = scripted([respond(429, "", { "retry-after": "7" }), respond(200)]);
    await client.get(url);
    expect(sleeps).toContain(7000);
  });

  it("gives up rather than wait past the Retry-After cap", async () => {
    const { client } = scripted([respond(429, "", { "retry-after": "86400" })]);
    expect(await client.get(url)).toMatchObject({ kind: "failed", error: "Retry-After exceeds the wait limit" });
  });

  it("reports blocking without retrying", async () => {
    const { client, requests } = scripted([respond(403)]);
    expect((await client.get(url)).kind).toBe("blocked");
    expect(requests).toHaveLength(1);
  });

  it("does not retry a 404", async () => {
    const { client, requests } = scripted([respond(404)]);
    expect((await client.get(url)).kind).toBe("failed");
    expect(requests).toHaveLength(1);
  });

  it("revalidates every redirect target", async () => {
    const { client, requests } = scripted([respond(302, "", { location: "https://169.254.169.254/latest/meta-data" })]);
    expect((await client.get(url)).kind).toBe("blocked");
    expect(requests).toHaveLength(1);
  });

  it("stops following a redirect to plain http", async () => {
    const { client } = scripted([respond(301, "", { location: "http://example.test/a" })]);
    expect((await client.get(url)).kind).toBe("blocked");
  });

  it("bounds redirects", async () => {
    const loop = Array.from({ length: 10 }, () => respond(302, "", { location: "/a" }));
    const { client, requests } = scripted(loop);
    expect(await client.get(url)).toMatchObject({ kind: "failed", error: "Too many redirects" });
    expect(requests).toHaveLength(6);
  });

  it("fails an oversized response without retrying", async () => {
    const { client, requests } = scripted([new ResponseTooLargeError(10)]);
    expect((await client.get(url)).kind).toBe("failed");
    expect(requests).toHaveLength(1);
  });

  it("paces requests to the same host", async () => {
    const sleeps: number[] = [];
    const client = new HttpClient({
      transport: async () => respond(200),
      now: () => 1000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      hostIntervalMs: { "api.lever.co": 1000, default: 0 },
    });
    await client.get("https://api.lever.co/a");
    await client.get("https://api.lever.co/b");
    await client.get("https://api.lever.co/c");
    expect(sleeps).toEqual([1000, 2000]);
  });
});

describe("HttpClient robots.txt", () => {
  const ROBOTS = "https://example.test/robots.txt";

  function site(robots: TransportResponse | Error, pages: Record<string, TransportResponse> = {}) {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const sleeps: number[] = [];
    const transport: Transport = async (url, headers) => {
      requests.push({ url: url.toString(), headers });
      if (url.pathname === "/robots.txt") {
        if (robots instanceof Error) throw robots;
        return robots;
      }
      return pages[url.pathname] ?? respond(200, "page");
    };
    const client = new HttpClient({
      transport,
      robots: true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1000,
      random: () => 0,
      hostIntervalMs: { default: 0 },
      userAgent: userAgentFor("ops@example.test"),
    });
    return { client, requests, sleeps };
  }

  it("never requests a disallowed path and reports it blocked", async () => {
    const { client, requests } = site(respond(200, "User-agent: *\nDisallow: /private"));
    expect(await client.get("https://example.test/private/x")).toEqual({
      kind: "blocked",
      status: 0,
      error: "Disallowed by robots.txt",
    });
    expect(requests.map((r) => r.url)).toEqual([ROBOTS]);
    expect((await client.get("https://example.test/public")).kind).toBe("ok");
  });

  it("applies robots.txt to a POST as well", async () => {
    const { client, requests } = site(respond(200, "User-agent: *\nDisallow: /private/"));
    expect(await client.postJson("https://example.test/private/jobs", {})).toMatchObject({ kind: "blocked", error: "Disallowed by robots.txt" });
    expect(requests.map((r) => r.url)).toEqual([ROBOTS]);
  });

  it("treats a 404 robots.txt as allow-all", async () => {
    const { client } = site(respond(404));
    expect((await client.get("https://example.test/anything")).kind).toBe("ok");
  });

  it("treats a 403 robots.txt as allow-all", async () => {
    const { client } = site(respond(403));
    expect((await client.get("https://example.test/anything")).kind).toBe("ok");
  });

  it("blocks everything when robots.txt answers 5xx, trying it only twice", async () => {
    const { client, requests } = site(respond(500));
    expect(await client.get("https://example.test/a")).toMatchObject({ kind: "blocked", error: "Disallowed by robots.txt" });
    expect((await client.get("https://example.test/b")).kind).toBe("blocked");
    expect(requests.map((r) => r.url)).toEqual([ROBOTS, ROBOTS]);
  });

  it("blocks everything when robots.txt cannot be reached", async () => {
    const { client } = site(new Error("ECONNRESET"));
    expect((await client.get("https://example.test/a")).kind).toBe("blocked");
  });

  it("fetches robots.txt once per origin across concurrent requests", async () => {
    const { client, requests } = site(respond(200, "User-agent: *\nDisallow: /nope"));
    await Promise.all(["/a", "/b", "/c", "/d"].map((path) => client.get(`https://example.test${path}`)));
    await client.get("https://example.test/e");
    expect(requests.filter((r) => r.url === ROBOTS)).toHaveLength(1);
    expect(requests).toHaveLength(6);
  });

  it("follows a robots.txt redirect", async () => {
    const requests: string[] = [];
    const client = new HttpClient({
      robots: true,
      sleep: async () => {},
      hostIntervalMs: {},
      transport: async (url) => {
        requests.push(url.toString());
        if (url.toString() === ROBOTS) return respond(301, "", { location: "https://example.test/real-robots" });
        if (url.pathname === "/real-robots") return respond(200, "User-agent: *\nDisallow: /x");
        return respond(200);
      },
    });
    expect((await client.get("https://example.test/x")).kind).toBe("blocked");
    expect(requests).toEqual([ROBOTS, "https://example.test/real-robots"]);
  });

  it("slows pacing to the site's Crawl-delay, capped at 10 seconds", async () => {
    const { client, sleeps } = site(respond(200, "User-agent: *\nCrawl-delay: 3"));
    await client.get("https://example.test/a");
    await client.get("https://example.test/b");
    expect(sleeps).toContain(3000);

    const capped = site(respond(200, "User-agent: *\nCrawl-delay: 600"));
    await capped.client.get("https://example.test/a");
    await capped.client.get("https://example.test/b");
    expect(Math.max(...capped.sleeps)).toBe(10_000);
  });

  it("blocks a redirect that lands on a disallowed path", async () => {
    const { client, requests } = site(respond(200, "User-agent: *\nDisallow: /private"), {
      "/start": respond(302, "", { location: "/private/page" }),
    });
    expect(await client.get("https://example.test/start")).toMatchObject({ kind: "blocked", error: "Disallowed by robots.txt" });
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/robots.txt", "/start"]);
  });

  it("sends the contact in the user agent, also on robots.txt", async () => {
    const { client, requests } = site(respond(404));
    await client.get("https://example.test/a");
    for (const request of requests) {
      expect(request.headers["user-agent"]).toBe("headhunter-personal-job-search/0.2 (+ops@example.test)");
    }
  });

  it("lets a caller ask for another content type", async () => {
    const { client, requests } = site(respond(404));
    await client.get("https://example.test/a", { accept: "text/html" });
    expect(requests.at(-1)?.headers.accept).toBe("text/html");
  });

  it("builds the user agent with or without a contact", () => {
    expect(userAgentFor(undefined)).toBe("headhunter-personal-job-search/0.2");
    expect(userAgentFor("")).toBe("headhunter-personal-job-search/0.2");
    expect(userAgentFor("https://example.test/repo")).toBe("headhunter-personal-job-search/0.2 (+https://example.test/repo)");
  });
});
