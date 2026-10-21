import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'mobile-navigation.spec.ts', workers: 1,
  timeout: 30000, outputDir: './test-results-max219',
  use: {
    baseURL: 'http://127.0.0.1:5219',
    storageState: process.env.MAX219_STORAGE_STATE,
    trace: 'retain-on-failure',
  },
  webServer: process.env.T06_TEST_MYSQL_PORT ? undefined : {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5219 --strictPort',
    url: 'http://127.0.0.1:5219', reuseExistingServer: false,
  },
});
