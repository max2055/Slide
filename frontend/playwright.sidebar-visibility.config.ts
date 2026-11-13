import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'sidebar-visibility.spec.ts', workers: 1, retries: 0,
  outputDir: process.env.SIDEBAR_EVIDENCE_DIR ?? './test-results-sidebar-visibility',
  use: { baseURL: 'http://127.0.0.1:5276', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5276 --strictPort',
    url: 'http://127.0.0.1:5276', reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
