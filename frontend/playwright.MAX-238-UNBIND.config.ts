import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const apiPort = Number(process.env.MAX238_API_PORT ?? 51869);
const handle = path.join(here, 'e2e', `.max238-unbind-handle-${apiPort}.json`);
export default defineConfig({
  testDir: './e2e', testMatch: ['max238-unbind-preview.spec.ts'], workers: 1, timeout: 120_000,
  outputDir: './test-results-MAX-238-UNBIND',
  use: { baseURL: 'http://127.0.0.1:51868', trace: 'off', screenshot: 'off' },
  webServer: [
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 51868 --strictPort',
      url: 'http://127.0.0.1:51868', reuseExistingServer: false, env: { VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` } },
    { command: 'bash e2e/max238-unbind-preview.sh', url: `http://127.0.0.1:${apiPort}/__health`, reuseExistingServer: false,
      timeout: 240_000, env: { MAX238_API_PORT: String(apiPort), MAX238_HANDLE_FILE: handle } },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
