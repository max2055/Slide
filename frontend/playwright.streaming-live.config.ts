import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'streaming-live.spec.ts', workers: 1, timeout: 180_000,
  outputDir: './test-results-streaming-live',
  use: { baseURL: 'http://127.0.0.1:5199', trace: 'on' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --config vite.streaming.config.ts --host 127.0.0.1 --port 5199 --strictPort',
    url: 'http://127.0.0.1:5199', reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
