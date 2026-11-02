import { describe, expect, it } from "vitest";
import type { RawListing } from "../../src/connectors/types";
import { changedFields, matchingFields, normalizeListing } from "../../src/normalize";
import { decodeEntities, htmlToText } from "../../src/normalize/html";
import { canonicalizeUrl } from "../../src/normalize/url";

const raw: RawListing = {
  providerJobId: "1",
  requisitionId: "REQ-1",
  title: "Senior QA Automation Engineer",
  originalDescription: "<p>Requirements:</p><ul><li>5+ years of experience</li><li>Playwright</li></ul>",
  descriptionText: "Requirements:\n- 5+ years of experience\n- Playwright",
  location: "Modiin, Israel",
  extraLocations: [],
  workplaceType: null,
  commitment: null,
  salary: null,
  applicationUrl: "https://example.test/jobs/1?gh_jid=1&utm_source=linkedin",
  publishedAt: new Date("2026-10-01T00:00:00Z"),
  providerUpdatedAt: new Date("2026-10-02T00:00:00Z"),
};

const hash = (overrides: Partial<RawListing>) => normalizeListing({ ...raw, ...overrides }).contentHash;

describe("normalizeListing", () => {
  it("keeps originals next to derived values", () => {
    const listing = normalizeListing(raw);
    expect(listing.originalLocation).toBe("Modiin, Israel");
    expect(listing.locations[0]?.city).toBe("Modi'in");
    expect(listing.applicationUrl).toBe(raw.applicationUrl);
    expect(listing.canonicalUrl).toBe("https://example.test/jobs/1?gh_jid=1");
    expect(listing.seniority).toBe("senior");
    expect(listing.experience?.minYears).toBe(5);
  });

  it("leaves unknown facts null", () => {
    const listing = normalizeListing({ ...raw, title: "QA", descriptionText: "Testing." });
    expect(listing).toMatchObject({ seniority: null, experience: null, salary: null, workArrangement: null, employmentType: null });
  });

  it("marks remote jobs without a stated arrangement", () => {
    expect(normalizeListing({ ...raw, location: "Remote - Israel" }).workArrangement).toBe("remote");
  });
});

describe("content hash", () => {
  const base = hash({});

  it("is stable", () => {
    expect(hash({})).toBe(base);
  });

  it("ignores timestamps, URLs and formatting", () => {
    expect(hash({ publishedAt: null, providerUpdatedAt: new Date() })).toBe(base);
    expect(hash({ applicationUrl: "https://example.test/other" })).toBe(base);
    expect(hash({ originalDescription: "<div>different markup</div>" })).toBe(base);
    expect(hash({ descriptionText: "Requirements:\n-  5+ years   of experience\n- Playwright" })).toBe(base);
    expect(hash({ title: "SENIOR QA AUTOMATION ENGINEER" })).toBe(base);
  });

  it("changes with matching-relevant fields", () => {
    expect(hash({ title: "Lead QA Automation Engineer" })).not.toBe(base);
    expect(hash({ location: "Jerusalem" })).not.toBe(base);
    expect(hash({ workplaceType: "hybrid" })).not.toBe(base);
    expect(hash({ descriptionText: "Requirements:\n- 8+ years of experience\n- Playwright" })).not.toBe(base);
    expect(hash({ commitment: "Contract" })).not.toBe(base);
    expect(hash({ salary: { min: 1, max: 2, currency: "ILS", period: "month", basis: null } })).not.toBe(base);
  });
});

describe("changedFields", () => {
  const fields = (overrides: Partial<RawListing>) => matchingFields(normalizeListing({ ...raw, ...overrides }));

  it("names only what changed", () => {
    expect(changedFields(fields({}), fields({}))).toEqual([]);
    expect(changedFields(fields({}), fields({ location: "Jerusalem" }))).toEqual(["locations"]);
    expect(changedFields(fields({}), fields({ workplaceType: "remote" }))).toEqual(["workArrangement"]);
  });
});

describe("html handling", () => {
  it("decodes named and numeric entities once", () => {
    expect(decodeEntities("A &amp; B &#39;C&#39; &#x5D0;")).toBe("A & B 'C' א");
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeEntities("&unknown;")).toBe("&unknown;");
  });

  it("drops scripts and keeps structure", () => {
    const text = htmlToText("<script>alert(1)</script><style>x{}</style><p>One</p><ul><li>Two</li></ul>");
    expect(text).toBe("One\n\n- Two");
  });

  it("keeps Hebrew text intact", () => {
    expect(htmlToText("<p>דרישות &ndash; ניסיון</p>")).toBe("דרישות – ניסיון");
  });
});

describe("canonicalizeUrl", () => {
  it("removes tracking but keeps identifying parameters", () => {
    expect(canonicalizeUrl("https://Www.Example.test/jobs/1/?utm_source=x&gh_src=y&gh_jid=7#apply")).toBe(
      "https://example.test/jobs/1?gh_jid=7",
    );
  });

  it("orders remaining parameters", () => {
    expect(canonicalizeUrl("https://a.test/?b=2&a=1")).toBe(canonicalizeUrl("https://a.test/?a=1&b=2"));
  });

  it("refuses schemes that would be unsafe as a link", () => {
    expect(() => canonicalizeUrl("javascript:alert(1)")).toThrow(/scheme/i);
  });
});
