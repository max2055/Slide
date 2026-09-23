import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.SLIDE_EDGE_BASE_URL;
if (!baseURL?.startsWith('https://')) {
  throw new Error('SLIDE_EDGE_BASE_URL must be the trusted production-equivalent HTTPS origin');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: 'chat-recovery.edge.spec.ts',
  timeout: 15 * 60_000,
  workers: 1,
  retries: 0,
  use: {
    ...devices['Desktop Edge'],
    channel: 'msedge',
    baseURL,
    ignoreHTTPSErrors: false,
    trace: 'retain-on-failure',
  },
});
