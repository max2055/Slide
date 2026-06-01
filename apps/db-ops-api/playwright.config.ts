import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120000,
  retries: 1,
  use: { headless: true, baseURL: "http://localhost:5173" },
});
