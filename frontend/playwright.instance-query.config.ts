import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: ['instance-query-state.spec.ts', 'detail-observation.spec.ts'], workers: 1, retries: 0,
  timeout: 60_000, outputDir: './test-results-instance-query',
  use: { trace: 'retain-on-failure' }, projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
