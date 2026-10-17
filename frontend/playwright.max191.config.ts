import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "max191-bulk.real.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 300000,
  outputDir: process.env.MAX191_OUTPUT_DIR
    ? `${process.env.MAX191_OUTPUT_DIR}/playwright`
    : "./test-results-max191",
  use: { trace: "off", screenshot: "off" },
});
