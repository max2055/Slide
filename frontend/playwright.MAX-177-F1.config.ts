import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'MAX-177-unknown.spec.ts', workers: 1,
  outputDir: './test-results-MAX-177-F1', timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:51977', trace: 'off', ...devices['Desktop Chrome'] },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 51977 --strictPort',
    url: 'http://127.0.0.1:51977', timeout: 30_000,
  },
});
