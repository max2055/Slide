import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'metric-policy-fields.spec.ts', workers: 1,
  outputDir: './test-results-metric-policy', timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5277', trace: 'retain-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5277 --strictPort', url: 'http://127.0.0.1:5277', reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
