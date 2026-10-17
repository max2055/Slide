import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "max191-bulk.controlled.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 30000,
  outputDir: process.env.MAX191_OUTPUT_DIR ?? "./test-results-max191-ui",
  use: { baseURL: "http://127.0.0.1:5198", trace: "retain-on-failure" },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5198 --strictPort",
    url: "http://127.0.0.1:5198",
    reuseExistingServer: false,
  },
});
