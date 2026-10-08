import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: ['chat-notices.spec.ts'], outputDir: './test-results-notices',
  timeout: 30_000, workers: 2,
  use: { baseURL: 'http://127.0.0.1:5197', trace: 'retain-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5197 --strictPort',
    url: 'http://127.0.0.1:5197', reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
