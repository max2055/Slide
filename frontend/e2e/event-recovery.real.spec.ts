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
  await page.setViewportSize({ width, height: width === 1366 ? 768 : 900 });
  await expect(note).toBeVisible();
 }
});
