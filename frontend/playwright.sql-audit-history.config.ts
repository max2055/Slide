import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'sql-audit-history.spec.ts', workers: 1, timeout: 90_000,
  outputDir: './test-results-sql-audit-history', retries: 0,
  use: { trace: 'off' }, // Login credentials/tokens must not enter delivery artifacts.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
