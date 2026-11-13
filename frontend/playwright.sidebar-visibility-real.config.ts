import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'sidebar-visibility-real.spec.ts', workers: 1, timeout: 60_000,
  outputDir: process.env.SIDEBAR_REAL_EVIDENCE_DIR || './test-results-sidebar-visibility-real',
  use: { baseURL: 'http://127.0.0.1:5277', trace: 'off' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5277 --strictPort',
    url: 'http://127.0.0.1:5277', reuseExistingServer: false,
    env: { VITE_API_PROXY_TARGET: 'http://127.0.0.1:3276', VITE_AGENT_WS_PROXY_TARGET: 'http://127.0.0.1:29776' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
