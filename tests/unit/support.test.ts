import { describe, expect, it } from "vitest";
import { isTransientDbError, retryTransient } from "../../src/db/pool";
import { judgeSnapshot } from "../../src/ingest/reconcile";
import { createLogger, redact } from "../../src/logger";

describe("redact", () => {
  it("removes Telegram tokens from URLs", () => {
    const text = redact("POST https://api.telegram.org/bot123456:AAH-secret_x/sendMessage failed");
    expect(text).not.toContain("AAH-secret_x");
    expect(text).toContain("sendMessage failed");
  });

  it("removes database passwords", () => {
    const text = redact("connect postgres://user:hunter2@db.example.test/app");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("db.example.test");
  });

  it("applies to everything a logger writes", () => {
    const lines: string[] = [];
    createLogger("info", (line) => lines.push(line)).error("failed", { url: "https://x/bot1:abc/getMe" });
    expect(lines[0]).not.toContain("bot1:abc");
  });

  it("respects the level", () => {
    const lines: string[] = [];
    createLogger("warn", (line) => lines.push(line)).info("quiet");
    expect(lines).toEqual([]);
  });
});

describe("judgeSnapshot", () => {
  const judge = (facts: Partial<Parameters<typeof judgeSnapshot>[0]>) =>
    judgeSnapshot({ total: 10, previousTotal: 10, activeBefore: 10, newlyAbsent: 0, ...facts }, 0.5);

  it("accepts a normal snapshot", () => {
    expect(judge({})).toBeNull();
    expect(judge({ total: 8, newlyAbsent: 2 })).toBeNull();
  });

  it("flags an empty board, including the first crawl", () => {
    expect(judge({ total: 0 })).toMatch(/empty/i);
    expect(judge({ total: 0, previousTotal: null, activeBefore: 0 })).toMatch(/empty/i);
  });

  it("accepts a board already known to be empty", () => {
    expect(judge({ total: 0, previousTotal: 0, activeBefore: 0 })).toBeNull();
  });

  it("flags a large shrink", () => {
    expect(judge({ total: 4 })).toMatch(/shrank/i);
  });

  it("flags a broken scope filter on a board whose size held", () => {
    expect(judge({ newlyAbsent: 6 })).toMatch(/absent/i);
  });

  it("ignores small boards, where one posting is a large share", () => {
    expect(judge({ total: 1, previousTotal: 3, activeBefore: 3, newlyAbsent: 2 })).toBeNull();
  });

  it("does not doubt listings already absent from an accepted snapshot", () => {
    expect(judge({ total: 0, previousTotal: 0, newlyAbsent: 0 })).toBeNull();
  });
});

describe("retryTransient", () => {
  const transient = Object.assign(new Error("reset"), { code: "ECONNRESET" });

  it("recognizes transient and permanent errors", () => {
    expect(isTransientDbError(transient)).toBe(true);
    expect(isTransientDbError(Object.assign(new Error("dup"), { code: "23505" }))).toBe(false);
    expect(isTransientDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("retries transient failures up to its bound", async () => {
    let calls = 0;
    const failing = retryTransient(
      async () => {
        calls += 1;
        throw transient;
      },
      { attempts: 3, sleep: async () => {} },
    );
    await expect(failing).rejects.toThrow("reset");
    expect(calls).toBe(3);
  });

  it("does not retry a permanent failure", async () => {
    let calls = 0;
    await expect(
      retryTransient(async () => {
        calls += 1;
        throw new Error("syntax error");
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
