import { defineConfig } from '@playwright/test';
import audit from './playwright.audit.config';

export default defineConfig(audit, {
  testMatch: ['audit-request-race.spec.ts'],
  outputDir: './test-results-max429',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5429' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5429 --strictPort',
    url: 'http://127.0.0.1:5429',
    reuseExistingServer: false,
  },
});
