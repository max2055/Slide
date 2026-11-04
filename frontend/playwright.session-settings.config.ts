import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'session-settings.spec.ts', workers: 1,
  outputDir: './test-results-session-settings', timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5273', trace: 'on' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5273 --strictPort', url: 'http://127.0.0.1:5273', reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
