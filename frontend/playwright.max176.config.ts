import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'max176-agent-lists.spec.ts', workers: 1, timeout: 45_000,
  outputDir: './test-results-max176',
  use: { baseURL: 'http://127.0.0.1:5276', trace: 'off' },
  webServer: { command: 'pnpm exec vite --host 127.0.0.1 --port 5276 --strictPort', url: 'http://127.0.0.1:5276', reuseExistingServer: false, env: { VITE_API_PROXY_TARGET: 'http://127.0.0.1:3176', VITE_AGENT_WS_PROXY_TARGET: 'http://127.0.0.1:29776' } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
