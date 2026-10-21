import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'max213-chart-download.spec.ts', workers: 1,
  timeout: 20000, outputDir: './test-results-max213',
  use: { baseURL: 'http://127.0.0.1:5213', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5213 --strictPort',
    url: 'http://127.0.0.1:5213', reuseExistingServer: false,
  },
});
