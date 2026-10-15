import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "MAX-180-platform.spec.ts",
  workers: 1,
  timeout: 90_000,
  outputDir: "./test-results-MAX-180",
  use: { baseURL: "http://127.0.0.1:51947", trace: "off" },
  webServer: {
    command: "bash ../scripts/qualification/serve-MAX-180.sh",
    url: "http://127.0.0.1:51947",
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
