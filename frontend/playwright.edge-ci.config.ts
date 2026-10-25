import { defineConfig, devices } from '@playwright/test';

// Edge runs only the three critical paths; the full matrix stays on Chromium.
// Login needs the managed qualification origin (same contract as the default
// config); the investigation cases own their isolated SQL/HTTP/WS/Vite fixture
// and only need T06_TEST_MYSQL_PORT.
const managed = process.env.PLAYWRIGHT_MANAGED_ENV === '1';
const baseURL = process.env.PLAYWRIGHT_BASE_URL
  ?? (managed ? `http://127.0.0.1:${process.env.QUALIFICATION_FRONTEND_PORT ?? '5175'}` : 'http://127.0.0.1:5173');

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
  webServer: managed ? {
    command: 'bash ../scripts/qualification/serve-e2e.sh',
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: false,
  } : undefined,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge' } }],
});
