import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'settings-permissions-max672-real.spec.ts',
  workers: 1,
  timeout: 90_000,
  outputDir: process.env.MAX672_EVIDENCE_DIR || './test-results-max672-real',
  use: { baseURL: 'http://127.0.0.1:5672', trace: 'off', screenshot: 'off' },
});
