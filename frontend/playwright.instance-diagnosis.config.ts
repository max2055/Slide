import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'instance-diagnosis-styles.spec.ts',
  outputDir: process.env.MAX650_BROWSER_OUTPUT || './test-results-instance-diagnosis',
  workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:5207', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5207 --strictPort',
    url: 'http://127.0.0.1:5207', reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
