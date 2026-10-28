import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiPort = Number(process.env.MAX238_API_PORT ?? 51839);
// The launcher writes this handle before creating its container; the spec reads
// the same path for teardown. Same value on both sides, independent of cwd.
const handleFile = process.env.MAX238_HANDLE_FILE ?? path.join(here, 'e2e', `.max238-handle-${apiPort}.json`);

export default defineConfig({
  testDir: './e2e', testMatch: ['max238-idempotency-recovery.spec.ts', 'max238-idempotency-real-api.spec.ts'], workers: 1,
  outputDir: './test-results-MAX-238', timeout: 90_000,
  use: { baseURL: 'http://127.0.0.1:51838', trace: 'off', screenshot: 'off' },
  webServer: [
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 51838 --strictPort',
      url: 'http://127.0.0.1:51838', reuseExistingServer: false,
      env: { VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` } },
    // A real API over a disposable MySQL journal; the trial boundary is a fixture.
    { command: 'bash e2e/max238-real-api.sh', url: `http://127.0.0.1:${apiPort}/__health`,
      reuseExistingServer: false, timeout: 180_000,
      env: { MAX238_API_PORT: String(apiPort), MAX238_HANDLE_FILE: handleFile } },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
