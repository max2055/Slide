import { defineConfig, devices } from '@playwright/test';
export default defineConfig({ testDir: './e2e', testMatch: 'max174-workspace.spec.ts', workers: 1, retries: 0, timeout: 120_000,
  outputDir: './test-results-max174', use: { trace: 'retain-on-failure' }, projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }] });
