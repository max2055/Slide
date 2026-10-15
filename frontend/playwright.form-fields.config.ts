import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'form-fields.spec.ts', workers: 1,
  outputDir: './test-results-form-fields', timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5199', trace: 'retain-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5199 --strictPort', url: 'http://127.0.0.1:5199' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
