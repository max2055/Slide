import { test, expect } from '@playwright/test';
test.skip(process.env.EVENT_REAL_TEST !== '1', 'Explicit isolated MySQL required');
test('MAX-572 real load retry, failed write context, empty-event RCA and corrupt cache', async ({ page }) => {
 const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.INITIAL_ADMIN_PASSWORD } });
 expect(login.status()).toBe(200);
 const { token } = await login.json();
 await page.goto('/');
 // Only the initial list GET is fault injected; all writes reach the isolated application.
 let failed = false;
 await page.route('**/api/alerts/events?*', async route => {
  if (!failed) { failed = true; await route.fulfill({ status: 503, json: {} }); }
  else await route.continue();
 });
 await page.evaluate(async token => {
  document.querySelector('slide-app')?.remove();
  localStorage.setItem('token', token);
  localStorage.setItem('event_rca_result', JSON.stringify({ eventId: 55, analysisIds: null }));
  await import('/src/app/ui/views/event-management.ts');
  document.body.replaceChildren(document.createElement('event-management-page'));
 }, token);
 await expect(page.getByRole('button', { name: '重试加载' })).toBeVisible();
 await expect(page.getByText('系统运行正常')).toHaveCount(0);
 await expect(page.getByText('暂无活跃事件', { exact: true })).toHaveCount(0);
 await page.getByRole('button', { name: '重试加载' }).click();
 await expect(page.getByText('加载失败:', { exact: false })).toHaveCount(0);
 await page.locator('.event-title').filter({ hasText: '验收事件55' }).click();
 const note = page.getByRole('textbox', { name: '事件备注' });
 await note.fill('MAX572 preserved draft');
 await page.evaluate(() => localStorage.setItem('token', 'invalid'));
 await page.getByRole('button', { name: '添加备注', exact: true }).click();
 await expect(page.getByRole('alert').filter({ hasText: '操作失败' })).toBeVisible();
 await expect(note).toHaveValue('MAX572 preserved draft');
 await expect(page.locator('.event-title').first()).toBeVisible();
 await page.evaluate(token => localStorage.setItem('token', token), token);
 await page.getByRole('button', { name: '添加备注', exact: true }).click();
 await expect(note).toHaveValue('');
 await page.getByRole('button', { name: 'AI 根因分析', exact: true }).click();
 await expect(page.getByRole('alert').filter({ hasText: '根因分析失败' })).toBeVisible();
 expect(await page.evaluate(() => localStorage.getItem('event_rca_result'))).toBeNull();
 await page.evaluate(() => {
  localStorage.setItem('event_rca_result', JSON.stringify({ eventId: 55, analysisIds: [7], sessionKeys: ['session-7'] }));
  document.body.replaceChildren(document.createElement('event-management-page'));
 });
 await page.locator('.event-title').filter({ hasText: '验收事件55' }).click();
 await expect(page.getByText('已触发 1 个分析')).toBeVisible();
 await page.evaluate(() => window.addEventListener('slide-navigate', (event: any) => { (window as any).rcaNavigation = event.detail; }));
 await page.getByRole('link', { name: '查看 →' }).click();
 expect(await page.evaluate(() => (window as any).rcaNavigation.session)).toBe('session-7');
 for (const width of [1366,1440,1920]) {
  await page.setViewportSize({ width, height: width === 1366 ? 768 : width === 1920 ? 1080 : 900 });
  await expect(note).toBeVisible();
 }
});

test('MAX-572 delayed real GET cannot overwrite latest tab or page', async ({ page }) => {
 const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.INITIAL_ADMIN_PASSWORD } });
 const { token } = await login.json();
 await page.goto('/');
 await page.evaluate(async token => {
  document.querySelector('slide-app')?.remove(); localStorage.setItem('token', token);
  await import('/src/app/ui/views/event-management.ts');
  document.body.replaceChildren(document.createElement('event-management-page'));
 }, token);
 await expect(page.locator('.event-title').filter({ hasText: '验收事件55' })).toBeVisible();
 let release!: () => void;
 let entered!: () => void;
 let mode = 'tab';
 let held = false;
 let started = new Promise<void>(resolve => { entered = resolve; });
 let gate = new Promise<void>(resolve => { release = resolve; });
 const urls: string[] = [];
 await page.route('**/api/alerts/events?*', async route => {
  const url = route.request().url(); urls.push(url);
  if (!held && (mode === 'tab' ? url.includes('status=open') : url.includes('offset=50'))) {
   held = true;
   const response = await route.fetch(); entered(); await gate;
   await route.fulfill({ response });
  } else await route.continue();
 });
 await page.getByRole('button', { name: /^活跃事件/ }).click();
 await started;
 await page.getByRole('button', { name: /^已解决/ }).click();
 await expect(page.getByText('没有已解决事件', { exact: true })).toBeVisible();
 release();
 await expect.poll(() => page.evaluate(() => (document.querySelector('event-management-page') as any).retryLoading)).toBe(false);
 expect(urls.some(url => url.includes('status=resolved,closed'))).toBe(true);
 await expect(page.locator('.event-title')).toHaveCount(0);
 await page.getByRole('button', { name: /^活跃事件/ }).click();
 await expect(page.locator('.event-title').filter({ hasText: '验收事件55' })).toBeVisible();
 mode = 'page'; held = false;
 started = new Promise<void>(resolve => { entered = resolve; });
 gate = new Promise<void>(resolve => { release = resolve; });
 await page.getByRole('button', { name: '下一页 →' }).click(); await started;
 await page.getByRole('button', { name: '← 上一页' }).click();
 await expect(page.getByText('第 1/2 页，共 55 条')).toBeVisible();
 release();
 await expect(page.locator('.event-title').filter({ hasText: '验收事件55' })).toBeVisible();
 await page.unrouteAll({ behavior: 'wait' });
 await expect(page.locator('.event-title').filter({ hasText: '验收事件55' })).toBeVisible();
});

test('MAX-259 / #656 delayed real detail and logs stay with their selected event', async ({ page }) => {
 const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.INITIAL_ADMIN_PASSWORD } });
 expect(login.status()).toBe(200);
 const { token } = await login.json();
 await page.goto('/');
 await page.evaluate(async token => {
  document.querySelector('slide-app')?.remove(); localStorage.setItem('token', token);
  await import('/src/app/ui/views/event-management.ts');
  document.body.replaceChildren(document.createElement('event-management-page'));
 }, token);
 await expect(page.locator('.event-title').filter({ hasText: '验收事件55' })).toBeVisible();
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 let delayed = 0;
 // Fetch both genuine responses first, then delay only delivery to the browser.
 await page.route(/\/api\/alerts\/events\/55(?:\/logs)?$/, async route => {
  const response = await route.fetch();
  expect(response.status()).toBe(200);
  delayed++;
  await gate;
  await route.fulfill({ response });
 });
 try {
  await page.locator('.event-title').filter({ hasText: '验收事件55' }).click();
  await expect.poll(() => delayed).toBe(2);
  await page.locator('.event-title').filter({ hasText: '验收事件54' }).click();
  const state = () => page.evaluate(() => {
   const el = document.querySelector('event-management-page') as any;
   return { id: Number(el.selectedEvent?.id), title: el.selectedEvent?.title,
    members: el.eventMembers, logs: el.eventLogs, loaded: Object.hasOwn(el.selectedEvent ?? {}, 'alerts') };
  });
  await expect.poll(async () => (await state()).loaded).toBe(true);
  const current = await state();
  expect(current.id).toBe(54);
  expect(current.title).toBe('验收事件54');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  expect(await state()).toEqual(current);
  await expect(page.locator('.event-item.selected .event-title')).toHaveText('验收事件54');
 } finally {
  release();
  await page.unrouteAll({ behavior: 'wait' });
 }
});
