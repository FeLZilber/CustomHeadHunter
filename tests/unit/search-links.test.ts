import { describe, expect, it } from "vitest";
import { buildSearchLinks } from "../../src/dashboard/search-links";

const links = (titles: string[]) => buildSearchLinks(titles).flatMap((group) => group.links);
const query = (url: string) => new URL(url).searchParams.get("q") ?? "";

describe("buildSearchLinks", () => {
  it("builds https links with unique labels", () => {
    const all = links(["SDET"]);
    expect(all.every((link) => new URL(link.url).protocol === "https:")).toBe(true);
    expect(new Set(all.map((link) => link.label)).size).toBe(all.length);
  });

  it("searches each site for profile titles and Hebrew terms from the past month", () => {
    const comeet = links(["SDET"]).find((link) => link.label === "Comeet")!;
    const url = new URL(comeet.url);
    expect(url.searchParams.get("tbs")).toBe("qdr:m");
    expect(query(comeet.url)).toContain("site:comeet.com/jobs");
    expect(query(comeet.url)).toContain('"SDET"');
    expect(query(comeet.url)).toContain('"בודק תוכנה"');
    expect(comeet.url).not.toContain("בודק");
  });

  it("limits a direct LinkedIn search to Israel and 30 days", () => {
    const url = new URL(links(["SDET"]).find((link) => link.label === "LinkedIn, direct search")!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({ keywords: "SDET", location: "Israel", f_TPR: "r2592000" });
  });

  it("keeps the location in the query however long the profile gets", () => {
    const titles = Array.from({ length: 30 }, (_, index) => `Title ${index}`);
    const text = query(links(titles).find((link) => link.label === "AllJobs")!.url);
    expect(text.match(/"/g)).toHaveLength(16);
    expect(text).toContain("(Israel OR ישראל)");
  });

  it("cannot let a title break out of its quotes", () => {
    const text = query(links(['QA" OR "x']).find((link) => link.label === "AllJobs")!.url);
    expect(text).toContain('"QA OR x"');
  });
});
