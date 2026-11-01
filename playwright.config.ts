import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./tests/e2e/constants";

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: { baseURL: BASE_URL, ...devices["Desktop Chrome"] },
  webServer: {
    command: "npx tsx tests/e2e/server.ts",
    url: `${BASE_URL}/denied`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
