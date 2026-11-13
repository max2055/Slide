import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'common-controls.spec.ts', workers: 1,
  outputDir: './test-results-common-controls', timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5265', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5265 --strictPort',
    url: 'http://127.0.0.1:5265', reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
