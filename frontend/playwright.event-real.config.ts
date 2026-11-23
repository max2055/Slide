import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir:'./e2e', testMatch:['event-interaction.real.spec.ts', 'event-center.real.spec.ts'], workers:1, timeout:60000,
 use:{baseURL:'http://127.0.0.1:5584',viewport:{width:1440,height:900},channel:process.env.MAX722_REAL_BROWSER_CHANNEL},
 webServer:{command:'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5584 --strictPort',cwd:new URL('.',import.meta.url).pathname,url:'http://127.0.0.1:5584',reuseExistingServer:false},
});
