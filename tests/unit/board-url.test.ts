import { describe, expect, it } from "vitest";
import { careerUrl, nameFromKey, parseBoardUrl } from "../../src/ingest/board-url";

describe("parseBoardUrl", () => {
  it("reads the board from a job or careers link on each supported ATS", () => {
    expect(parseBoardUrl("https://boards.greenhouse.io/acme/jobs/123?gh_src=x")).toEqual({ provider: "greenhouse", providerKey: "acme" });
    expect(parseBoardUrl("https://job-boards.greenhouse.io/acme-labs")).toEqual({ provider: "greenhouse", providerKey: "acme-labs" });
    expect(parseBoardUrl("https://jobs.lever.co/acme/1b2c-3d")).toEqual({ provider: "lever", providerKey: "acme" });
    expect(parseBoardUrl(" https://jobs.ashbyhq.com/acme/abc/application ")).toEqual({ provider: "ashby", providerKey: "acme" });
    expect(parseBoardUrl("https://apply.workable.com/acme/j/ABC123/")).toEqual({ provider: "workable", providerKey: "acme" });
    expect(parseBoardUrl("https://acme.workable.com/jobs/123")).toEqual({ provider: "workable", providerKey: "acme" });
    expect(parseBoardUrl("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Israel/QA_JR1")).toEqual({
      provider: "workday",
      providerKey: "https://acme.wd5.myworkdayjobs.com/Careers",
    });
  });

  it("refuses everything else, including look-alike hosts and scraped sites", () => {
    for (const url of [
      "https://www.linkedin.com/jobs/view/123",
      "https://boards.greenhouse.io.evil.com/acme",
      "https://evil.com/boards.greenhouse.io/acme",
      "https://boards.greenhouse.io/",
      "https://jobs.lever.co/%zz/job",
      "ftp://jobs.lever.co/acme",
      "javascript:alert(1)",
      "https://www.workable.com/pricing",
      "https://workable.com.evil.com/acme",
      "https://acme.wd5.myworkdayjobs.com/",
      "https://acme.wd5.myworkdayjobs.com.evil.com/Careers",
      "not a url",
      "",
    ]) {
      expect(parseBoardUrl(url), url).toBeNull();
    }
  });

  it("builds the careers page and a readable name", () => {
    expect(careerUrl({ provider: "lever", providerKey: "acme" })).toBe("https://jobs.lever.co/acme");
    expect(careerUrl({ provider: "workable", providerKey: "acme" })).toBe("https://apply.workable.com/acme/");
    expect(careerUrl({ provider: "workday", providerKey: "https://acme.wd5.myworkdayjobs.com/Careers" })).toBe("https://acme.wd5.myworkdayjobs.com/Careers");
    expect(nameFromKey("https://acme-labs.wd5.myworkdayjobs.com/Careers")).toBe("Acme Labs");
    expect(nameFromKey("acme-labs_il")).toBe("Acme Labs Il");
  });
});
