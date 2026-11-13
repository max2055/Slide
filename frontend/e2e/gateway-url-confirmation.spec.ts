import { expect, test } from '@playwright/test';

const nextUrl = 'ws://127.0.0.1:29999/ws';
// Real shell/render/handlers/storage, with controlled HTTP/WS dependencies only.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'gateway-confirmation-fixture');
    localStorage.setItem('permissions', JSON.stringify(['*']));
    localStorage.setItem('slide.control.session_token.v1', 'gateway-confirmation-fixture');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
  });
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    return route.fulfill({ json: path === '/api/auth/permissions' ? ['*']
      : path === '/api/user/preferences' ? { preferences: { locale: 'zh-CN' } } : {} });
  });
});

async function openFromControl(page: import('@playwright/test').Page) {
  await page.goto('/feedback');
  await expect(page.locator('feedback-page')).toBeVisible();
  // Current production trigger is URL hydration. A controlled, shadowed trigger
  // also tests restoration to the exact control instead of document.body.
  const previousUrl = await page.locator('slide-app').evaluate((app: any) => {
    const host = document.createElement('div');
    host.id = 'gateway-test-trigger';
    const shadow = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    button.textContent = '测试更改网关';
    button.onclick = () => { app.pendingGatewayUrl = 'ws://127.0.0.1:29999/ws'; };
    shadow.append(button);
    document.body.append(host);
    return app.settings.gatewayUrl as string;
  });
  const trigger = page.getByRole('button', { name: '测试更改网关' });
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  return { trigger, previousUrl };
}

for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
  test(`MAX-662 focus entry, both Tab cycles, Escape and restoration ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const { trigger, previousUrl } = await openFromControl(page);
    const confirm = page.getByRole('button', { name: '确认', exact: true });
    const cancel = page.getByRole('button', { name: '取消', exact: true });
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab'); await expect(confirm).toBeFocused();
    await page.keyboard.press('Tab'); await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab'); await expect(confirm).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(cancel).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(confirm).toBeFocused();
    // Native modal prevents even a programmatic attempt to focus the background.
    await trigger.evaluate((button: HTMLElement) => button.focus());
    await expect(confirm).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveAccessibleName('更改 Gateway URL');
    await page.screenshot({ path: testInfo.outputPath(`gateway-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await page.locator('slide-app').evaluate((app: any) => app.settings.gatewayUrl)).toBe(previousUrl);
    expect(await page.locator('slide-app').evaluate((app: any) => app.pendingGatewayUrl)).toBeNull();
  });
}

for (const action of ['确认', '取消']) {
  test(`MAX-662 mouse ${action} saves or discards and restores focus`, async ({ page }) => {
    const { trigger, previousUrl } = await openFromControl(page);
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    const expected = action === '确认' ? nextUrl : previousUrl;
    expect(await page.locator('slide-app').evaluate((app: any) => app.settings.gatewayUrl)).toBe(expected);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('slide.control.settings.v1:default') || '{}'));
    if (action === '确认') expect(saved.gatewayUrl).toBe(expected);
    else expect(saved.gatewayUrl).not.toBe(nextUrl);
  });
}

test('MAX-662 production URL entry and ordinary navigation', async ({ page }) => {
  await page.goto(`/feedback?gatewayUrl=${encodeURIComponent(nextUrl)}`);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: '确认', exact: true })).toBeFocused();
  await expect(page.locator('.exec-approval-command')).toHaveText(nextUrl);
  await expect(page).toHaveURL(/\/feedback$/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('dashboard-header').getByRole('button', { name: 'Slide', exact: true }).click();
  await expect(page.locator('dashboard-page')).toBeVisible();
  await page.goBack();
  await expect(page.locator('feedback-page')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
