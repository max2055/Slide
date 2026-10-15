import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'max166-business.spec.ts', workers: 1, outputDir: './test-results-max166-business', timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:5197', trace: 'retain-on-failure' },
  webServer: { command: 'bash ../scripts/qualification/serve-e2e.sh', url: 'http://127.0.0.1:5197', timeout: 180_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
