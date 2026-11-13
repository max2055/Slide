import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'platform-status.spec.ts',
  outputDir: process.env.PLATFORM_STATUS_EVIDENCE_DIR || './test-results-platform-status',
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5271', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5271 --strictPort',
    url: 'http://127.0.0.1:5271',
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
