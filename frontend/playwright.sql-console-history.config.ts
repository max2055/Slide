import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'sql-console-history.spec.ts', workers: 1, retries: 0,
  outputDir: './test-results-sql-console-history',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
