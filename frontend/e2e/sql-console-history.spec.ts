import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';

// MAX-561/#684/#685: production Lit/CodeMirror in Chromium, controlled HTTP.
// No database, model, production credentials or cross-instance API is used.
let vite: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  vite = await createServer({ configFile: resolve('vite.config.js'), root: resolve('.'),
    server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await vite.listen();
  origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
});
test.afterAll(async () => { await vite?.close(); });
const item = (sql: string, instanceName = '一号库') => ({ id: 1, sql, instanceName,
  timestamp: '2026-11-15T00:00:00Z', durationMs: 2, rowCount: 1 });

for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`history filtering, failure and recovery at ${width}x${height}`, async ({ page }, info) => {
    const errors: string[] = [];
    const requests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let mode: 'ok' | 'empty' | 'error' | 'denied' = 'ok';
    await page.setViewportSize({ width, height });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith('/api/')) return route.fallback();
      if (url.pathname === '/api/database/instances') return route.fulfill({ json: [
        { id: 1, name: '一号库', db_type: 'mysql' }, { id: 2, name: '二号库', db_type: 'mysql' },
      ] });
      if (url.pathname.endsWith('/query-history')) {
        requests.push(url.pathname + url.search);
        if (mode === 'error' || mode === 'denied') return route.fulfill({ status: mode === 'error' ? 500 : 403, json: { error: 'unavailable' } });
        return route.fulfill({ json: { items: mode === 'empty' ? [] : [item('SELECT history', url.pathname.includes('/2/') ? '二号库' : '一号库')], total: mode === 'empty' ? 0 : 1 } });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(origin + '/e2e/fixtures/sql-console.html');
    await expect(page.locator('.cm-editor')).toBeVisible();
    await page.waitForFunction(() => (document.querySelector('sql-console-page') as any).instances.length === 2);
    // Choose a toolbar instance before opening history: history must retain its own default.
    await page.evaluate(() => (document.querySelector('sql-console-page') as any)._selectInstance(2));
    await page.getByRole('button', { name: '历史', exact: true }).press('Enter');
    const filter = page.getByRole('combobox', { name: '查询历史实例' });
    await expect(filter).toHaveValue('0');
    await expect(page.getByRole('status')).toContainText('当前不支持跨实例查看');
    expect(requests).toEqual([]);
    await filter.selectOption('1');
    await expect(page.locator('.history-item')).toHaveCount(1);
    expect(requests.at(-1)).toContain('/instances/1/query-history');
    await page.evaluate(() => (document.querySelector('sql-console-page') as any)._selectInstance(1));
    await expect(filter).toHaveValue('1');
    await filter.selectOption('2');
    await expect(page.locator('.history-meta')).toContainText('二号库');
    expect(requests.at(-1)).toContain('/instances/2/query-history');
    mode = 'error';
    await page.getByRole('textbox', { name: '搜索查询历史' }).fill('bad');
    await expect(page.getByRole('alert')).toContainText('查询历史加载失败');
    await expect(page.getByText('暂无查询记录', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`failure-${width}.png`) });
    mode = 'empty';
    await page.getByRole('button', { name: '重试', exact: true }).press('Enter');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('无匹配结果', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '搜索查询历史' }).fill('');
    await expect(page.getByText('暂无查询记录', { exact: true })).toBeVisible();
    mode = 'denied';
    await filter.selectOption('1');
    await expect(page.getByRole('alert')).toBeVisible();
    mode = 'ok';
    await page.getByRole('button', { name: '重试', exact: true }).press('Space');
    await expect(page.locator('.history-item')).toHaveCount(1);
    const count = requests.length;
    await filter.selectOption('0');
    await expect(page.getByRole('status')).toContainText('当前不支持跨实例查看');
    await expect(page.locator('.history-item')).toHaveCount(0);
    expect(requests).toHaveLength(count);
    expect(requests.some(url => url.includes('/instances/0/'))).toBe(false);
    await filter.focus(); await expect(filter).toBeFocused();
    expect(await filter.getAttribute('aria-label')).toBe('查询历史实例');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`all-instances-${width}.png`) });
    expect(errors).toEqual([]);
    await info.attach('requests', { body: JSON.stringify(requests, null, 2), contentType: 'application/json' });
    await page.close();
  });
}

test('late instance and search responses cannot replace current history', async ({ page }) => {
  const pending: Promise<unknown>[] = [];
  let releaseOld!: () => void;
  let releaseSearch!: () => void;
  const searchGate = new Promise<void>(resolve => { releaseSearch = resolve; });
  let oldStarted!: () => void;
  const started = new Promise<void>(resolve => { oldStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseOld = resolve; });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    if (url.pathname === '/api/database/instances') return route.fulfill({ json: [
      { id: 1, name: '一号库', db_type: 'mysql' }, { id: 2, name: '二号库', db_type: 'mysql' },
    ] });
    if (url.pathname.endsWith('/query-history')) {
      if (url.pathname.includes('/1/') || url.searchParams.get('search') === 'old') {
        oldStarted();
        const reply = (url.searchParams.get('search') === 'old' ? searchGate : gate).then(() => route.fulfill({ json: { items: [item('STALE')], total: 99 } }));
        pending.push(reply); return reply;
      }
      return route.fulfill({ json: { items: [item('CURRENT')], total: 1 } });
    }
    return route.fulfill({ json: [] });
  });
  try {
    await page.goto(origin + '/e2e/fixtures/sql-console.html');
    await page.getByRole('button', { name: '历史', exact: true }).click();
    const filter = page.getByRole('combobox', { name: '查询历史实例' });
    await filter.selectOption('1'); await started;
    await filter.selectOption('2');
    await expect(page.locator('.history-sql')).toHaveText('CURRENT');
    releaseOld(); await Promise.all(pending);
    await expect(page.locator('.history-sql')).toHaveText('CURRENT');
    const search = page.getByRole('textbox', { name: '搜索查询历史' });
    const oldSearch = page.waitForRequest(request => new URL(request.url()).searchParams.get('search') === 'old');
    await search.fill('old'); await oldSearch;
    await search.fill('new');
    await expect(page.locator('.history-sql')).toHaveText('CURRENT');
    releaseSearch(); await Promise.all(pending);
    await expect(page.locator('.history-sql')).toHaveText('CURRENT');
    await expect(page.locator('.history-sql')).not.toContainText('STALE');
  } finally {
    releaseOld(); releaseSearch();
    await page.close();
    await Promise.allSettled(pending);
  }
});
