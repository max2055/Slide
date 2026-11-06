import { expect, test } from '@playwright/test';

for (const width of [1366, 1440, 1920]) test(`multi-role edit ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 1366 ? 768 : 900 });
  const writes: string[] = [];
  let roles = [2, 3];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (request.method() !== 'GET') {
      writes.push(request.method() + ' ' + path);
      if (request.method() === 'DELETE') roles = roles.filter(id => id !== Number(path.split('/').pop()));
      if (request.method() === 'POST') roles.push(request.postDataJSON().roleId);
      return route.fulfill({ json: { success: true } });
    }
    return route.fulfill({ json: path === '/api/users'
      ? [{ id: 42, username: 'dual', email: 'before@example.test', status: 'active' }]
      : path.endsWith('/42/roles') ? roles.map(id => ({ role_id: id, role_name: id === 2 ? 'dba' : 'auditor' }))
      : [{ id: 2, name: 'dba' }, { id: 3, name: 'auditor' }, { id: 4, name: 'viewer' }] });
  });
  await page.route('**/users-role-fixture', route => route.fulfill({ contentType: 'text/html', body:
    '<html><body><users-management></users-management><script type="module">import "/src/app/styles.css"; import "/src/app/ui/views/users-management.ts";</script></body></html>' }));
  await page.goto('/users-role-fixture');
  const edit = page.getByRole('button', { name: '编辑', exact: true });
  await edit.click();
  await expect(page.getByRole('checkbox', { name: '数据库管理员' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '审计员' })).toBeChecked();
  await page.getByLabel('邮箱').fill('after@example.test');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual(['PUT /api/users/42']);
  await edit.click();
  await page.getByRole('checkbox', { name: '数据库管理员' }).uncheck();
  await page.getByRole('checkbox', { name: '观察者' }).check();
  await page.screenshot({ path: info.outputPath('selection.png') });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(writes).toHaveLength(1);
  await edit.click();
  await expect(page.getByRole('checkbox', { name: '数据库管理员' })).toBeChecked();
  await page.getByRole('checkbox', { name: '数据库管理员' }).uncheck();
  await page.getByRole('checkbox', { name: '观察者' }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(roles).toEqual([3, 4]);
});
