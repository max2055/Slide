import { defineConfig, devices } from '@playwright/test';

// The spec owns isolated SQL and its HTTP/WS/Vite lifecycle.
export default defineConfig({
  testDir: './e2e', testMatch: 'legacy-routes.spec.ts', workers: 1, retries: 0,
  timeout: 60_000, outputDir: './test-results-legacy',
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
