import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'sql-audit-text.spec.ts', workers: 1, retries: 0,
  outputDir: './test-results-sql-audit-text',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
