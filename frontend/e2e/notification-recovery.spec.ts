import { test, expect, type Page } from '@playwright/test';

// Controlled HTTP states on the actual event-center page; no product model calls.
const job = { id: 'controlled-delivery-1', type: 'notification.deliver', payload: { alertId: 7, channelId: 2 }, attempts: 3, lastError: '受控投递失败', createdAt: '2026-10-15T00:00:00Z' };
async function fixture(page: Page, theme = 'light') {
  page.on('pageerror', error => console.error('PAGE ERROR', error.message));
  await page.addInitScript(theme => {
    localStorage.setItem('slide.control.session_token.v1', 'controlled-notification-test');
    localStorage.setItem('token', 'controlled-notification-test');
    localStorage.setItem('permissions', '["*"]');
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('app-theme-mode', theme);
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', themeMode: theme }));
  }, theme);
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    return route.fulfill({ json: path === '/api/auth/permissions' ? ['*'] : path === '/api/user/preferences' ? { preferences: { locale: 'zh-CN', themeMode: theme } } : [] });
  });
}

test('503 persists and keyboard retry restores rows then confirmed empty state', async ({ page }, info) => {
  await fixture(page);
  let state: 'failed' | 'rows' | 'empty' = 'failed';
  await page.route('**/api/notification/dead-letters?*', route => route.fulfill({ status: state === 'failed' ? 503 : 200, json: state === 'failed' ? { error: 'controlled outage' } : state === 'rows' ? [job] : [] }));
  await page.goto('/events?view=notifications');
  const view = page.locator('alerts-page');
  await expect(view).toBeVisible();
  await expect(view.getByRole('alert')).toContainText('HTTP 503');
  await page.screenshot({ path: info.outputPath('503-page.png'), fullPage: true });
  await expect(view.getByRole('alert')).toContainText('HTTP 503');
  await expect(view.getByText('没有待重放的通知', { exact: true })).toHaveCount(0);
  await expect(page.locator('app-toast-container').getByText(/加载通知死信失败/)).toHaveCount(0);
  state = 'rows'; const retry = view.getByRole('button', { name: '重试', exact: true });
  await retry.focus(); await page.keyboard.press('Enter');
  await expect(view.locator('tbody tr')).toHaveCount(1); await expect(view).toContainText(job.id);
  await expect(view.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('rows-page.png'), fullPage: true });
  state = 'empty'; await view.getByRole('button', { name: '刷新通知投递记录' }).click();
  await expect(view.getByText('没有待重放的通知', { exact: true })).toBeVisible();
  await expect(view.locator('tbody tr')).toHaveCount(0);
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`403, malformed and loading states ${width}px ${theme}`, async ({ page }, info) => {
    await fixture(page, theme); await page.setViewportSize({ width, height: 900 });
    let state: 'forbidden' | 'invalid' | 'loading' = 'forbidden';
    let release!: () => void;
    await page.route('**/api/notification/dead-letters?*', async route => {
      if (state === 'loading') await new Promise<void>(resolve => release = resolve);
      await route.fulfill({ status: state === 'forbidden' ? 403 : 200, json: state === 'invalid' ? {} : [] });
    });
    await page.goto('/events?view=notifications'); const view = page.locator('alerts-page');
    await expect(view.getByRole('alert')).toContainText('无权查看通知投递记录');
    await page.screenshot({ path: info.outputPath('403-page.png'), fullPage: true });
    state = 'invalid'; await view.getByRole('button', { name: '重试', exact: true }).click();
    await expect(view.getByRole('alert')).toContainText('通知投递记录格式异常');
    state = 'loading'; await view.getByRole('button', { name: '重试', exact: true }).click();
    await expect(view.getByRole('status')).toContainText('加载通知投递记录');
    await expect(view.getByRole('button', { name: '刷新通知投递记录' })).toBeDisabled();
    await page.screenshot({ path: info.outputPath('loading-page.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    release(); await expect(view.getByText('没有待重放的通知', { exact: true })).toBeVisible();
    await expect(view.getByRole('alert')).toHaveCount(0);
  });
}

test('timeout offers retry without reporting an empty queue', async ({ page }, info) => {
  await fixture(page); await page.clock.install();
  await page.route('**/api/notification/dead-letters?*', () => {});
  await page.goto('/events?view=notifications'); const view = page.locator('alerts-page');
  await expect(view.getByRole('status')).toContainText('加载通知投递记录');
  await page.clock.fastForward(15_001);
  await expect(view.getByRole('alert')).toContainText('加载通知投递记录超时');
  await page.screenshot({ path: info.outputPath('timeout-page.png'), fullPage: true });
  await expect(view.getByText('没有待重放的通知', { exact: true })).toHaveCount(0);
});
