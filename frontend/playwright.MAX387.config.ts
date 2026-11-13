import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: ['instances-delete.MAX387.spec.ts', 'resource-search.spec.ts'],
  grep: /MAX387|MAX388|instance/,
  workers: 1, timeout: 30_000,
  outputDir: process.env.MAX387_EVIDENCE_DIR ?? './test-results-MAX387',
  use: { baseURL: 'http://127.0.0.1:5387', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5387 --strictPort',
    url: 'http://127.0.0.1:5387', reuseExistingServer: false,
  },
  projects: [{ name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } }],
});
