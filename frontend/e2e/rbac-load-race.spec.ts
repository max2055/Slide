import { test, expect } from '@playwright/test';
// Production components and controlled HTTP responses; no real backend claim.
for (const role of [true, false]) for (const width of [1366, 1440, 1920]) {
  test(`${role ? 'roles' : 'users'} expired load at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 1366 ? 768 : width === 1440 ? 900 : 1080 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    const items = [1, 2].map(id => ({ id, name: `对象${id}`, username: `用户${id}`, code: `db.${id}`, resource: 'db', action: 'read' }));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      if (/\/(roles|users)\/1\//.test(path)) { started(); await gate; }
      const grants = /\/(roles|users)\/[12]\//.test(path);
      const id = path.includes('/1/') ? 1 : 2;
      await route.fulfill({ json: grants ? (role ? [items[id - 1]] : [id]) : items });
    });
    const tag = role ? 'role-management-tab' : 'instance-permissions-tab';
    await page.route('**/race-fixture', route => route.fulfill({ contentType: 'text/html', body: `<html><body><${tag}></${tag}><script type="module">import '/src/app/styles.css';import '/src/app/ui/views/rbac-page.ts';</script></body></html>` }));
    await page.goto('/race-fixture');
    const buttons = page.getByRole('button', { name: role ? '编辑权限' : '实例权限', exact: true });
    await expect(buttons.first()).toBeVisible();
    await buttons.first().click(); await requested;
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await buttons.nth(1).focus(); await page.keyboard.press('Enter');
    const dialog = page.locator('app-dialog');
    await expect(dialog.locator('input[type=checkbox]:checked')).toHaveCount(1);
    const oldResponse = page.waitForResponse(r => /\/(roles|users)\/1\//.test(r.url()));
    release();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(dialog.locator('input[type=checkbox]:checked')).toHaveAttribute('id', role ? 'perm-2' : 'inst-2');
    await page.screenshot({ path: info.outputPath('current-object.png') });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
}
