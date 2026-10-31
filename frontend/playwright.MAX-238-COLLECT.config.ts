import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiPort = Number(process.env.MAX238_API_PORT ?? 51849);
const handleFile = process.env.MAX238_HANDLE_FILE ?? path.join(here, 'e2e', `.max238-cn-handle-${apiPort}.json`);

export default defineConfig({
  testDir: './e2e', testMatch: ['max238-collect-now.spec.ts'], workers: 1,
  outputDir: './test-results-MAX-238-COLLECT', timeout: 120_000,
  use: { baseURL: 'http://127.0.0.1:51848', trace: 'off', screenshot: 'off' },
  webServer: [
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 51848 --strictPort',
      url: 'http://127.0.0.1:51848', reuseExistingServer: false,
      env: { VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` } },
    { command: 'bash e2e/max238-collect-now.sh', url: `http://127.0.0.1:${apiPort}/__health`,
      reuseExistingServer: false, timeout: 240_000,
      env: { MAX238_API_PORT: String(apiPort), MAX238_HANDLE_FILE: handleFile } },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
