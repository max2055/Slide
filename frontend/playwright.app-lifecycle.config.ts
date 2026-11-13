import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'app-lifecycle.spec.ts', workers: 1, timeout: 30_000,
  outputDir: process.env.APP_LIFECYCLE_OUTPUT_DIR ?? './test-results-app-lifecycle',
  reporter: [['list'], ['json', { outputFile: process.env.APP_LIFECYCLE_JSON ?? './test-results-app-lifecycle/results.json' }]],
  use: { baseURL: 'http://127.0.0.1:5278', trace: 'retain-on-failure', locale: 'zh-CN' },
  webServer: { command: `node node_modules/vite/bin/vite.js ${process.env.APP_LIFECYCLE_PRODUCTION ? 'preview' : ''} --host 127.0.0.1 --port 5278 --strictPort`, url: 'http://127.0.0.1:5278', reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
