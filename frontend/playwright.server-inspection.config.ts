import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'server-inspection.spec.ts', workers: 1, retries: 0,
  timeout: 30_000,
  outputDir: process.env.SERVER_INSPECTION_OUTPUT_DIR ?? './test-results-server-inspection',
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
