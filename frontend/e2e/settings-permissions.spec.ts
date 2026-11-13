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
