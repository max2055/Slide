import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'agent-extension-manager.spec.ts', workers: 1,
  timeout: 30_000, outputDir: './test-results-extensions',
  use: { baseURL: 'http://127.0.0.1:5198', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5198 --strictPort', url: 'http://127.0.0.1:5198', reuseExistingServer: false },
    { command: 'node ../apps/db-ops-api/node_modules/tsx/dist/cli.mjs ../apps/db-ops-api/tests/fixtures/extension-acceptance-server.ts', url: 'http://127.0.0.1:3198/fixture/rows', reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 } },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
