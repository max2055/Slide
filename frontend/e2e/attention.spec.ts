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
async function noEmpty(page: Page) { await expect(page.locator('event-management-page .empty-state')).toHaveCount(0); }

test('legacy attention opens active event center with numeric identities, refresh and keyboard details', async ({ page }) => {
  await env.pool.query(`INSERT INTO alert_events (id,event_id,instance_id,title,severity,status,updated_at) VALUES
    (202,UUID(),101,'同时间事项 B','critical','open','2026-10-15 00:00:00'),
    (201,UUID(),101,'同时间事项 A','critical','open','2026-10-15 00:00:00'),
    (203,UUID(),101,'较低严重度','warning','handled','2026-10-16 00:00:00'),
    (204,UUID(),101,'调查中事件','warning','investigating','2026-10-16 00:00:00'),
    (205,UUID(),101,'历史已解决','warning','resolved','2026-10-16 00:00:00')`);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const writes: string[] = []; page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/(alerts|investigations|operations)\//.test(request.url())) writes.push(request.url());
  });
  const read = page.waitForResponse(r => r.url().includes('/api/alerts/events?'));
  await page.goto(`${env.url}/attention`);
  const data = await (await read).json(); expect(typeof data.items[0].id).toBe('number');
  const view = page.locator('event-center-page');
  await expect(page).toHaveURL(/\/events\?view=aggregate&eventList=active/);
  await expect(view.locator('.event-item')).toHaveCount(4);
  expect((await view.locator('.event-item').allTextContents()).join(' ')).toMatch(/同时间事项/);
  for (const event of data.items) await expect(view.getByRole('button', { name: `查看事件 #${event.id} 详情` })).toBeVisible();
  const ids = data.items.map((event: any) => String(event.id));
  expect(await view.locator('.event-item').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-event-id')))).toEqual(ids);
  expect(data.items.map((event: any) => event.status).sort()).toEqual(['handled', 'investigating', 'open', 'open']);
  await expect(view.getByRole('button', {name:'查看事件 #205 详情'})).toHaveCount(0);
  await expect(view.getByRole('alert')).toHaveCount(0); await noEmpty(page);
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
    await capture(page, `data-${width}-${theme}`);
  }
  // Restore the desktop interaction surface after the retained narrow snapshots.
  await page.setViewportSize({width:1280,height:900});
  const refresh = view.getByRole('button', { name: '刷新事件' }); await refresh.focus();
  const refreshed = page.waitForResponse(r => r.url().includes('/api/alerts/events?'));
  await page.keyboard.press('Enter'); const response = await refreshed; expect(response.status()).toBe(200);
  expect((await response.json()).items.map((event:any)=>String(event.id))).toEqual(ids); await expect(refresh).toBeEnabled();
  const row = view.getByRole('button', { name: '查看事件 #201 详情' }); await row.focus(); await page.keyboard.press('Enter');
  const record = view.getByRole('region', { name: '事件详情' });
  await expect(record).toContainText('事件 #201');
  await expect(record.getByRole('heading', { name: /同时间事项 A/ })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(row).toBeFocused();
  await view.getByRole('button', {name:/^已解决/}).click();
  await expect(view.getByRole('button', {name:'查看事件 #205 详情'})).toBeVisible();
  await expect(view.locator('.event-item')).toHaveCount(1);
  await view.getByRole('button', {name:/^活跃事件/}).click();
  await expect(view.locator('.event-item')).toHaveCount(4);
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});

test('real successful empty response, then live permission revocation produce distinct states', async ({ page }) => {
  await page.goto(`${env.url}/?tab=attention`); const view = page.locator('event-center-page');
  await expect(view.locator('.empty-state')).toBeVisible(); await capture(page, 'empty-real');
  await env.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='alert:view'");
  try {
    const forbidden = page.waitForResponse(r => r.url().includes('/api/alerts/events?') && r.status() === 403);
    await view.getByRole('button', { name: '刷新事件' }).click(); await forbidden;
    await expect(view.getByRole('alert')).toContainText('无权访问'); await noEmpty(page);
    await expect(view.locator('.event-item')).toHaveCount(0); await capture(page, 'forbidden-real');
  } finally { await env.pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code='alert:view'"); }
});

test('controlled loading, server failure and malformed response never claim successful emptiness; keyboard retry recovers', async ({ page }) => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  await page.route(eventsPath, async route => { await gate; await route.fulfill({ status: 503, json: {} }); });
  try {
    await page.goto(`${env.url}/attention`); const view = page.locator('event-center-page');
    await expect(view.getByRole('button', { name: '刷新事件' })).toBeDisabled(); await noEmpty(page); await capture(page, 'loading-controlled');
    release(); await expect(view.getByRole('alert')).toBeVisible(); await noEmpty(page); await capture(page, 'failure-controlled');
    await page.unroute(eventsPath); await page.route(eventsPath, route => route.fulfill({ json: {} }));
    await view.getByRole('button', { name: '刷新事件' }).click(); await expect(view.getByRole('alert')).toContainText('返回格式异常'); await noEmpty(page);
    await page.unroute(eventsPath); const refresh = view.getByRole('button', { name: '刷新事件' }); await refresh.focus(); await page.keyboard.press('Enter');
    await expect(view.locator('.empty-state')).toBeVisible(); await expect(view.getByRole('alert')).toHaveCount(0);
  } finally { release(); }
});

test('controlled expired session and late data cannot display an empty result or restored facts', async ({ page }) => {
  await page.goto(`${env.url}/attention`); const view = page.locator('event-center-page');
  await expect(view.locator('.empty-state')).toBeVisible();
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  await page.route(eventsPath, async route => {
    await gate; await route.fulfill({ json: { items: [{ id: 999, title: '迟到的敏感事项', severity: 'critical', status: 'open', updated_at: '2026-10-15' }] } });
  });
  try {
    await view.getByRole('button', { name: '刷新事件' }).click();
    await expect(view.getByRole('button', { name: '刷新事件' })).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event('slide-session-expired')));
    // The full application removes the view and returns to login on this event.
    await expect(page.getByRole('alert')).toContainText('登录已超时'); release();
    await expect(view).toHaveCount(0); await noEmpty(page); await expect(page.getByText('迟到的敏感事项')).toHaveCount(0);
    await capture(page, 'expired-controlled');
  } finally { release(); }
});

test('controlled permission hydration and denial show explicit states', async ({ page }) => {
  await page.goto(`${env.url}/attention`); const view = page.locator('event-center-page');
  await expect(view.locator('.empty-state')).toBeVisible();
  await view.evaluate((element: any) => { element.permissions = null; });
  await expect(view.getByRole('status')).toContainText('正在确认访问权限'); await noEmpty(page);
  await view.evaluate((element: any) => { element.permissions = new Set(); });
  await expect(view.locator('app-empty-state[title="无访问权限"]')).toBeVisible(); await noEmpty(page);
  await capture(page, 'permission-denied-controlled');
});
