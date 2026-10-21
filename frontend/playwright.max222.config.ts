import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: ['metric-settings.spec.ts', 'metric-reacceptance.spec.ts'],
  workers: 1, timeout: 30000, outputDir: './test-results-max222',
  use: { baseURL: 'http://127.0.0.1:53222', trace: 'retain-on-failure', timezoneId: 'Asia/Shanghai' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 53222 --strictPort',
    url: 'http://127.0.0.1:53222', reuseExistingServer: false,
  },
});
