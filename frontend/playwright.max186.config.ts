import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'max186-real-service.spec.ts', workers: 1, retries: 0, timeout: 120_000,
  outputDir: process.env.MAX186_TEST_OUTPUT_DIR ?? './test-results-max186',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
