import { describe, expect, it } from "vitest";
import { ALLOW_ALL, DISALLOW_ALL, parseRobots } from "../../src/http/robots";

const TOKEN = "headhunter-personal-job-search";

describe("parseRobots group selection", () => {
  const text = [
    "User-agent: *",
    "Disallow: /private",
    "",
    "User-agent: HeadHunter-Personal-Job-Search",
    "Disallow: /secret",
  ].join("\n");

  it("prefers the group naming the product token, case-insensitively", () => {
    const rules = parseRobots(text, TOKEN);
    expect(rules.allows("/secret/a")).toBe(false);
    expect(rules.allows("/private/a")).toBe(true);
  });

  it("falls back to the * group", () => {
    const rules = parseRobots(text, "other-bot");
    expect(rules.allows("/private/a")).toBe(false);
    expect(rules.allows("/secret/a")).toBe(true);
  });

  it("merges multiple groups that match the token", () => {
    const rules = parseRobots("User-agent: hh\nDisallow: /a\n\nUser-agent: hh\nDisallow: /b", "hh");
    expect(rules.allows("/a")).toBe(false);
    expect(rules.allows("/b")).toBe(false);
    expect(rules.allows("/c")).toBe(true);
  });

  it("shares one group between consecutive user-agent lines", () => {
    const rules = parseRobots("User-agent: a\nUser-agent: b\nDisallow: /x", "b");
    expect(rules.allows("/x")).toBe(false);
  });

  it("allows everything when no group applies", () => {
    expect(parseRobots("User-agent: other\nDisallow: /", TOKEN).allows("/anything")).toBe(true);
  });
});

describe("parseRobots matching", () => {
  it("lets the longest matching rule win", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /jobs\nAllow: /jobs/public", TOKEN);
    expect(rules.allows("/jobs/private")).toBe(false);
    expect(rules.allows("/jobs/public/1")).toBe(true);
  });

  it("lets Allow win a tie", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /page\nAllow: /page", TOKEN);
    expect(rules.allows("/page")).toBe(true);
  });

  it("supports * wildcards", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*/draft", TOKEN);
    expect(rules.allows("/a/b/draft")).toBe(false);
    expect(rules.allows("/a/final")).toBe(true);
  });

  it("anchors a trailing $", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*.json$", TOKEN);
    expect(rules.allows("/list.json")).toBe(false);
    expect(rules.allows("/list.json?x=1")).toBe(true);
    expect(rules.allows("/list.jsonl")).toBe(true);
  });

  it("treats an empty Disallow as allowing everything", () => {
    expect(parseRobots("User-agent: *\nDisallow:", TOKEN).allows("/x")).toBe(true);
  });

  it("matches the query string as part of the path", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*?secret=", TOKEN);
    expect(rules.allows("/a?secret=1")).toBe(false);
  });

  it("always allows /robots.txt", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /", TOKEN);
    expect(rules.allows("/robots.txt")).toBe(true);
    expect(rules.allows("/other")).toBe(false);
  });
});

describe("parseRobots extras", () => {
  it("reads Crawl-delay from the selected group only", () => {
    const text = "User-agent: *\nCrawl-delay: 4\n\nUser-agent: hh\nCrawl-delay: 2.5";
    expect(parseRobots(text, "hh").crawlDelaySeconds).toBe(2.5);
    expect(parseRobots(text, "zz").crawlDelaySeconds).toBe(4);
    expect(parseRobots("User-agent: *\nDisallow: /x", "hh").crawlDelaySeconds).toBeNull();
  });

  it("ignores unknown lines, comments and a BOM", () => {
    const text = "﻿Sitemap: https://x.test/s.xml\nUser-agent: * # everyone\nContent-Signal: ai-train=no\nDisallow: /x # why\n";
    const rules = parseRobots(text, TOKEN);
    expect(rules.allows("/x")).toBe(false);
    expect(rules.allows("/y")).toBe(true);
  });

  it("survives garbage", () => {
    expect(parseRobots("<html>not robots</html>\n\u0000\u0001:::\nDisallow: /x", TOKEN).allows("/x")).toBe(true);
    expect(parseRobots("", TOKEN).allows("/x")).toBe(true);
    expect(parseRobots("User-agent: *\nCrawl-delay: abc", TOKEN).crawlDelaySeconds).toBeNull();
  });

  it("exposes the allow-all and disallow-all constants", () => {
    expect(ALLOW_ALL.allows("/x")).toBe(true);
    expect(DISALLOW_ALL.allows("/x")).toBe(false);
    expect(DISALLOW_ALL.allows("/robots.txt")).toBe(true);
  });
});
