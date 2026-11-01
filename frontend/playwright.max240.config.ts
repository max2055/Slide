import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', testMatch: ['MAX-240-history.spec.ts'], workers: 1, timeout: 180_000,
  expect: { timeout: 15_000 }, outputDir: './test-results-max240',
  use: { baseURL: 'http://127.0.0.1:5194', viewport: { width: 1440, height: 900 }, locale: 'zh-CN', trace: 'retain-on-failure' } });
