import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: ['keyboard-controls.spec.ts', 'appearance-settings.spec.ts'], workers: 1,
  outputDir: './test-results-keyboard', timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5203', trace: 'retain-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5203 --strictPort', url: 'http://127.0.0.1:5203' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
