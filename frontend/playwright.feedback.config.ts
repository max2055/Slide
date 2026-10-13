import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'investigation-feedback.spec.ts', workers: 1, retries: 0,
  timeout: 120_000, outputDir: './test-results-feedback',
  use: { trace: 'retain-on-failure' }, projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
