import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'resource-diagnosis.spec.ts',
  outputDir: './test-results-diagnosis', workers: 1, retries: 0, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5198', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5198 --strictPort',
    url: 'http://127.0.0.1:5198', reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
