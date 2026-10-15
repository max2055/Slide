import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: process.env.NOTIFICATION_REAL_SERVICE_E2E === '1'
    ? 'notification-recovery.real.spec.ts' : 'notification-recovery.spec.ts',
  outputDir: './test-results/notification-recovery', workers: 1, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5192', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5192 --strictPort',
    url: 'http://127.0.0.1:5192', reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
