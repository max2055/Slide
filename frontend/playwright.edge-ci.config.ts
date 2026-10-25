import { defineConfig, devices } from '@playwright/test';

// Edge runs only the three critical paths; the full matrix stays on Chromium.
// Login needs the managed qualification origin; the investigation cases own
// their isolated SQL/HTTP/WS/Vite fixture and only need T06_TEST_MYSQL_PORT.
export default defineConfig({
  testDir: './e2e',
  testMatch: ['release-critical-paths.spec.ts', 'investigation-workspace.spec.ts'],
  grep: [
    /qualification login authenticates through REST and enters the application/,
    /create → real tool process → cancel → different Run → versions and refresh/,
    /real WS disconnect hides content, snapshot restores without creating a Run/,
  ],
  workers: 1,
  retries: 0,
  timeout: 120_000,
  outputDir: './test-results-edge-critical',
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge' } }],
});
