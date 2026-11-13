import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'ai-settings.spec.ts',
  outputDir: './test-results-ai-settings', workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:5197', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5197 --strictPort',
    url: 'http://127.0.0.1:5197', reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
