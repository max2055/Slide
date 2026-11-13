import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'platform-status-real.spec.ts', workers: 1, timeout: 60_000,
  outputDir: process.env.PLATFORM_STATUS_EVIDENCE_DIR || './test-results-platform-status-real',
  use: { baseURL: 'http://127.0.0.1:5272', trace: 'off' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5272 --strictPort',
    url: 'http://127.0.0.1:5272', reuseExistingServer: false,
    env: { VITE_API_PROXY_TARGET: 'http://127.0.0.1:3272', VITE_AGENT_WS_PROXY_TARGET: 'http://127.0.0.1:29772' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
