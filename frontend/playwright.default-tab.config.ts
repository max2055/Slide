import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: ['default-tab.spec.ts', 'shell-navigation.spec.ts', 'app-lifecycle.spec.ts'],
  workers: 1, retries: 0, timeout: 30_000,
  outputDir: process.env.DEFAULT_TAB_OUTPUT_DIR ?? './test-results-default-tab',
  reporter: [['list'], ['json', { outputFile: process.env.DEFAULT_TAB_JSON ?? './test-results-default-tab/results.json' }]],
  use: { baseURL: 'http://127.0.0.1:5281', trace: 'retain-on-failure', locale: 'zh-CN' },
  webServer: {
    command: `node node_modules/vite/bin/vite.js ${process.env.DEFAULT_TAB_PRODUCTION ? 'preview' : ''} --host 127.0.0.1 --port 5281 --strictPort`,
    url: 'http://127.0.0.1:5281', reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
