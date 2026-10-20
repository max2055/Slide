import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'max190-real-collection.spec.ts', workers: 1, retries: 0, timeout: 180000,
  use: { trace: 'off', actionTimeout: 15000, screenshot: 'only-on-failure' }, outputDir: process.env.MAX190_OUTPUT_DIR ? `${process.env.MAX190_OUTPUT_DIR}/playwright` : './test-results-max190-live',
});
