import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'schema-collect.MAX401.spec.ts', workers: 1,
  timeout: 30_000,
  outputDir: process.env.MAX401_EVIDENCE_DIR ?? './test-results-MAX401',
  use: { baseURL: 'http://127.0.0.1:5401', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5401 --strictPort',
    url: 'http://127.0.0.1:5401', reuseExistingServer: false,
  },
  projects: [{ name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } }],
});
