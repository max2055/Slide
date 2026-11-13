import { expect, test } from '@playwright/test';

// Production build and shell; controlled HTTP/WS samples. Real API coverage
// is opt-in in platform-status-real.spec.ts, with a task-owned MySQL schema.
const children = 'health-center-page, platform-observations-page, agent-sandbox-status-page';
async function setup(page: import('@playwright/test').Page, permissions: unknown) {
  await page.addInitScript(grants => {
    localStorage.setItem('token', 'platform-status-fixture');
    if (grants !== null) localStorage.setItem('permissions', JSON.stringify(grants));
    localStorage.setItem('slide.control.session_token.v1', 'platform-status-fixture');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', theme: 'light' }));
  }, permissions);
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (path === '/api/auth/permissions') return route.fulfill({ json: permissions ?? [] });
    if (path === '/api/user/preferences') return route.fulfill({ json: { preferences: { locale: 'zh-CN' } } });
    // Explicit failure sample avoids representing fabricated health as real.
    return route.fulfill({ status: 503, json: { error: '受控服务不可用样本' } });
  });
}
async function grant(page: import('@playwright/test').Page, values: string[]) {
  await page.evaluate(permissions => {
    localStorage.setItem('permissions', JSON.stringify(permissions));
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions } }));
  }, values);
}
for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
  test(`#667 production history, direct view and keyboard ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height }); await setup(page, ['*']);
    await page.goto('/health?view=observations');
    const status = page.locator('platform-status-page');
    await expect(status.locator('platform-observations-page')).toBeVisible();
    const tabs = status.getByRole('tab');
    await expect(status.getByRole('tablist')).toHaveAccessibleName('平台状态');
    await expect(tabs).toHaveCount(3);
    const health = status.getByRole('tab', { name: '平台自检', exact: true });
    await health.focus(); await expect(health).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(status.locator('health-center-page')).toBeVisible();
    await expect(page).toHaveURL(/view=health/);
    await page.keyboard.press('Tab');
    await expect(status.getByRole('tab', { name: '平台观测', exact: true })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(status.locator('platform-observations-page')).toBeVisible();
    await status.getByRole('tab', { name: 'Agent 沙箱', exact: true }).click();
    await expect(status.locator('agent-sandbox-status-page')).toBeVisible();
    await page.goBack(); await expect(status.getByRole('tab', { name: '平台观测', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(status.locator('platform-observations-page')).toBeVisible();
    await page.goBack(); await expect(status.locator('health-center-page')).toBeVisible();
    await page.goForward(); await expect(status.locator('platform-observations-page')).toBeVisible();
    await page.goForward(); await expect(status.locator('agent-sandbox-status-page')).toBeVisible();
    for (const tab of await tabs.all()) {
      const box = await tab.boundingBox(); expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: info.outputPath(`platform-${width}.png`) });
    await page.reload(); await expect(status.locator('agent-sandbox-status-page')).toBeVisible();
  });
}
for (const view of ['health', 'observations', 'sandbox']) {
  test(`#436 direct ${view} with no grants mounts no child`, async ({ page }) => {
    await setup(page, []); await page.goto(`/health?view=${view}`);
    const status = page.locator('platform-status-page');
    await expect(status.locator('app-empty-state')).toHaveAttribute('title', '无权限访问平台状态');
    await expect(status.locator(children)).toHaveCount(0);
    await expect(status.getByRole('tab')).toHaveCount(0);
  });
}
test('#436 live revocation and restoration keeps only legal options', async ({ page }, info) => {
  await setup(page, ['*']); await page.goto('/health?view=sandbox&keep=1');
  const status = page.locator('platform-status-page');
  await expect(status.locator('agent-sandbox-status-page')).toBeVisible();
  await grant(page, ['config:view']);
  await expect(status.locator('health-center-page')).toBeVisible();
  await expect(page).toHaveURL(/view=health&keep=1/);
  await expect(status.getByRole('tab')).toHaveCount(2);
  await grant(page, []); await expect(status.locator(children)).toHaveCount(0);
  await expect(status.getByRole('status')).toBeVisible();
  await page.screenshot({ path: info.outputPath('platform-no-permission.png') });
  await grant(page, ['audit:view']); await expect(status.locator('agent-sandbox-status-page')).toBeVisible();
  await expect(status.getByRole('tab')).toHaveCount(0);
  await page.goBack(); // permission never resurrects a denied child
  await expect(status.locator('health-center-page, platform-observations-page')).toHaveCount(0);
});
test('#667 production navigation disconnects, reconnects and releases listeners', async ({ page }) => {
  await setup(page, ['*']); await page.goto('/health?view=sandbox');
  await expect(page.locator('agent-sandbox-status-page')).toBeVisible();
  // Keep the actual production-mounted instance to inspect detached behavior.
  await page.locator('platform-status-page').evaluate((element: any) => { (window as any).detachedStatus = element; });
  await page.locator('dashboard-header').getByRole('button', { name: 'Slide', exact: true }).click();
  await expect(page.locator('platform-status-page')).toHaveCount(0);
  await grant(page, []);
  expect(await page.evaluate(() => (window as any).detachedStatus.activeView)).toBe('sandbox');
  await page.goBack();
  await expect(page.locator('platform-status-page app-empty-state')).toHaveAttribute('title', '无权限访问平台状态');
  await expect(page.locator(`platform-status-page`).locator(children)).toHaveCount(0);
  await grant(page, ['*']); await expect(page.locator('agent-sandbox-status-page')).toBeVisible();
  // Reconnect that same instance inside its production parent, refreshing state.
  await page.locator('platform-status-page').evaluate(element => {
    const old = (window as any).detachedStatus;
    history.replaceState({}, '', '/health?view=observations'); element.replaceWith(old);
  });
  await expect(page.locator('platform-status-page platform-observations-page')).toBeVisible();
});
test('#436 missing storage stays denied until permissions arrive', async ({ page }) => {
  await setup(page, null);
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  await page.route('**/api/auth/permissions', async route => { await pending; await route.fulfill({ json: ['config:view', 'audit:view'] }); });
  try {
    await page.goto('/health?view=sandbox', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('platform-status-page').locator(children)).toHaveCount(0);
    await expect(page.locator('platform-status-page app-empty-state')).toBeVisible();
  } finally { release(); }
  await expect(page.locator('agent-sandbox-status-page')).toBeVisible();
});

test('#667 leaving status never rewrites another page view on history navigation', async ({ page }) => {
  await setup(page, ['*']);
  await page.goto('/settings/monitoring/metrics?view=audit');
  await page.goto('/health?view=observations');
  await expect(page.locator('platform-observations-page')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/settings\/monitoring\/metrics\?view=audit$/);
  await expect(page.locator('platform-status-page')).toHaveCount(0);
});
