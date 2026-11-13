import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'resource-search.spec.ts', workers: 1, timeout: 30000,
  outputDir: process.env.SEARCH_TEST_OUTPUT ?? './test-results-resource-search',
  use: { baseURL: 'http://127.0.0.1:5197', trace: 'retain-on-failure', ...(process.env.SEARCH_BROWSER_CHANNEL ? { channel: process.env.SEARCH_BROWSER_CHANNEL } : {}) },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5197 --strictPort', url: 'http://127.0.0.1:5197', reuseExistingServer: false },
});
