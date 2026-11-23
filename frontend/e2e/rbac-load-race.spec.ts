import { test, expect, type Route } from '@playwright/test';
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
    const cancelled = role ? page.waitForEvent('requestfailed', request => /\/roles\/1\/permissions$/.test(request.url())) : undefined;
    await page.getByRole('button', { name: '取消', exact: true }).click();
    if (cancelled) expect((await cancelled).failure()?.errorText).toContain('ERR_ABORTED');
    await buttons.nth(1).focus(); await page.keyboard.press('Enter');
    const dialog = page.locator('app-dialog');
    await expect(dialog.locator('input[type=checkbox]:checked')).toHaveCount(1);
    const oldResponse = role ? undefined : page.waitForResponse(r => /\/users\/1\//.test(r.url()));
    release();
    if (oldResponse) await (await oldResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(dialog.locator('input[type=checkbox]:checked')).toHaveAttribute('id', role ? 'perm-2' : 'inst-2');
    await page.screenshot({ path: info.outputPath('current-object.png') });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
}

test('MAX-730 retries the same role and distinguishes a failed read from valid empty results', async ({ page }) => {
  const permissions = [1, 2].map(id => ({ id, name: `权限${id}`, code: `db.${id}`, resource: 'db', action: 'read' }));
  const reads: string[] = [];
  const writes: string[] = [];
  let catalogue = (route: Route) => route.fulfill({ body: '<html>invalid JSON</html>', status: 200 });
  let grants = (route: Route) => route.fulfill({ json: [permissions[0]] });
  await page.route('**/api/v1/rbac/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method !== 'GET') {
      writes.push(method);
      return route.fulfill({ status: 500 });
    }
    if (path.endsWith('/roles')) return route.fulfill({ json: [{ id: 1, name: '值班角色' }] });
    reads.push(path);
    return path.endsWith('/roles/1/permissions') ? grants(route) : catalogue(route);
  });
  await page.route('**/role-read-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: `<html><body><role-management-tab></role-management-tab><script type="module">
      import '/src/app/styles.css'; import '/src/app/ui/views/rbac-page.ts';
    </script></body></html>`,
  }));
  await page.goto('/role-read-fixture');
  const open = page.getByRole('button', { name: '编辑权限', exact: true });
  await open.click();

  await expect(page.getByRole('dialog', { name: '编辑权限 - 值班角色' })).toBeVisible();
  const dialog = page.locator('role-management-tab app-dialog');
  const retry = dialog.getByRole('button', { name: '重试读取' });
  const save = dialog.getByRole('button', { name: '保存权限' });
  const empty = dialog.getByText('暂无权限数据');
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('权限清单读取失败');
  await expect(dialog).not.toContainText(/JSON|Unexpected|invalid/);
  await expect(empty).toHaveCount(0);
  await expect(dialog.locator('input[type=checkbox]')).toHaveCount(0);
  await expect(save).toBeDisabled();

  await expect.poll(() => reads.length).toBe(2);
  catalogue = route => route.fulfill({ json: permissions });
  grants = route => route.fulfill({ status: 503, json: { error: 'controlled read failure' } });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(alert).toContainText('角色授权读取失败');
  await expect(retry).toBeFocused();
  await expect(empty).toHaveCount(0);
  await expect(save).toBeDisabled();

  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  grants = async route => { await pending; await route.fulfill({ json: [] }); };
  try {
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('status')).toContainText('正在读取角色权限');
    await expect(retry).toHaveCount(0);
    await expect(save).toBeDisabled();
    await page.keyboard.press('Enter');
    await expect.poll(() => reads.length).toBe(6);
  } finally {
    release();
  }
  const group = dialog.locator('summary');
  await expect(group).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await expect(save).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();

  catalogue = route => route.fulfill({ json: [] });
  await open.click();
  await expect(empty).toBeVisible();
  await expect(save).toBeEnabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(reads.filter(path => path.endsWith('/roles/1/permissions'))).toHaveLength(4);
  expect(reads.filter(path => path === '/api/v1/rbac/permissions')).toHaveLength(4);
  expect(writes).toEqual([]);
});
