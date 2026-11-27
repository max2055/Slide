import { test as base, expect, type Page } from '@playwright/test';
import { startInvestigationServer } from './fixtures/investigation-server.ts';

// Normal and empty reads use real JWT/live authorization + event service + isolated SQL.
// Intercepted HTTP responses below are explicitly controlled failure/compatibility cases.
const test = base.extend<{ cachePermissions: boolean }>({
  cachePermissions: [true, { option: true }],
});
let env: Awaited<ReturnType<typeof startInvestigationServer>>;
const eventsPath = '**/api/alerts/events?*';
test.beforeAll(async () => { env = await startInvestigationServer({ attentionPilot: true }); });
test.afterAll(async () => {
  if (env) { try { expect(env.counts()).toEqual({ toolCalls: 0, providerCalls: 0 }); } finally { await env.close(); } }
});
test.beforeEach(async ({ page, cachePermissions }) => {
  await env.pool.query('DELETE FROM alert_events');
  await page.addInitScript(({ token, permissions }) => {
    localStorage.setItem('token', token);
    if (permissions) localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('user', JSON.stringify({ id: 101, username: 't06-owner' }));
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', navCollapsed: true }));
  }, { token: env.token(), permissions: cachePermissions ? env.owner.permissions : null });
});
async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
}
async function noEmpty(page: Page) { await expect(page.locator('event-management-page .empty-state')).toHaveCount(0); }

test('workbench home, exact records and page-local queue filters on real HTTP', async ({ page }) => {
  const investigation = (await env.bridge.create(env.owner, {
    title: '工作台深链验收调查', goal: '核对原调查记录', profileId: 'ops', profileVersion: 1,
    resources: [{ type: 'instance', id: 101, role: 'primary' }],
    context: { subject: { kind: 'resource', resource: { type: 'instance', id: 101 } } },
    idempotencyKey: crypto.randomUUID(),
  })).investigation;
  await env.pool.query(`INSERT INTO alert_events (id,event_id,instance_id,title,severity,status,created_at) VALUES
    (72101,UUID(),101,'第二页待跟进事件','warning','open','2026-11-20 00:00:00'),
    ${Array.from({ length: 15 }, (_, i) => `(${72102 + i},UUID(),101,'首页已解决事件','warning','resolved','2026-11-21 00:00:00')`).join(',')}`);
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/(alerts|investigations|operations)\b/.test(request.url())) writes.push(request.url());
  });
  const workbench = page.locator('workbench-page');
  const sidebar = page.locator('.shell-nav');
  const entry = sidebar.getByRole('link', { name: 'AI 工作台', exact: true });
  const queue = workbench.getByRole('region', { name: '事件队列' });
  const input = queue.getByRole('searchbox', { name: '搜索事件' });
  const home = workbench.getByRole('heading', { name: '运维工作台', exact: true });
  const exactEvent = workbench.getByRole('button', { name: /#72101/ });
  const url = `${env.url}/workbench`;
  await page.goto(url);
  await expect(home).toBeVisible();
  await workbench.getByRole('button', { name: '调查列表', exact: true }).click();
  await entry.click();
  await expect(page).toHaveURL(url);
  await expect(home).toBeVisible();
  await sidebar.getByRole('link', { name: '问题反馈', exact: true }).click();
  await expect(page).toHaveURL(/\/feedback/);
  await entry.click();
  await expect(page).toHaveURL(url);
  await expect(home).toBeVisible();

  const deepEvent = `${url}?workspaceTab=home&eventId=72101`;
  await page.goto(deepEvent);
  await page.reload();
  await expect(exactEvent).toHaveAttribute('aria-pressed', 'true');
  await entry.click();
  await expect(input).toHaveValue('');
  await expect(exactEvent).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(deepEvent);
  await expect(exactEvent).toHaveAttribute('aria-pressed', 'true');
  await page.goForward();
  await expect(page).toHaveURL(url);
  await expect(input).toHaveValue('');

  await page.goto(`${env.url}/investigations?investigation=${investigation.id}`);
  const investigationUrl = `${url}?investigation=${investigation.id}`;
  const title = workbench.locator('.investigation-detail-title');
  await expect(page).toHaveURL(investigationUrl);
  await page.reload();
  await expect(title).toContainText('工作台深链验收调查');
  await entry.click();
  await expect(home).toBeVisible();
  await page.goBack();
  await expect(title).toContainText('工作台深链验收调查');
  await page.goForward();
  await expect(home).toBeVisible();

  for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await input.focus();
    await expect(input).toBeFocused();
    await expect(input).not.toHaveCSS('box-shadow', 'none');
    await page.keyboard.type('#72101');
    await page.keyboard.press('Enter');
    await expect(exactEvent).toHaveAttribute('aria-pressed', 'true');
    const clear = queue.getByRole('button', { name: '清除事件搜索' });
    const field = (await input.boundingBox())!;
    const icon = (await queue.locator('.search-icon').boundingBox())!;
    const button = (await clear.boundingBox())!;
    for (const control of [icon, button]) {
      expect(control.y).toBeGreaterThan(field.y);
      expect(control.y + control.height).toBeLessThan(field.y + field.height);
      expect(control.y + control.height / 2).toBeCloseTo(field.y + field.height / 2);
    }
    expect(icon.x).toBeGreaterThan(field.x);
    expect(button.x + button.width).toBeLessThan(field.x + field.width);
    await capture(page, `max721-search-${width}`);
    await page.keyboard.press('Tab');
    await expect(clear).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
    await expect(queue).toContainText('本页 15 条');
  }

  await input.fill('第二页待跟进事件');
  await input.press('Enter');
  await expect(exactEvent).toHaveAttribute('aria-pressed', 'true');
  await expect(queue).toContainText('本页 1 条');
  await queue.getByRole('button', { name: '清除事件搜索' }).click();
  await expect(queue).toContainText('本页 15 条');

  const filter = queue.getByRole('group', { name: '本页状态' });
  await filter.getByRole('button', { name: '待跟进' }).click();
  await expect(queue).toContainText('本页没有符合所选状态的事件。');
  await expect(queue).toContainText('本页 0 条');
  await capture(page, 'max721-local-empty');
  await queue.getByRole('button', { name: '下一页' }).click();
  await expect(exactEvent).toBeVisible();
  await expect(filter.getByRole('button', { name: '待跟进' })).toHaveAttribute('aria-pressed', 'true');
  await queue.getByRole('button', { name: '上一页' }).click();
  await queue.getByRole('button', { name: '清除状态筛选' }).click();
  await expect(filter.getByRole('button', { name: '全部' })).toBeFocused();
  await expect(queue).toContainText('本页 15 条');
  expect(writes).toEqual([]);
});

async function seedEventInvestigation(eventId: number, title: string) {
  const resources = [{ type: 'instance' as const, id: 101, role: 'primary' as const }];
  const subject = { kind: 'resource' as const, resource: { type: 'instance' as const, id: 101 } };
  const from = '2026-11-19T00:00:00.000Z', to = '2026-11-19T00:05:00.000Z';
  const { investigation } = await env.bridge.create(env.owner, {
    title, goal: '核对已保存的事件调查', profileId: 'ops', profileVersion: 1,
    resources, context: { subject, from, to, entry: { schemaVersion: 1, resourceRefs: resources, from, to, sourceEventIds: [eventId], returnTo: '/events' } },
    idempotencyKey: crypto.randomUUID(),
  });
  return investigation;
}

test('MAX-720 distinguishes same-name investigations at the same second and timestamp', async ({ page }) => {
  const [inserted] = await env.pool.query(
    "INSERT INTO alert_events(event_id,instance_id,title,severity,status) VALUES(UUID(),101,'合成同秒事件','warning','open')");
  const eventId = inserted.insertId;
  const title = '同一事件的合成调查';
  const samples = [];
  for (const fraction of ['100', '800', '800']) {
    const { id } = await seedEventInvestigation(eventId, title);
    const timestamp = `2026-11-19 00:00:00.${fraction}`;
    await env.pool.query('UPDATE investigations SET created_at=?, updated_at=? WHERE id=?', [timestamp, timestamp, id]);
    samples.push({ id, fraction });
  }
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/(alerts|investigations|operations)\b/.test(new URL(request.url()).pathname)) writes.push(request.url());
  });
  await page.goto(`${env.url}/feedback`);
  await page.locator('.shell-nav').getByRole('link', { name: 'AI 工作台', exact: true }).click();
  await page.getByRole('button', { name: '调查列表', exact: true }).click();
  const table = page.getByRole('region', { name: '调查记录表' });
  const rows = table.getByRole('row').filter({ hasText: `事件 #${eventId}` });
  await expect(rows).toHaveCount(3);
  for (const { id, fraction } of samples) {
    const row = rows.filter({ hasText: id });
    await expect(row.getByText(title, { exact: true })).toBeVisible();
    await expect(row).toContainText(`记录 ID ${id}`);
    await expect(row).toContainText(`.${fraction}`);
    const open = row.getByRole('button', { name: `查看调查 ${id}`, exact: true });
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`investigation=${id}`));
    await expect(page.locator('.investigation-detail-title')).toContainText(title);
    await page.getByRole('link', { name: '返回来源页面', exact: true }).click();
    await expect(open).toBeFocused();
  }
  expect(writes).toEqual([]);
  expect(env.counts()).toEqual({ toolCalls: 0, providerCalls: 0 });
});

for (const throughInvestigation of [false, true]) {
  test(`MAX-720 returns to the original queue row on page two ${throughInvestigation ? 'through investigation detail' : 'directly'}`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const eventId = throughInvestigation ? 72031 : 72001;
    await env.pool.query(`INSERT INTO alert_events (id,event_id,instance_id,title,severity,status,created_at) VALUES
      ${Array.from({ length: 30 }, (_, i) => `(${eventId + i},UUID(),101,'合成队列定位事件 ${eventId + i}','warning','open','2026-11-${i < 15 ? 19 : 20} 00:00:${String(i).padStart(2, '0')}')`).join(',')}`);
    const investigation = throughInvestigation ? await seedEventInvestigation(eventId, '合成队列来源调查') : undefined;
    const writes: string[] = [];
    page.on('request', request => {
      if (request.method() !== 'GET' && /\/api\/(alerts|investigations|operations)\b/.test(new URL(request.url()).pathname)) writes.push(request.url());
    });

    await page.goto(`${env.url}/feedback`);
    await page.locator('.shell-nav').getByRole('link', { name: 'AI 工作台', exact: true }).click();
    const workbench = page.locator('workbench-page');
    const queue = workbench.getByRole('region', { name: '事件队列' });
    const input = queue.getByRole('searchbox', { name: '搜索事件' });
    await input.fill('合成队列定位事件');
    await input.press('Enter');
    await expect(queue).toContainText('本页 15 条');
    const filter = queue.getByRole('button', { name: '待跟进', exact: true });
    await filter.click();
    await queue.getByRole('button', { name: '下一页' }).click();
    const row = queue.getByRole('button', { name: new RegExp(`#${eventId}`) });
    await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    const open = workbench.getByRole('link', { name: '打开事件详情', exact: true });
    const rows = queue.locator('.rows');
    const main = page.locator('main.content');
    await open.focus();
    await main.evaluate(el => { el.scrollTop = 80; });
    const [listY, mainY] = await Promise.all([rows.evaluate(el => el.scrollTop), main.evaluate(el => el.scrollTop)]);
    expect(listY).toBeGreaterThan(0);
    expect(mainY).toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    const record = page.getByRole('region', { name: '事件详情', exact: true });
    await expect(record).toContainText(`事件 #${eventId}`);
    if (investigation) {
      const linked = record.getByRole('link', { name: '打开原调查', exact: true });
      await linked.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`investigation=${investigation.id}`));
      await page.getByRole('link', { name: '返回来源页面', exact: true }).click();
      await expect(record).toContainText(`事件 #${eventId}`);
    }
    const back = record.getByRole('link', { name: '返回工作台', exact: true });
    await expect(back).toBeVisible();
    await back.click();
    await expect(workbench.getByRole('button', { name: '工作台', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(input).toHaveValue('合成队列定位事件');
    await expect(filter).toHaveAttribute('aria-pressed', 'true');
    await expect(queue.getByRole('button', { name: '上一页' })).toBeEnabled();
    await expect(queue.getByRole('button', { name: new RegExp(`#${eventId + 29}`) })).toHaveCount(0);
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(row).toBeFocused();
    expect(await rows.evaluate(el => el.scrollTop)).toBe(listY);
    expect(await main.evaluate(el => el.scrollTop)).toBe(mainY);
    expect(writes).toEqual([]);
    expect(env.counts()).toEqual({ toolCalls: 0, providerCalls: 0 });
  });
}

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

test.describe('without cached grants', () => {
  test.use({ cachePermissions: false });

  test('controlled permission hydration and denial show explicit states', async ({ page }) => {
    let release!: () => void;
    const pendingPermissions = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/auth/permissions', async route => {
      await pendingPermissions;
      await route.fulfill({ json: [] });
    });
    const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/auth/permissions');
    const eventReads: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/alerts/events') eventReads.push(request.method());
    });
    try {
      await page.goto(`${env.url}/attention`);
      await request;
      const view = page.locator('event-center-page');
      await expect(page.locator('main app-empty-state[title="正在确认页面访问权限"]')).toBeVisible();
      await expect(view).toHaveCount(0);
      await noEmpty(page);
      await capture(page, 'permission-loading-controlled');
      release();
      await expect(page.locator('main app-empty-state[title="当前账号无权访问此页面"]')).toBeVisible();
      await expect(view).toHaveCount(0);
      await noEmpty(page);
      expect(eventReads).toEqual([]);
      await capture(page, 'permission-denied-controlled');
    } finally {
      release();
    }
  });
});

test('isolated event center denies reads before grants and after revocation', async ({ page }) => {
  const context = `${env.url}/events?view=aggregate`;
  const reads: string[] = [];
  await page.route(eventsPath, route => {
    reads.push(route.request().method());
    return route.fulfill({ json: { items: [], total: 0 } });
  });
  // The application shell owns its permission hydration. Mount this controlled
  // component directly so an unrelated shell refresh cannot replace the test state.
  await page.route(context, route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="zh-CN"><body>
      <event-center-page></event-center-page>
      <script type="module">import '/src/app/ui/views/event-center.ts';</script>
    </body></html>`,
  }));
  const applyPermissions = (permissions: string[]) => page.evaluate(values => {
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: values } }));
  }, permissions);
  await page.goto(context); const view = page.locator('event-center-page');
  await expect(view.getByRole('status')).toContainText('正在确认访问权限'); await noEmpty(page);
  expect(reads).toEqual([]);
  await applyPermissions([]);
  await expect(view.locator('app-empty-state[title="无访问权限"]')).toBeVisible(); await noEmpty(page);
  expect(reads).toEqual([]);

  await applyPermissions(['alert:view']);
  await expect(view.locator('event-management-page .empty-state')).toBeVisible();
  expect(reads).toEqual(['GET']);
  await applyPermissions([]);
  await expect(view.locator('app-empty-state[title="无访问权限"]')).toBeVisible(); await noEmpty(page);
  expect(reads).toEqual(['GET']);
  await capture(page, 'permission-revoked-controlled');
});
