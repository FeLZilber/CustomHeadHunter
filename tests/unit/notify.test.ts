import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BudgetSchema, loadBudget, withoutBlanks } from "../../src/config/budget";
import { loadWorkerEnv } from "../../src/config/env";
import { buildMatchConfig } from "../../src/match/config";
import { escapeHtml, MAX_MESSAGE_CHARS, renderAlert, renderDigest, visibleLength, type JobCard } from "../../src/notify/message";
import { TelegramClient } from "../../src/notify/telegram";

const TOKEN = "123456:SECRET-token";

const card = (overrides: Partial<JobCard> = {}): JobCard => ({
  title: "QA Automation Engineer",
  company: "Fixture Co",
  location: "Tel Aviv, Israel",
  score: 85,
  technologies: ["Playwright", "TypeScript"],
  gaps: ["Rust"],
  unconfirmedGaps: 0,
  explanation: "A good fit.",
  discoveredAt: new Date("2026-11-01T10:00:00Z"),
  url: "https://example.test/jobs/1?a=1&b=2",
  ...overrides,
});

function reply(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return async () => new Response(text, { status });
}

const client = (fetcher: () => Promise<Response>) => new TelegramClient(TOKEN, "42", fetcher as unknown as typeof fetch);

function connectionError(code: string) {
  return async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code } });
  };
}

describe("telegram client", () => {
  it("sends the documented request and keeps previews off", async () => {
    let url = "";
    let body: Record<string, any> = {};
    const fetcher = async (input: string, init: RequestInit) => {
      url = input;
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    };
    const outcome = await new TelegramClient(TOKEN, "42", fetcher as unknown as typeof fetch).send("<b>x</b>");
    expect(outcome).toEqual({ kind: "sent", messageId: "7" });
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(body).toEqual({ chat_id: "42", text: "<b>x</b>", parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  it("reports flood control with Telegram's wait", async () => {
    const outcome = await client(
      reply(429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 17 } }),
    ).send("x");
    expect(outcome).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 17 });
  });

  it.each([
    [401, "Unauthorized"],
    [403, "Forbidden: bot was blocked by the user"],
    [400, "Bad Request: chat not found"],
  ])("treats %i %s as a configuration problem", async (status, description) => {
    expect(await client(reply(status, { ok: false, error_code: status, description })).send("x")).toMatchObject({ kind: "misconfigured" });
  });

  it("treats other Bot API refusals as a rejection of this message", async () => {
    const outcome = await client(reply(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" })).send("x");
    expect(outcome).toMatchObject({ kind: "rejected" });
  });

  it("treats a Bot API server error as not delivered", async () => {
    expect(await client(reply(500, { ok: false, error_code: 500, description: "Internal Server Error" })).send("x")).toMatchObject({
      kind: "not_delivered",
    });
  });

  it.each([
    ["a gateway error page", reply(502, "<html>Bad Gateway</html>")],
    ["an unreadable success", reply(200, "not json")],
    ["a success without an id", reply(200, { ok: true, result: {} })],
  ])("treats %s as ambiguous", async (_name, fetcher) => {
    expect(await client(fetcher).send("x")).toMatchObject({ kind: "ambiguous" });
  });

  it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"])("knows %s never reached Telegram", async (code) => {
    expect(await client(connectionError(code)).send("x")).toEqual({ kind: "not_delivered", detail: code });
  });

  it.each(["ECONNRESET", "UND_ERR_SOCKET"])("treats %s after connecting as ambiguous", async (code) => {
    expect(await client(connectionError(code)).send("x")).toMatchObject({ kind: "ambiguous" });
  });

  it("treats a timed out request as ambiguous", async () => {
    const fetcher = async () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    expect(await client(fetcher).send("x")).toEqual({ kind: "ambiguous", detail: "TimeoutError" });
  });

  it("never lets the token into an outcome", async () => {
    const leaky = [
      async () => {
        throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`);
      },
      reply(400, { ok: false, error_code: 400, description: `bad url bot${TOKEN}/sendMessage` }),
    ];
    for (const fetcher of leaky) expect(JSON.stringify(await client(fetcher).send("x"))).not.toContain("SECRET");
  });
});

describe("message rendering", () => {
  it("includes every field the alert must carry", () => {
    const html = renderAlert("discovered", card());
    for (const part of ["85/100", "QA Automation Engineer", "Fixture Co", "Tel Aviv", "Playwright, TypeScript", "Rust", "A good fit.", "2026-11-01"]) {
      expect(html).toContain(part);
    }
    expect(html).toContain('<a href="https://example.test/jobs/1?a=1&amp;b=2">');
  });

  it("names the event", () => {
    expect(renderAlert("reopened", card())).toContain("reopened");
    expect(renderAlert("changed", card())).toContain("changed");
  });

  it("escapes untrusted text so it cannot open a tag", () => {
    const hostile = `<script>alert("x")</script> & <a href="https://evil.test">click</a>`;
    const html = renderAlert("discovered", card({ title: hostile, company: hostile, location: hostile, explanation: hostile, gaps: [hostile], technologies: [hostile] }));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("evil.test\">");
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("drops a link that is not http or https", () => {
    for (const url of ["javascript:alert(1)", "not a url", null]) {
      expect(renderAlert("discovered", card({ url }))).not.toContain("<a ");
    }
  });

  it("escapes a quote that would end the href", () => {
    const html = renderAlert("discovered", card({ url: 'https://example.test/"><b>x' }));
    expect(html).not.toContain('"><b>');
  });

  it("keeps an alert under the limit with the largest fields", () => {
    const big = "ש".repeat(9000);
    const html = renderAlert("discovered", card({ title: big, company: big, location: big, explanation: big, gaps: [big, big, big, big, big], technologies: Array(30).fill(big) }));
    expect(visibleLength(html)).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });

  it("does not split a surrogate pair when cutting", () => {
    const html = renderAlert("discovered", card({ explanation: "😀".repeat(1000) }));
    expect(html).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("counts entities as the characters they decode to", () => {
    expect(visibleLength("<b>a &amp; b</b>")).toBe(5);
    expect(escapeHtml(`<>&"`)).toBe("&lt;&gt;&amp;&quot;");
  });

  it("shows the digest count that did not fit", () => {
    const html = renderDigest("Top", [card(), card({ score: 80 })], 3);
    expect(html).toContain("3 more on the dashboard");
    expect(html.indexOf("85/100")).toBeLessThan(html.indexOf("80/100"));
  });

  it("drops whole digest entries instead of breaking the limit", () => {
    const big = "x".repeat(2000);
    const cards = Array.from({ length: 10 }, () => card({ gaps: [big, big, big, big], title: big, company: big, location: big, explanation: big, technologies: Array(8).fill(big) }));
    const html = renderDigest("Top", cards, 0);
    expect(visibleLength(html)).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(html).toContain("more on the dashboard");
  });
});

describe("configuration from Actions", () => {
  const base = { DATABASE_URL: "postgres://x" };

  it("treats an unset secret as absent rather than invalid", () => {
    const env = loadWorkerEnv({ ...base, TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" });
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it("does not read an unset variable as a limit of zero", () => {
    expect(loadBudget({ MAX_AI_JOBS_PER_RUN: "" }).MAX_AI_JOBS_PER_RUN).toBe(BudgetSchema.parse({}).MAX_AI_JOBS_PER_RUN);
    expect(withoutBlanks({ A: "", B: "0" })).toEqual({ B: "0" });
  });
});

describe("workflow budgets", () => {
  const timeout = BudgetSchema.parse({}).INFERENCE_TIMEOUT_SECONDS;
  const seconds = (file: string) =>
    [...readFileSync(path.resolve(".github/workflows", file), "utf8").matchAll(/ai-seconds:\D*(\d+)/g)].map((match) => Number(match[1]));

  // The runner starts a job only if a full timeout still fits, so a smaller budget would silently never run one.
  it.each(["discovery.yml", "maintenance.yml", "pipeline-smoke.yml"])("%s leaves room for at least one job", (file) => {
    expect(seconds(file).length).toBeGreaterThan(0);
    for (const budget of seconds(file)) expect(budget).toBeGreaterThan(timeout);
  });

  // Tests elsewhere pass explicit limits, so this is the one place the shipped defaults meet the guard.
  it("ships defaults that fit the model's context", () => {
    expect(() => buildMatchConfig(BudgetSchema.parse({}))).not.toThrow();
  });

  it("gives the configured default budget room for more than one long job", () => {
    const { AI_TIME_BUDGET_SECONDS } = BudgetSchema.parse({});
    expect(AI_TIME_BUDGET_SECONDS - timeout).toBeGreaterThan(216);
  });
});
