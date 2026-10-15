import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'max166-lists.spec.ts', workers: 1, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5196', trace: 'retain-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5196 --strictPort', url: 'http://127.0.0.1:5196' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
