import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: ['streaming-render.spec.ts', 'message-parts.spec.ts', 'tool-stream.spec.ts'],
  outputDir: './test-results-streaming', timeout: 180_000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:5198', trace: 'on' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --config vite.streaming.config.ts --host 127.0.0.1 --port 5198 --strictPort',
    url: 'http://127.0.0.1:5198', reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
