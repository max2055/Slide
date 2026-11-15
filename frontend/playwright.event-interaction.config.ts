import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'event-interaction.spec.ts', workers: 1,
  use: { baseURL: 'http://127.0.0.1:5197', viewport: { width: 1440, height: 900 } },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5197 --strictPort', url: 'http://127.0.0.1:5197', reuseExistingServer: false },
});
