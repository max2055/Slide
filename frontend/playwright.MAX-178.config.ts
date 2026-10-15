import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'MAX-178-models.spec.ts', workers: 1,
  outputDir: './test-results-MAX-178', timeout: 90_000,
  use: { baseURL: 'http://127.0.0.1:51887', trace: 'off', screenshot: 'off' },
  webServer: { command: 'bash ../scripts/qualification/serve-e2e.sh', url: 'http://127.0.0.1:51887', timeout: 180_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
