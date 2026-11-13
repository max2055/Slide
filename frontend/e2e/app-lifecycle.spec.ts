import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'app-lifecycle-fixture');
    localStorage.setItem('permissions', JSON.stringify(['*']));
  });
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route('**/api/**', route => {
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) return route.fallback();
    return route.fulfill({ json: route.request().url().endsWith('/auth/permissions') ? ['*'] : {} });
  });
}

test('MAX-648: actual lazy view failure stays visible, supports keyboard retry and controlled reload', async ({ page }, testInfo) => {
  await fixture(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let attempts = 0;
  let fail = true;
  await page.route(/\/(?:src\/app\/ui\/views\/agents\.ts|assets\/agents-[^/]+\.js)(?:\?.*)?$/, route => {
    attempts++; return fail ? route.abort('failed') : route.continue();
  });
  await page.goto('/feedback');
  await expect(page.locator('feedback-page')).toBeVisible();
  await page.locator('slide-app').evaluate((app: any) => app.setTab('agents'));
  await expect(page.getByText('页面加载失败，请重试。', { exact: true })).toBeVisible();
  await page.locator('slide-app').evaluate((app: any) => { app.requestUpdate(); app.requestUpdate(); });
  expect(attempts).toBe(1);
  await page.getByRole('button', { name: '重试加载', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('页面加载失败，请重试。', { exact: true })).toBeVisible();
  for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await expect(page.getByRole('button', { name: '重新加载页面', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`lazy-error-${width}.png`) });
  }
  fail = false;
  await page.getByRole('button', { name: '重新加载页面', exact: true }).click();
  await expect(page.getByText('页面加载失败，请重试。', { exact: true })).toHaveCount(0);
  await expect(page.locator('main.content')).toBeVisible();
  await expect.poll(() => attempts).toBe(2);
  await page.locator('slide-app').evaluate((app: any) => app.setTab('feedback'));
  await expect(page.locator('feedback-page')).toBeVisible();
  await page.locator('slide-app').evaluate((app: any) => app.setTab('agents'));
  await expect(page.locator('main.content')).toBeVisible();
  expect(attempts).toBe(2);
  expect(errors).toEqual([]);
});

for (const denial of ['property', 'read', 'write']) {
  test(`MAX-652: actual main entry survives storage ${denial} denial with light defaults`, async ({ page }, testInfo) => {
    await page.route('**/api/**', route => new URL(route.request().url()).pathname.startsWith('/api/')
      ? route.fulfill({ status: 503, json: {} }) : route.fallback());
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(denial => {
      const denied = () => { throw new DOMException('fixture denied', 'SecurityError'); };
      if (denial === 'property') Object.defineProperty(window, 'localStorage', { configurable: true, get: denied });
      else Storage.prototype[denial === 'read' ? 'getItem' : 'setItem'] = denied;
    }, denial);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
    await page.goto('/');
    await expect(page.locator('.login-gate')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-roundness', 'default');
    await page.screenshot({ path: testInfo.outputPath(`storage-${denial}.png`) });
    expect(errors).toEqual([]);
  });
}

test('MAX-654: removed instances ignore navigation, permissions, settings and popstate', async ({ page }) => {
  await fixture(page);
  await page.goto('/feedback');
  await expect(page.locator('feedback-page')).toBeVisible();
  const result = await page.evaluate(async () => {
    const old = document.querySelector('slide-app') as any;
    old.remove();
    let calls = 0;
    old.setTab = () => { calls++; };
    const permissions = old.userPermissions;
    const settings = old.settings;
    const app = document.createElement('slide-app') as any;
    document.body.append(app);
    await app.updateComplete;
    window.dispatchEvent(new CustomEvent('slide-navigate', { detail: { tab: 'feedback' } }));
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: ['servers:view'] } }));
    window.dispatchEvent(new CustomEvent('slide-settings-change', { detail: { accentColor: '#123456' } }));
    window.dispatchEvent(new PopStateEvent('popstate'));
    await app.updateComplete;
    return { calls, permissionsUnchanged: old.userPermissions === permissions, settingsUnchanged: old.settings === settings };
  });
  expect(result).toEqual({ calls: 0, permissionsUnchanged: true, settingsUnchanged: true });
});

for (const tab of ['agents', 'sessions']) {
  test(`MAX-648: ${tab} rejection after switching views stays local`, async ({ page }) => {
    await fixture(page);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let fail!: () => Promise<void>;
    await page.route(new RegExp(`/(?:src/app/ui/views/${tab}\\.ts|assets/${tab}-[^/]+\\.js)(?:\\?.*)?$`), route => {
      fail = () => route.abort('failed');
    });
    await page.goto('/feedback');
    await expect(page.locator('feedback-page')).toBeVisible();
    await page.locator('slide-app').evaluate((app: any, next) => app.setTab(next), tab);
    await expect.poll(() => Boolean(fail)).toBe(true);
    await page.locator('slide-app').evaluate((app: any) => app.setTab('feedback'));
    await fail();
    await expect(page.locator('feedback-page')).toBeVisible();
    await expect(page.getByText('页面加载失败，请重试。', { exact: true })).toHaveCount(0);
    await page.locator('slide-app').evaluate((app: any, next) => app.setTab(next), tab);
    await expect(page.getByText('页面加载失败，请重试。', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('MAX-654: each of four events runs once per connection across reconstruction and repeated reconnects', async ({ page }) => {
  await fixture(page);
  await page.goto('/feedback');
  await expect(page.locator('feedback-page')).toBeVisible();
  const rounds = await page.evaluate(async () => {
    document.querySelector('slide-app')!.remove();
    const app = document.createElement('slide-app') as any;
    const keys = ['navigateHandler', 'popStateHandler', 'permissionsLoadedHandler', 'settingsChangeHandler'];
    const calls: Record<string, number> = Object.fromEntries(keys.map(key => [key, 0]));
    for (const key of keys) {
      const original = app[key];
      app[key] = (...args: unknown[]) => { calls[key]++; return original(...args); };
    }
    const results = [];
    for (let i = 0; i < 3; i++) {
      document.body.append(app);
      await app.updateComplete;
      window.dispatchEvent(new CustomEvent('slide-navigate', { detail: { tab: 'feedback' } }));
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: ['*'] } }));
      window.dispatchEvent(new CustomEvent('slide-settings-change', { detail: { fontDensity: 'compact' } }));
      await app.updateComplete;
      results.push({ calls: { ...calls }, density: document.documentElement.dataset.density });
      app.remove();
      window.dispatchEvent(new CustomEvent('slide-navigate', { detail: { tab: 'dashboard' } }));
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: [] } }));
      window.dispatchEvent(new CustomEvent('slide-settings-change', { detail: { fontDensity: 'standard' } }));
      results.push({ calls: { ...calls }, density: document.documentElement.dataset.density });
    }
    return results;
  });
  for (let i = 0; i < rounds.length; i++) {
    const count = Math.floor(i / 2) + 1;
    expect(rounds[i]).toEqual({ calls: { navigateHandler: count, popStateHandler: count, permissionsLoadedHandler: count, settingsChangeHandler: count }, density: 'compact' });
  }
});

for (const phase of ['before-new-session', 'after-new-session']) {
  test(`MAX-654: detached app does not send pending diagnosis (${phase})`, async ({ page }) => {
    await fixture(page);
    await page.goto('/feedback');
    await expect(page.locator('feedback-page')).toBeVisible();
    const result = await page.evaluate(async phase => {
      const app = document.querySelector('slide-app') as any;
      let resets = 0;
      let sends = 0;
      app.onSlashAction = () => { resets++; if (phase === 'after-new-session') app.remove(); };
      app.client = { sendMessage() { sends++; }, disconnect() {} };
      app.connected = true;
      (window as any).__pendingChatMessage = { text: 'controlled diagnosis sample' };
      window.dispatchEvent(new CustomEvent('slide-navigate', { detail: { tab: 'chat' } }));
      if (phase === 'before-new-session') app.remove();
      await new Promise(resolve => setTimeout(resolve, 0));
      return { resets, sends, retained: (window as any).__pendingChatMessage?.text };
    }, phase);
    expect(result).toEqual({ resets: phase === 'before-new-session' ? 0 : 1, sends: 0, retained: 'controlled diagnosis sample' });
  });
}
