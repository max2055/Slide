import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testMatch: ['audit-dialog.spec.ts', 'dashboard-overview.spec.ts'],
  outputDir: './test-results-audit',
  timeout: 30_000,
  workers: 2,
  use: { baseURL: 'http://127.0.0.1:5186', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5186 --strictPort',
    url: 'http://127.0.0.1:5186',
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
