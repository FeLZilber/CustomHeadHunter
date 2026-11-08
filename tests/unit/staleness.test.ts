import { describe, expect, it } from "vitest";
import { isDiscoveryStale } from "../../src/worker/maintenance";

const checkedAt = new Date("2026-11-08T12:00:00Z");
const hoursAgo = (hours: number) => new Date(checkedAt.getTime() - hours * 3_600_000);

describe("isDiscoveryStale", () => {
  it("is fresh after a recent successful crawl", () => {
    expect(isDiscoveryStale(hoursAgo(5), checkedAt, 30)).toBe(false);
  });

  it("is stale when the last successful crawl is older than the limit", () => {
    expect(isDiscoveryStale(hoursAgo(31), checkedAt, 30)).toBe(true);
  });

  it("is stale when discovery never succeeded", () => {
    expect(isDiscoveryStale(null, checkedAt, 30)).toBe(true);
  });

  it("is still fresh exactly at the limit and stale just past it", () => {
    expect(isDiscoveryStale(hoursAgo(30), checkedAt, 30)).toBe(false);
    expect(isDiscoveryStale(new Date(hoursAgo(30).getTime() - 1), checkedAt, 30)).toBe(true);
  });

  it("turns one missed daily run red at the 30 hour default", () => {
    // Daily discovery at 06:17; the next check after one dropped run is 48 h later.
    expect(isDiscoveryStale(hoursAgo(24), checkedAt, 30)).toBe(false);
    expect(isDiscoveryStale(hoursAgo(48), checkedAt, 30)).toBe(true);
  });
});
