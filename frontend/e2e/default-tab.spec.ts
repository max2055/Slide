import { expect, test, type Page } from '@playwright/test';

// Production shell + API client, controlled preference responses; no live account/model.
async function fixture(page: Page, local = 'dashboard') {
  await page.addInitScript(defaultTab => {
    (window as any).__settingsApplied = 0;
    window.addEventListener('slide-settings-applied', () => { (window as any).__settingsApplied++; });
    localStorage.setItem('token', 'default-tab-fixture');
    localStorage.setItem('permissions', '["*"]');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ defaultTab, locale: 'zh-CN', themeMode: 'light' }));
  }, local);
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  const releases: Array<(tab: string) => Promise<void>> = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (path === '/api/user/preferences' && request.method() === 'GET') {
      const tab = await new Promise<string>(resolve => {
        releases.push(async tab => { resolve(tab); });
      });
      return route.fulfill({ json: { preferences: { defaultTab: tab, locale: 'zh-CN', themeMode: 'light' } } });
    }
    return route.fulfill({ json: path === '/api/auth/permissions' ? ['*'] : path === '/api/version' ? { version: 'fixture' } : {} });
  });
  return {
    async ready(count = 1) { await expect.poll(() => releases.length).toBe(count); },
    async release(tab: string, index = 0) {
      const applied = await page.evaluate(() => (window as any).__settingsApplied);
      await releases[index](tab);
      // The stale generation intentionally never applies settings.
      if (index === releases.length - 1) {
        await expect.poll(() => page.evaluate(() => (window as any).__settingsApplied)).toBeGreaterThan(applied);
      }
    },
  };
}

async function settled(page: Page, tab: string) {
  await expect.poll(() => page.locator('slide-app').evaluate((app: any) => app.settings.defaultTab)).toBe(tab);
}

for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
  test(`MAX-659 delayed root default and keyboard navigation ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const prefs = await fixture(page);
    await page.goto('/');
    await prefs.ready();
    await expect(page.locator('dashboard-page')).toBeVisible();
    const length = await page.evaluate(() => history.length);
    await prefs.release('feedback');
    await expect(page.locator('feedback-page')).toBeVisible();
    await settled(page, 'feedback');
    expect(await page.evaluate(() => history.length)).toBe(length);
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
    const link = page.locator('.sidebar-nav a[href="/dashboard"]');
    await expect(link).toBeInViewport();
    await link.focus();
    await expect(link).toBeFocused();
    await page.screenshot({ path: info.outputPath(`default-tab-${width}.png`) });
    await page.keyboard.press('Enter');
    await expect(page.locator('dashboard-page')).toBeVisible();
    await page.goBack();
    await expect(page.locator('feedback-page')).toBeVisible();
  });
}

for (const returnToInitial of [false, true]) {
  test(`MAX-659 manual navigation wins (return=${returnToInitial})`, async ({ page }) => {
    const prefs = await fixture(page);
    await page.goto('/');
    await prefs.ready();
    await page.locator('.sidebar-utility-group a[href="/feedback"]').click();
    await expect(page.locator('feedback-page')).toBeVisible();
    if (returnToInitial) await page.goBack();
    const url = page.url();
    const history = await page.evaluate(() => window.history.length);
    await prefs.release('settings');
    await settled(page, 'settings');
    await expect(page).toHaveURL(url);
    expect(await page.evaluate(() => window.history.length)).toBe(history);
    await expect(page.locator(returnToInitial ? 'dashboard-page' : 'feedback-page')).toBeVisible();
  });
}

test('MAX-659 equal defaults do not refresh or add history', async ({ page }) => {
  const prefs = await fixture(page, 'feedback');
  await page.goto('/');
  await prefs.ready();
  await expect(page.locator('feedback-page')).toBeVisible();
  await page.locator('feedback-page').evaluate(el => { (el as any).__identity = 'preserved'; });
  const history = await page.evaluate(() => window.history.length);
  await prefs.release('feedback');
  await settled(page, 'feedback');
  expect(await page.locator('feedback-page').evaluate(el => (el as any).__identity)).toBe('preserved');
  expect(await page.evaluate(() => window.history.length)).toBe(history);
});

for (const server of ['dashboard', 'not-a-tab', 'server-detail']) {
  test(`MAX-659 validates synced default ${server}`, async ({ page }) => {
    const prefs = await fixture(page, 'feedback');
    await page.goto('/');
    await prefs.ready();
    await expect(page.locator('feedback-page')).toBeVisible();
    await prefs.release(server);
    await settled(page, server);
    await expect(page.locator(server === 'dashboard' ? 'dashboard-page' : 'feedback-page')).toBeVisible();
  });
}

for (const path of ['/feedback?sample=deep', '/settings/appearance', '/?tab=feedback']) {
  test(`MAX-659 preserves deep link ${path}`, async ({ page }) => {
    const prefs = await fixture(page);
    await page.goto(path);
    await prefs.ready();
    await expect.poll(() => page.locator('slide-app').evaluate((app: any) => app.tab)).toBe(path.includes('appearance') ? 'settings' : 'feedback');
    const url = page.url();
    await prefs.release('dashboard');
    await settled(page, 'dashboard');
    await expect(page).toHaveURL(url);
  });
}

test('MAX-659 reconnect ignores old delayed response and preserves the new deep link', async ({ page }) => {
  const prefs = await fixture(page);
  await page.goto('/');
  await prefs.ready();
  await page.evaluate(() => {
    const app = document.querySelector('slide-app')!;
    app.remove();
    history.replaceState({}, '', '/feedback');
    document.body.append(app);
  });
  await prefs.ready(2);
  await prefs.release('settings', 1);
  await settled(page, 'settings');
  const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/user/preferences') && response.request().method() === 'GET');
  await prefs.release('chat', 0);
  // Wait for the stale GET to finish, then a render turn.
  await oldResponse;
  await page.locator('slide-app').evaluate(async (app: any) => { await app.updateComplete; });
  await settled(page, 'settings');
  await expect(page.locator('feedback-page')).toBeVisible();
  await expect(page).toHaveURL(/\/feedback$/);
});
