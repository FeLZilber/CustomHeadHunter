import { describe, expect, it } from "vitest";
import { HttpClient, type Transport, type TransportResponse } from "../../src/http/client";
import { discoverBoards, probeBoard, slugCandidates, verificationUrl } from "../../src/ingest/probe";

const json = (body: unknown): TransportResponse => ({ status: 200, body: JSON.stringify(body), headers: {} });
const status = (code: number): TransportResponse => ({ status: code, body: "", headers: {} });

function http(handler: (url: URL) => TransportResponse) {
  const urls: string[] = [];
  const transport: Transport = async (url) => {
    urls.push(url.toString());
    return handler(url);
  };
  return { client: new HttpClient({ transport, sleep: async () => {}, random: () => 0, hostIntervalMs: {}, maxRetries: 0 }), urls };
}

const job = (id: number, title: string, location: string) => ({
  id,
  title,
  absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
  location: { name: location },
  content: "",
});

describe("slugCandidates", () => {
  it("guesses joined, dashed and underscored slugs", () => {
    expect(slugCandidates("Check Point")).toEqual(["checkpoint", "check-point", "check_point"]);
    expect(slugCandidates("Wiz")).toEqual(["wiz"]);
    expect(slugCandidates("Monday.com")).toEqual(["mondaycom"]);
    expect(slugCandidates("***")).toEqual([]);
  });
});

describe("probeBoard", () => {
  it("counts Israeli and QA-like listings", async () => {
    const { client } = http(() =>
      json({
        jobs: [
          job(1, "QA Automation Engineer", "Tel Aviv"),
          job(2, "Backend Engineer", "Tel Aviv, Israel"),
          job(3, "QA Engineer", "London, UK"),
        ],
      }),
    );
    expect(await probeBoard(client, "greenhouse", "acme")).toMatchObject({ status: "found", total: 3, israeli: 2, qaTitles: 1 });
  });

  it("reports an unknown board as missing, not as an error", async () => {
    const { client } = http(() => status(404));
    expect(await probeBoard(client, "greenhouse", "nope")).toMatchObject({ status: "missing", total: 0 });
  });

  it("reports a server failure as an error so it is not mistaken for a missing board", async () => {
    const { client } = http(() => status(500));
    expect(await probeBoard(client, "lever", "acme")).toMatchObject({ status: "error" });
  });
});

describe("discoverBoards", () => {
  it("tries each provider and slug, ranking boards by Israeli jobs", async () => {
    const { client, urls } = http((url) => {
      if (url.pathname.endsWith("/check-point/jobs")) return json({ jobs: [job(1, "QA", "Tel Aviv")] });
      return status(404);
    });
    const found = await discoverBoards(client, "Check Point", ["greenhouse"]);
    expect(found.map((b) => b.providerKey)).toEqual(["check-point"]);
    expect(urls).toHaveLength(3);
  });
});

describe("verificationUrl", () => {
  it("points at each provider's public listing endpoint", () => {
    expect(verificationUrl("greenhouse", "acme")).toBe("https://boards-api.greenhouse.io/v1/boards/acme/jobs");
    expect(verificationUrl("lever", "acme")).toBe("https://api.lever.co/v0/postings/acme");
    expect(verificationUrl("ashby", "acme")).toBe("https://api.ashbyhq.com/posting-api/job-board/acme");
  });
});
