import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: ['max238-idempotency-recovery.spec.ts'], workers: 1,
  outputDir: './test-results-MAX-238', timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:51838', trace: 'off', screenshot: 'off' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 51838 --strictPort',
    url: 'http://127.0.0.1:51838', reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
