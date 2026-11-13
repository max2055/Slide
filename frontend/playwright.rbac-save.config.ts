import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'rbac-permission-save-real.spec.ts',
  outputDir: '../outputs/max354-acceptance/browser', workers: 1,
  use: { baseURL: 'http://127.0.0.1:5194', trace: 'retain-on-failure', viewport: { width: 1440, height: 900 } },
});
