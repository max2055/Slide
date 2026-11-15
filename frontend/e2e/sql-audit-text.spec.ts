import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';

// #682: exercise the real component through submission/polling and history.
// HTTP responses are controlled fixtures; no database or model is called.
const literal = '<img src=x onerror="window.auditHtmlExecuted=true"> < > & " &lt;';
const key = '字段 < > &';
const result = {
  summary: literal,
  [key]: [literal, { [key]: literal }, 42, null],
  object: { [key]: literal },
  scalar: literal,
};
let vite: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  vite = await createServer({ configFile: resolve('vite.config.js'), root: resolve('.'),
    server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await vite.listen();
  origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
});
test.afterAll(async () => { await vite?.close(); });

for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`current and historical audit text stays literal at ${width}x${height}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await page.route('**/api/sql/audit**', route => {
      const url = new URL(route.request().url());
      const body = route.request().method() === 'POST' ? { analysis_id: 682, pre_audit_results: [] }
        : url.pathname.endsWith('/status') ? { status: 'completed' }
        : url.pathname.includes('/instance/') ? [{ id: 682, status: 'completed' }]
        : { id: 682, status: 'completed', audit_record: { sql_text: 'SELECT 1 WHERE 1 < 2 & 3 > 0' }, result };
      return route.fulfill({ json: body });
    });
    await page.goto(origin + '/e2e/fixtures/sql-audit-history.html');
    const view = page.locator('sql-audit-tab');
    await view.locator('textarea').fill('SELECT 1 WHERE 1 < 2');
    await view.getByRole('button', { name: '提交审核', exact: true }).press('Enter');
    const current = view.locator('.result-card').first();
    await expect(current.locator('p')).toHaveText(literal, { timeout: 10_000 });
    await expect(current.locator('li').nth(0)).toHaveText(literal);
    await expect(current.locator('li').nth(1)).toHaveText(`${key}: ${literal}`);
    await expect(current.locator('li').nth(2)).toHaveText('42');
    await expect(current.locator('li').nth(3)).toHaveText('null');
    await expect(current.locator('strong').nth(1)).toHaveText(key);
    await expect(current.locator('pre')).toHaveText(JSON.stringify(result.object, null, 2));
    await expect(current.locator('span')).toHaveText(literal);
    const toggle = view.getByRole('button', { name: '审核记录 #682 详情', exact: true });
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const history = view.locator('.history-detail');
    await expect(history.locator('pre').nth(0)).toHaveText('SELECT 1 WHERE 1 < 2 & 3 > 0');
    await expect(history.locator('.result-card pre').nth(0)).toHaveText(literal);
    await expect(history.locator('.result-card pre').nth(1)).toHaveText(JSON.stringify(result[key], null, 2));
    await expect(history.locator('.result-card pre').nth(2)).toHaveText(JSON.stringify(result.object, null, 2));
    await expect(history.locator('.result-card pre').nth(3)).toHaveText(literal);
    await expect(view.locator('img, script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).auditHtmlExecuted)).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const screenshot = info.outputPath(`audit-text-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach(`audit-text-${width}`, { path: screenshot, contentType: 'image/png' });
    await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(errors).toEqual([]);
  });
}
