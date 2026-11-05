import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'network-device-private-key.spec.ts',
  outputDir: './test-results-network-private-key',
  reporter: [['list'], ['json', { outputFile: './test-results-network-private-key/results.json' }]],
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5192', trace: 'off' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5192 --strictPort',
    url: 'http://127.0.0.1:5192',
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
