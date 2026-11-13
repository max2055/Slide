import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'i18n-startup.spec.ts',
  outputDir: './test-results-i18n',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5197',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 5197 --strictPort',
    url: 'http://127.0.0.1:5197',
    reuseExistingServer: false,
  },
});
