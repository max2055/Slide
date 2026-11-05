import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'MAX319-list-connection.real.spec.ts', workers: 1,
  outputDir: './test-results-MAX319', timeout: 90_000,
  use: { baseURL: process.env.MAX319_BASE_URL, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
