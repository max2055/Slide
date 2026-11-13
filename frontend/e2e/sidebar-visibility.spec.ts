import { expect, test } from '@playwright/test';

// MAX-661 / #650: production build, controlled HTTP/WS preferences.
for (const width of [1366, 1440, 1920]) test(`last tab remains hidden across reopen and refresh at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 1366 ? 768 : width === 1440 ? 900 : 1080 });
  let preferences: Record<string, unknown> = { locale: 'zh-CN', visibleTabs: [] };
  await page.addInitScript(() => {
    localStorage.setItem('token', 'sidebar-fixture');
    localStorage.setItem('permissions', JSON.stringify(['*']));
    localStorage.setItem('slide.control.session_token.v1', 'sidebar-fixture');
  });
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/user/preferences') {
      if (route.request().method() === 'PUT') {
        preferences = route.request().postDataJSON().preferences;
        return route.fulfill({ json: { success: true } });
      }
      return route.fulfill({ json: { preferences } });
    }
    return route.fulfill({ json: path === '/api/auth/permissions' ? ['*'] : {} });
  });
  await page.goto('/settings/platform/appearance');
  const view = page.locator('appearance-settings');
  const toggles = view.locator('app-card').filter({ has: page.locator('div[slot="header"]', { hasText: '侧边栏标签' }) }).locator('app-toggle button');
  // The default/legacy [] is all-visible until the first explicit edit.
  await expect(toggles.first()).toHaveAttribute('aria-pressed', 'true');
  const count = await toggles.count(); expect(count).toBeGreaterThan(10);
  for (let i = 0; i < count; i++) {
    const saved = page.waitForResponse(r => r.url().endsWith('/api/user/preferences') && r.request().method() === 'PUT');
    if (i === count - 1) { await toggles.nth(i).focus(); await page.keyboard.press('Space'); }
    else await toggles.nth(i).click();
    expect((await saved).status()).toBe(200);
    await expect(toggles.nth(i)).toHaveAttribute('aria-pressed', 'false');
  }
  expect(preferences).toMatchObject({ visibleTabs: [], visibleTabsConfigured: true });
  await expect(page.locator('.shell-nav a.nav-item')).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: info.outputPath(`hidden-${width}.png`) });
  await page.goto('/feedback');
  // Existing search remains an accessible recovery path when every sidebar tab is hidden.
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.getByText('个人设置', { exact: true }).click();
  await expect(page.locator('settings-shell')).toBeVisible();
  await page.goto('/settings/platform/appearance');
  await expect(toggles.first()).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(toggles.first()).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.shell-nav a.nav-item')).toHaveCount(0);
  // Server response wins even when the local record has no list or marker.
  await page.evaluate(() => localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' })));
  await page.reload();
  await expect(toggles.first()).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.shell-nav a.nav-item')).toHaveCount(0);
  const servers = view.locator('app-toggle').filter({ hasText: '服务器' }).locator('button');
  await servers.click();
  await expect(servers).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.shell-nav a.nav-item')).toHaveCount(1);
  await page.evaluate(() => {
    localStorage.setItem('permissions', JSON.stringify([]));
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: [] } }));
  });
  await expect(page.locator('.shell-nav a.nav-item')).toHaveCount(0);
});
