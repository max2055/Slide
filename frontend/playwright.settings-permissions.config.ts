import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', testMatch: 'settings-permissions.spec.ts', use: { baseURL: 'http://127.0.0.1:5198' }, webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5198 --strictPort', url: 'http://127.0.0.1:5198', reuseExistingServer: false } });
