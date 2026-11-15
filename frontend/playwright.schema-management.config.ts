import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.MAX555_BROWSER_PORT || 5555);
export default defineConfig({
  testDir: './e2e', testMatch: 'schema-management.spec.ts', workers: 1, retries: 0,
  outputDir: process.env.MAX555_BROWSER_OUTPUT || './test-results-schema-management',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
