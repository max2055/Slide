import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'users-edit-create-max676-real.spec.ts',
  workers: 1,
  timeout: 90_000,
  outputDir: process.env.MAX676_EVIDENCE_DIR || './test-results-max676-real',
  use: { baseURL: 'http://127.0.0.1:5676', trace: 'off', screenshot: 'off' },
});
