import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: process.env.FORM_FIELDS_REAL_SERVICE ? 'form-fields.real.spec.ts' : 'form-fields.spec.ts', workers: 1,
  outputDir: './test-results-form-fields', timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5199', trace: 'retain-on-failure' },
  webServer: { command: process.env.FORM_FIELDS_REAL_SERVICE ? 'bash ../scripts/qualification/serve-e2e.sh' : 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5199 --strictPort', url: 'http://127.0.0.1:5199', timeout: 180_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
