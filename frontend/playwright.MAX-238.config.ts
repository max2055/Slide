import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: ['max238-idempotency-recovery.spec.ts', 'max238-idempotency-real-api.spec.ts'], workers: 1,
  outputDir: './test-results-MAX-238', timeout: 90_000,
  use: { baseURL: 'http://127.0.0.1:51838', trace: 'off', screenshot: 'off' },
  webServer: [
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 51838 --strictPort',
      url: 'http://127.0.0.1:51838', reuseExistingServer: false,
      env: { VITE_API_PROXY_TARGET: 'http://127.0.0.1:51839' } },
    // A real API over a disposable MySQL journal; the trial boundary is a fixture.
    { command: 'bash e2e/max238-real-api.sh', url: 'http://127.0.0.1:51839/__health',
      reuseExistingServer: false, timeout: 180_000 },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
