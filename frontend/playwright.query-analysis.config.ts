import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'query-analysis.spec.ts', workers: 1, retries: 0,
  timeout: 60_000, outputDir: './test-results-query-analysis',
  use: { trace: 'off' }, // JWT and database samples must not enter traces.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
