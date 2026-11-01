import { describe, expect, it } from "vitest";
import {
  detectEmploymentType,
  detectSeniority,
  detectWorkArrangement,
  extractExperience,
  extractTechnologies,
} from "../../src/normalize/extract";

const names = (text: string) => extractTechnologies(text).map((tech) => tech.name);
const level = (text: string, name: string) => extractTechnologies(text).find((tech) => tech.name === name)?.level;

describe("technology extraction", () => {
  it("does not treat JavaScript as Java", () => {
    expect(names("Strong JavaScript skills")).toEqual(["JavaScript"]);
    expect(names("Java Script experience")).toEqual(["JavaScript"]);
    expect(names("Node.js and TypeScript")).toEqual(["Node.js", "TypeScript"]);
  });

  it("finds Java on its own", () => {
    expect(names("Backend in Java and Spring")).toEqual(["Java"]);
  });

  it("does not read the word go as Golang", () => {
    expect(names("We go fast and go far")).toEqual([]);
    expect(names("Services in Golang")).toEqual(["Go"]);
  });

  it("recognizes mentions in Hebrew text", () => {
    expect(names("ניסיון עם Playwright וכתיבה ב-TypeScript")).toEqual(["Playwright", "TypeScript"]);
    expect(names("ניסיון בבדיקות API")).toEqual(["REST API"]);
  });

  it("preserves negation", () => {
    expect(names("This role does not involve Java")).toEqual([]);
    expect(names("No Selenium needed")).toEqual([]);
    expect(names("התפקיד ללא Selenium")).toEqual([]);
  });

  it("keeps a real mention that shares a line with a negation far away", () => {
    expect(names("Not a management role. We use Playwright")).toEqual(["Playwright"]);
  });

  it("separates required from preferred by section", () => {
    const text = "Requirements:\n- Playwright\n\nNice to have:\n- k6\n\nAbout us\nWe use Docker";
    expect(level(text, "Playwright")).toBe("required");
    expect(level(text, "k6")).toBe("preferred");
    expect(level(text, "Docker")).toBe("unspecified");
  });

  it("separates sections in Hebrew", () => {
    const text = "דרישות:\n- Playwright\n\nיתרון:\n- k6";
    expect(level(text, "Playwright")).toBe("required");
    expect(level(text, "k6")).toBe("preferred");
  });

  it("lets an inline marker override its section", () => {
    expect(level("Requirements:\n- Cypress - an advantage", "Cypress")).toBe("preferred");
    expect(level("ניסיון ב-Playwright - חובה", "Playwright")).toBe("required");
  });

  it("keeps the strongest level for a repeated technology", () => {
    expect(level("About the team\nWe use Cypress\n\nRequirements:\n- Cypress", "Cypress")).toBe("required");
  });

  it("stores evidence from the posting", () => {
    expect(extractTechnologies("Requirements:\n- Playwright daily")[0]?.evidence).toBe("Playwright daily");
  });
});

describe("experience extraction", () => {
  it.each([
    ["5+ years of experience in QA", 5],
    ["3-5 years experience", 3],
    ["At least 4 years of relevant experience", 4],
    ["ניסיון של 5 שנים לפחות", 5],
    ["שנתיים ניסיון בבדיקות", 2],
  ])("reads %s", (text, minYears) => {
    expect(extractExperience(text)?.minYears).toBe(minYears);
  });

  it("leaves unstated experience null", () => {
    expect(extractExperience("You love testing.")).toBeNull();
    expect(extractExperience("Founded 12 years ago")).toBeNull();
  });

  it("prefers a required statement to a preferred one", () => {
    const text = "Requirements:\n- 3+ years of experience\n\nNice to have:\n- 7 years of experience in fintech";
    expect(extractExperience(text)).toMatchObject({ minYears: 3, level: "required" });
  });
});

describe("title and arrangement detection", () => {
  it.each([
    ["Senior QA Automation Engineer", "senior"],
    ["Sr. SDET", "senior"],
    ["Junior QA", "junior"],
    ["QA Team Lead", "lead"],
    ["Principal Engineer", "principal"],
    ["QA Manager", "manager"],
    ["מהנדס/ת בדיקות בכיר/ה", "senior"],
    ["QA Engineer", null],
  ])("classifies %s", (title, expected) => {
    expect(detectSeniority(title)).toBe(expected);
  });

  it("uses provider work arrangement before text", () => {
    expect(detectWorkArrangement("on-site", "Hybrid team")).toBe("onsite");
    expect(detectWorkArrangement(null, "עבודה היברידית")).toBe("hybrid");
    expect(detectWorkArrangement(null, "Join us")).toBeNull();
    expect(detectWorkArrangement("unspecified", "Join us")).toBeNull();
  });

  it("does not mistake QA vocabulary for employment terms", () => {
    expect(detectEmploymentType(null, "QA Engineer", "Own contract testing and mentor an intern")).toBeNull();
    expect(detectEmploymentType(null, "QA Engineer", "Review smart contract audits")).toBeNull();
  });

  it("reads explicit employment terms", () => {
    expect(detectEmploymentType("Full-time", "QA", "")).toBe("full_time");
    expect(detectEmploymentType(null, "QA Intern", "")).toBe("internship");
    expect(detectEmploymentType(null, "QA", "This is a contract position")).toBe("contract");
    expect(detectEmploymentType(null, "QA", "משרה חלקית")).toBe("part_time");
  });
});
