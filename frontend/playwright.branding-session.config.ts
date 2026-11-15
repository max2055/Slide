import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'branding-session.real.spec.ts', workers: 1,
  timeout: 90_000, retries: 0,
  outputDir: process.env.MAX671_OUTPUT_DIR ? process.env.MAX671_OUTPUT_DIR + '/playwright' : './test-results/max671',
  use: { trace: 'off', actionTimeout: 10_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
