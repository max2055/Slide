import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'alert-levels.spec.ts', workers: 1, timeout: 120_000,
  outputDir: './test-results/alert-levels', use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
