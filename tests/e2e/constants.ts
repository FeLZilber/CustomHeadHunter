export const PORT = 3100;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const NEXTAUTH_SECRET = "e2e-only-secret-not-used-anywhere-else";
export const OWNER_ID = "1001";
export const STRANGER_ID = "2002";

export const TITLES = {
  hostile: "Senior QA Automation Engineer <b>Payments</b>",
  hebrew: "בודק/ת תוכנה אוטומציה",
  low: "QA Automation Engineer Billing",
  pending: "QA Automation Engineer Waiting",
  failed: "QA Automation Engineer Unparseable",
  filtered: "Office Manager",
  adjacent: "DevOps Engineer Pipelines",
} as const;

export const HOSTILE_DESCRIPTION = [
  "Test automation with Playwright.",
  `<script>window.__pwned = true</script>`,
  `<img src="x" onerror="window.__pwned = true">`,
].join("\n");
