import { defineConfig, devices } from '@playwright/test';

// The spec owns its isolated MySQL schema, HTTP/WS server and Vite lifecycle.
export default defineConfig({
  testDir: './e2e', testMatch: ['MAX-242-entry.spec.ts'], workers: 1, retries: 0,
  timeout: 120_000, outputDir: './test-results-max242',
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
