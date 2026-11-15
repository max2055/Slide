import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-real', testMatch: 'server-inspection.spec.ts', workers: 1, retries: 0,
  timeout: 30_000,
  outputDir: process.env.SERVER_INSPECTION_REAL_OUTPUT_DIR ?? './test-results-server-inspection-real',
  use: { trace: 'off' }, // Real login tokens must not enter traces.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
