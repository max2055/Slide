import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  webServer: process.env.PLAYWRIGHT_MANAGED_ENV === '1' ? {
    command: 'bash ../scripts/qualification/serve-e2e.sh',
    url: 'http://127.0.0.1:5175',
    // Managed startup applies the complete migration ledger before starting both servers.
    timeout: 180_000,
    reuseExistingServer: false,
  } : undefined,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? (process.env.PLAYWRIGHT_MANAGED_ENV === '1' ? 'http://127.0.0.1:5175' : 'http://127.0.0.1:5173'),
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
