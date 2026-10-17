import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', testMatch: 'max190-authenticated-collection.spec.ts', workers: 1, retries: 0, timeout: 240000,
  outputDir: process.env.MAX190_OUTPUT_DIR ? `${process.env.MAX190_OUTPUT_DIR}/playwright` : './test-results-max190-auth',
  use: { trace: 'off', screenshot: 'off' },
});
