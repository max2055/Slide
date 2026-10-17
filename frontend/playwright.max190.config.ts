import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: ['max190-collection.spec.ts', 'max190-r1.spec.ts'], workers: 2, retries: 0, timeout: 30000,
  outputDir: './test-results-max190',
  use: { baseURL: 'http://127.0.0.1:5194', trace: 'retain-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5194 --strictPort',
    url: 'http://127.0.0.1:5194', reuseExistingServer: false },
});
