import { defineConfig, devices } from '@playwright/test';

// The spec owns its isolated SQL schema, HTTP/WS servers and Vite lifecycle.
// Do not start the general qualification server or use an existing platform DB.
export default defineConfig({
  testDir: './e2e', testMatch: ['investigation-workspace.spec.ts', 'investigation-governance.spec.ts', 'investigation-bridges.spec.ts', 'investigation-system.spec.ts', 'investigation-resource-links.spec.ts', 'investigation-recovery.spec.ts', 'investigation-feedback.spec.ts', 'investigation-feedback-workspace.spec.ts'], workers: 1,
  timeout: 120_000, retries: 0, outputDir: './test-results-investigation',
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
