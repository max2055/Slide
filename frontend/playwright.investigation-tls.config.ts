import { defineConfig } from '@playwright/test';

// Each browser profile has its own CA database; no system trust or TLS bypass.
export default defineConfig({
  testDir: './e2e', testMatch: 'investigation-tls.spec.ts', workers: 1,
  timeout: 120_000, retries: 0, outputDir: './test-results-investigation-tls',
  expect: { timeout: 15_000 },
});
