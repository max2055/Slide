import { test, expect, type Page } from '@playwright/test';
import { startInvestigationServer } from './fixtures/investigation-server.ts';

// Normal and empty reads use real JWT/live authorization + event service + isolated SQL.
// Intercepted HTTP responses below are explicitly controlled failure/compatibility cases.
let env: Awaited<ReturnType<typeof startInvestigationServer>>;
const eventsPath = '**/api/alerts/events?*';
test.beforeAll(async () => { env = await startInvestigationServer({ attentionPilot: true }); });
test.afterAll(async () => {
  if (env) { try { expect(env.counts()).toEqual({ toolCalls: 0, providerCalls: 0 }); } finally { await env.close(); } }
});
test.beforeEach(async ({ page }) => {
  await env.pool.query('DELETE FROM alert_events');
  await page.addInitScript(({ token, permissions }) => {
    localStorage.setItem('token', token); localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('user', JSON.stringify({ id: 101, username: 't06-owner' }));
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', navCollapsed: true }));
  }, { token: env.token(), permissions: env.owner.permissions });
});
async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
}
async function noEmpty(page: Page) { await expect(page.locator('attention-page app-empty-state[title="暂无关注事项"]')).toHaveCount(0); }

test('real numeric event IDs with identical timestamps render in stable order, refresh by keyboard and open event center', async ({ page }) => {
  await env.pool.query(`INSERT INTO alert_events (id,event_id,instance_id,title,severity,status,updated_at) VALUES
    (202,UUID(),101,'同时间事项 B','critical','open','2026-10-15 00:00:00'),
    (201,UUID(),101,'同时间事项 A','critical','open','2026-10-15 00:00:00'),
    (203,UUID(),101,'较低严重度','warning','handled','2026-10-16 00:00:00')`);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const read = page.waitForResponse(r => r.url().includes('/api/alerts/events?'));
  await page.goto(`${env.url}/attention`);
  const data = await (await read).json(); expect(typeof data.items[0].id).toBe('number');
  const view = page.locator('attention-page');
  await expect(view.locator('tbody tr')).toHaveText([/同时间事项 A.*严重.*待处理/s, /同时间事项 B.*严重.*待处理/s, /较低严重度.*警告.*待验证/s]);
  await expect(view.getByRole('alert')).toHaveCount(0); await noEmpty(page);
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
    await capture(page, `data-${width}-${theme}`);
  }
  const refresh = view.getByRole('button', { name: '刷新事项' }); await refresh.focus();
  const refreshed = page.waitForResponse(r => r.url().includes('/api/alerts/events?'));
  await page.keyboard.press('Enter'); expect((await refreshed).status()).toBe(200); await expect(refresh).toBeFocused();
  await view.getByRole('button', { name: '打开事件中心' }).focus(); await page.keyboard.press('Enter'); await expect(page).toHaveURL(/\/events$/);
  expect(errors).toEqual([]);
});

test('real successful empty response, then live permission revocation produce distinct states', async ({ page }) => {
  await page.goto(`${env.url}/attention`); const view = page.locator('attention-page');
  await expect(view.locator('app-empty-state[title="暂无关注事项"]')).toBeVisible(); await capture(page, 'empty-real');
  await env.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='alert:view'");
  try {
    const forbidden = page.waitForResponse(r => r.url().includes('/api/alerts/events?') && r.status() === 403);
    await view.getByRole('button', { name: '刷新事项' }).click(); await forbidden;
    await expect(view.getByRole('alert')).toContainText('无权访问'); await noEmpty(page);
    await expect(view.locator('app-data-table')).toHaveCount(0); await capture(page, 'forbidden-real');
  } finally { await env.pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code='alert:view'"); }
});

test('controlled loading, server failure and malformed response never claim successful emptiness; keyboard retry recovers', async ({ page }) => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  await page.route(eventsPath, async route => { await gate; await route.fulfill({ status: 503, json: {} }); });
  try {
    await page.goto(`${env.url}/attention`); const view = page.locator('attention-page');
    await expect(view.getByRole('button', { name: '刷新事项' })).toBeDisabled(); await noEmpty(page); await capture(page, 'loading-controlled');
    release(); await expect(view.getByRole('alert')).toBeVisible(); await noEmpty(page); await capture(page, 'failure-controlled');
    await page.unroute(eventsPath); await page.route(eventsPath, route => route.fulfill({ json: {} }));
    await view.getByRole('button', { name: '刷新事项' }).click(); await expect(view.getByRole('alert')).toContainText('返回格式异常'); await noEmpty(page);
    await page.unroute(eventsPath); const refresh = view.getByRole('button', { name: '刷新事项' }); await refresh.focus(); await page.keyboard.press('Enter');
    await expect(view.locator('app-empty-state[title="暂无关注事项"]')).toBeVisible(); await expect(view.getByRole('alert')).toHaveCount(0);
  } finally { release(); }
});

test('controlled expired session and late data cannot display an empty result or restored facts', async ({ page }) => {
  await page.goto(`${env.url}/attention`); const view = page.locator('attention-page');
  await expect(view.locator('app-empty-state[title="暂无关注事项"]')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('slide-session-expired')));
  await expect(view.getByRole('alert')).toContainText('登录已失效'); await noEmpty(page); await expect(view.locator('app-data-table')).toHaveCount(0);
  await capture(page, 'expired-controlled');
});
