import { expect, test } from '@playwright/test';

// Component integration in Chromium with a controlled HTTP permission response.
// No production backend or authentication claim is made by this fixture.
test('settings waits for HTTP permissions and unmounts revoked content', async ({ page }) => {
  await page.route('**/settings/access/users', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/permissions', async route => {
    await waiting;
    await route.fulfill({ json: ['admin:*'] });
  });
  await page.goto('/settings/access/users');
  await page.evaluate(async () => {
    localStorage.setItem('token', 'fixture-token');
    localStorage.setItem('permissions', '["*"]');
    await import('/src/app/ui/views/settings-shell.ts');
    document.body.append(document.createElement('settings-shell'));
  });
  await expect(page.locator('app-empty-state')).toHaveAttribute('title', '权限加载中');
  await expect(page.locator('users-management')).toHaveCount(0);
  release();
  await expect(page.locator('users-management')).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: [] } })));
  await expect(page.locator('users-management')).toHaveCount(0);
  await expect(page.locator('app-empty-state')).toHaveAttribute('title', '无权访问');
});

for (const width of [1366, 1440, 1920]) {
  test(`#687: permission errors, denial and keyboard retry at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 1366 ? 768 : width === 1440 ? 900 : 1080 });
    let status = 500;
    let userReads = 0;
    await page.route('**/api/**', async route => {
      if (!new URL(route.request().url()).pathname.startsWith('/api/')) return route.continue();
      if (route.request().url().endsWith('/api/users')) userReads++;
      await route.fulfill({ status, json: status === 200 ? [] : { error: 'controlled permission failure' } });
    });
    await page.route('**/permission-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
    await page.goto('/permission-fixture');
    await page.evaluate(async () => {
      localStorage.setItem('token', 'fixture-token');
      await import('/src/app/styles.css');
      await import('/src/app/ui/views/users-management.ts');
      document.body.append(document.createElement('users-management'));
    });
    const view = page.locator('users-management');
    await expect(view).toContainText('权限检查失败: HTTP 500');
    await expect(view).not.toContainText('需要 admin 角色');
    expect(userReads).toBe(0);
    await page.screenshot({ path: info.outputPath(`failure-${width}.png`) });
    status = 403;
    const retry = view.getByRole('button', { name: '重新检查权限' });
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(view).toContainText('无权限访问此页面，需要 admin 角色');
    await expect(view).not.toContainText('权限检查失败');
    expect(userReads).toBe(0);
    status = 401;
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(view).toContainText('未登录');
    await expect(view).not.toContainText('需要 admin 角色');
    status = 200;
    await page.evaluate(() => (window as any).__apiClient.setToken('new-fixture-token'));
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(view.getByRole('button', { name: '新建用户', exact: true })).toBeVisible();
    await expect(view.locator('app-empty-state')).toHaveAttribute('title', '暂无用户数据');
    expect(userReads).toBe(1);
    await page.screenshot({ path: info.outputPath(`recovered-${width}.png`) });
  });
}
