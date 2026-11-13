import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: ['servers-delete.MAX391.spec.ts', 'resource-search.spec.ts'],
  grep: /MAX391|server/,
  workers: 1, timeout: 30_000,
  outputDir: process.env.MAX391_EVIDENCE_DIR ?? './test-results-MAX391',
  use: { baseURL: 'http://127.0.0.1:5391', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5391 --strictPort',
    url: 'http://127.0.0.1:5391', reuseExistingServer: false,
  },
  projects: [{ name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } }],
});
