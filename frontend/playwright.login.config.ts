import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'login-gate.spec.ts', workers: 1, timeout: 90_000,
  outputDir: './test-results-login', retries: 0,
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
