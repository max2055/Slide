import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'keyboard-controls.real.spec.ts', workers: 1,
  outputDir: './test-results-keyboard-real', timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5204', trace: 'retain-on-failure' },
  webServer: { command: 'bash ../scripts/qualification/serve-e2e.sh', url: 'http://127.0.0.1:5204', timeout: 180_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
