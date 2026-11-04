import { describe, expect, it } from "vitest";
import { healthAlerts, renderAlerts, type Health } from "../../src/worker/maintenance";

const healthy: Health = {
  checkedAt: new Date("2026-11-04T00:00:00Z"),
  lastSuccessfulCrawl: new Date("2026-11-03T20:00:00Z"),
  lastCrawl: { status: "succeeded", finishedAt: new Date("2026-11-03T20:00:00Z") },
  discoveryStale: false,
  staleSources: 0,
  activeJobs: 100,
  backlog: { pending: 0, due: 0, oldestAgeSeconds: null, exhausted: 0 } as Health["backlog"],
  aiMinutesThisMonth: 100,
  outbox: {},
  lastNotify: null,
};

describe("healthAlerts", () => {
  it("is silent when everything is fine", () => {
    expect(healthAlerts(healthy, 800)).toEqual([]);
  });

  it("reports stale discovery, a failed crawl, the budget and stuck deliveries", () => {
    const alerts = healthAlerts(
      { ...healthy, discoveryStale: true, lastCrawl: { status: "failed", finishedAt: null }, aiMinutesThisMonth: 800, outbox: { ambiguous: 2, failed: 1 } },
      800,
    );
    expect(alerts).toHaveLength(5);
    expect(alerts.join("\n")).toContain("Monthly AI budget is spent");
  });

  it("warns before the budget is spent and not at 89%", () => {
    expect(healthAlerts({ ...healthy, aiMinutesThisMonth: 712 }, 800)).toEqual([]);
    expect(healthAlerts({ ...healthy, aiMinutesThisMonth: 720 }, 800)[0]).toContain("nearly spent");
  });

  it("escapes markup for Telegram HTML", () => {
    expect(renderAlerts(["a < b & c"])).toContain("a &lt; b &amp; c");
  });
});
