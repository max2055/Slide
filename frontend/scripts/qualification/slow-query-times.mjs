// Controlled UI acceptance; production Lit component, no live API or model calls.
// SLIDE_UI_OUTPUT=<artifact-directory> pnpm --filter slide-frontend exec node scripts/qualification/slow-query-times.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
const output = process.env.SLIDE_UI_OUTPUT;
assert(output, 'SLIDE_UI_OUTPUT is required');
await mkdir(output, { recursive: true });
const vite = await createServer({ root: resolve('.'), configFile: resolve('vite.config.js'), server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.route(url => url.pathname.startsWith('/api/'), route => {
      const path = new URL(route.request().url()).pathname;
      const body = path.endsWith('/996') ? { id: 996, name: 'Oracle 耗时验收', db_type: 'oracle', host: 'fixture.invalid', port: 1521, status: 'active' }
        : path.endsWith('/topsql') ? [{ id: 'oracle', sql_text: 'SELECT fixture', avg_time_ms: 2000, max_time_ms: null, execution_count: 5, last_seen: new Date().toISOString() }]
        : { items: [], records: [] };
      return route.fulfill({ json: body });
    });
    for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/e2e/fixtures/instance-query.html?id=996`);
      const view = page.locator('instance-detail-page');
      const tab = view.getByRole('tab', { name: '慢查询', exact: true });
      await tab.focus();
      await page.keyboard.press('Enter');
      await view.getByText('2000.00 ms', { exact: true }).waitFor();
      assert.equal(await view.locator('tbody td').nth(2).textContent(), '未知');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: resolve(output, `${width}x${height}.png`), fullPage: true });
    }
    console.log('PASS: 3 desktop sizes, keyboard tab activation, 2000ms, unknown maximum, no horizontal page overflow');
  } finally { await page.close(); }
} finally {
  await browser?.close();
  await vite.close();
}
