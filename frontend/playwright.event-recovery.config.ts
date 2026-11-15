import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir:'./e2e', testMatch:['event-recovery.real.spec.ts', 'event-interaction.real.spec.ts'], workers:1, timeout:30000,
 use:{baseURL:'http://127.0.0.1:5572',viewport:{width:1440,height:900}},
 webServer:{command:'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5572 --strictPort',cwd:new URL('.',import.meta.url).pathname,url:'http://127.0.0.1:5572',reuseExistingServer:false},
});
