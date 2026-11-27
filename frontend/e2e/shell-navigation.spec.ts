import { expect, test } from '@playwright/test';

// Actual application and browser history; API/WS fixtures isolate shell routing.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'shell-navigation-fixture');
    localStorage.setItem('permissions', JSON.stringify(['*']));
    localStorage.setItem('slide.control.session_token.v1', 'shell-navigation-fixture');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
  });
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    const body = path === '/api/auth/permissions' ? ['*']
      : path === '/api/version' ? { version: 'shell-fixture' }
      : path === '/api/user/preferences' ? { preferences: { locale: 'zh-CN' } } : {};
    return route.fulfill({ json: body });
  });
});

for (const width of [1366, 1440, 1920]) {
  test(`MAX-649 breadcrumb and MAX-653 history at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1366 ? 768 : width === 1440 ? 900 : 1080 });
    await page.goto('/feedback');
    await expect(page.locator('feedback-page')).toBeVisible();
    const initialLength = await page.evaluate(() => history.length);
    const breadcrumb = page.locator('dashboard-header .dashboard-header__breadcrumb-link');
    if (width === 1440) {
      await breadcrumb.focus();
      await page.keyboard.press('Enter');
    } else await breadcrumb.click();
    await expect(page).toHaveURL(/\/dashboard\?tab=dashboard$/);
    await expect(page.locator('dashboard-page')).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(initialLength + 1);
    await page.goBack();
    await expect(page).toHaveURL(/\/feedback$/);
    await expect(page.locator('feedback-page')).toBeVisible();
    await page.goForward();
    await expect(page.locator('dashboard-page')).toBeVisible();
    await page.locator('.sidebar-utility-group a[href="/feedback"]').click();
    await expect(page.locator('feedback-page')).toBeVisible();
    await page.goBack();
    await expect(page.locator('dashboard-page')).toBeVisible();
    await page.goForward();
    await expect(page.locator('feedback-page')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`shell-${width}.png`) });
  });
}

test('MAX-653 restores session without adding history or replacing the destination URL', async ({ page }) => {
  await page.goto('/feedback');
  await expect(page.locator('feedback-page')).toBeVisible();
  await page.evaluate(() => {
    history.replaceState({}, '', '/feedback?session=restored-session');
    history.pushState({}, '', '/health');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.locator('.sidebar-utility-group a[href="/health"]')).toHaveClass(/nav-item--active/);
  await page.goBack();
  await expect(page.locator('feedback-page')).toBeVisible();
  expect(await page.locator('slide-app').evaluate((app: any) => app.sessionKey)).toBe('restored-session');
  await expect(page).toHaveURL(/\/feedback\?session=restored-session$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/health$/);
  await expect(page.locator('.sidebar-utility-group a[href="/health"]')).toHaveClass(/nav-item--active/);
});

test('permission revocation still hides restricted shell entries after breadcrumb navigation', async ({ page }) => {
  await page.goto('/feedback');
  await expect(page.locator('feedback-page')).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('permissions', JSON.stringify(['servers:view']));
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: ['servers:view'] } }));
  });
  await page.locator('dashboard-header').getByRole('button', { name: 'Slide', exact: true }).click();
  await expect(page.locator('dashboard-page')).toBeVisible();
  await expect(page.locator('.sidebar-nav a[href="/audit"]')).toHaveCount(0);
  await expect(page.locator('.sidebar-nav a[href="/dashboard"]')).toHaveClass(/nav-item--active/);
});

for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`investigation detail stays inside the shell when scrolling past the end at ${width}×${height}`, async ({ page }) => {
    const detail = {
      id: 'scroll-check', sessionId: 'scroll-session', title: '调查详情滚动验证', goal: '核对已保存的调查',
      profileId: 'ops', version: 1, lifecycle: 'open', problemStatus: 'unconfirmed', activeRequestId: null,
      resources: [], owner: { kind: 'user', id: 1 }, createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z',
    };
    await page.route('**/api/investigations**', route => {
      const path = new URL(route.request().url()).pathname;
      const body = path === '/api/investigations' ? { items: [detail], authorizedCounts: { total: 1 }, nextCursor: null }
        : path === `/api/investigations/${detail.id}` ? detail
        : path.endsWith('/workflow') ? { receipts: [], resources: [], suggestions: [], nextBefore: null }
        : path.endsWith('/facts') ? { documents: [], nextBefore: null }
        : { items: [], nextBefore: null };
      return route.fulfill({ json: body });
    });
    await page.route('**/api/operations/actions/plans**', route => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.setViewportSize({ width, height });
    await page.goto(`/workbench?investigation=${detail.id}`);
    await expect(page.getByRole('heading', { name: detail.title })).toBeVisible();
    const main = page.locator('main.content');
    const lastButton = main.getByRole('button', { name: '提交新 Run' });
    await expect(lastButton).not.toBeInViewport();
    const scrollAmount = await main.evaluate(el => el.scrollHeight);
    await main.hover({ position: { x: 10, y: 50 } });
    await page.mouse.wheel(0, scrollAmount);
    await expect.poll(() => main.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
    await expect(lastButton).toBeInViewport({ ratio: 1 });
    const bottomGap = await lastButton.evaluate(button => {
      const card = button.closest('app-card')!;
      const main = card.closest('main')!;
      return main.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom
        - parseFloat(getComputedStyle(main).paddingBottom);
    });
    expect(Math.abs(bottomGap)).toBeLessThanOrEqual(1);
    for (const area of [main, page.locator('.shell-nav')]) {
      await area.hover({ position: { x: 5, y: 10 } });
      await page.mouse.wheel(0, scrollAmount);
      // Wheel scrolling is composited asynchronously; sample after two presented frames.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const bounds = await page.locator('.shell').evaluate(el => ({
        windowY: scrollY, shellTop: el.getBoundingClientRect().top, shellBottom: el.getBoundingClientRect().bottom,
        documentHeight: document.scrollingElement!.scrollHeight, viewport: innerHeight,
      }));
      expect(bounds).toEqual({ windowY: 0, shellTop: 0, shellBottom: height, documentHeight: height, viewport: height });
      await expect(lastButton).toBeInViewport({ ratio: 1 });
    }
  });
}
