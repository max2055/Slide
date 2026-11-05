import { defineConfig } from "@playwright/test";
import { webBaseURL } from "./e2e/targets";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120000,
  retries: 1,
  use: { headless: true, baseURL: webBaseURL() },
});
