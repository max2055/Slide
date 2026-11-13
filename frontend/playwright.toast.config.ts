import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'toast-lifecycle.spec.ts',
  outputDir: process.env.TOAST_EVIDENCE_DIR || './test-results-toast',
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5266', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5266 --strictPort',
    url: 'http://127.0.0.1:5266',
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
