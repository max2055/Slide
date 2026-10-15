import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';

test.skip(process.env.NOTIFICATION_REAL_SERVICE_E2E !== '1', 'Requires a disposable full API + SQL service');

// Run only against an explicitly provisioned, disposable full API + SQL service.
test('real SQL/JWT/API queue read, empty result, permission revocation and retry', async ({ page }, info) => {
  const database = process.env.DB_NAME ?? '';
  if (!/^db_ops_ai_qualification_max162_\d+$/.test(database)) throw new Error('Disposable MAX-162 database required');
  const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
  const mysql = require('mysql2/promise');
  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database });
  try {
    const login = await page.request.post('/api/auth/login', { data: { username: 'max162-reader', password: process.env.NOTIFICATION_TEST_PASSWORD } });
    expect(login.status()).toBe(200);
    const session = await login.json();
    const permissions = await page.request.get('/api/auth/permissions', { headers: { Authorization: `Bearer ${session.token}` } });
    expect(permissions.status()).toBe(200);
    await page.addInitScript(({ session, permissions }) => {
      localStorage.setItem('token', session.token); localStorage.setItem('refreshToken', session.refreshToken);
      localStorage.setItem('slide.control.session_token.v1', session.token);
      localStorage.setItem('permissions', JSON.stringify(permissions)); localStorage.setItem('user', JSON.stringify(session.user));
      localStorage.setItem('slide.i18n.locale', 'zh-CN');
    }, { session, permissions: await permissions.json() });
    const response = page.waitForResponse(r => r.url().includes('/api/notification/dead-letters'));
    await page.goto('/events?view=notifications');
    expect((await response).status()).toBe(200);
    const view = page.locator('alerts-page');
    await expect(view.locator('tbody tr')).toHaveCount(1); await expect(view).toContainText('max162-real-delivery');
    await page.screenshot({ path: info.outputPath('real-sql-rows.png'), fullPage: true });
    await db.execute("DELETE FROM workflow_jobs WHERE id = 'max162-real-delivery'");
    await view.getByRole('button', { name: '刷新通知投递记录' }).click();
    await expect(view.getByText('没有待重放的通知', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('real-sql-empty.png'), fullPage: true });
    await db.execute("DELETE rp FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id WHERE r.name='max162-reader' AND p.code='notification:view'");
    const forbidden = page.waitForResponse(r => r.url().includes('/api/notification/dead-letters') && r.status() === 403);
    await view.getByRole('button', { name: '刷新通知投递记录' }).click(); await forbidden;
    await expect(view.getByRole('alert')).toContainText('无权查看通知投递记录');
    await page.screenshot({ path: info.outputPath('real-live-403.png'), fullPage: true });
    await db.execute("INSERT INTO role_permissions (role_id,permission_id) SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='notification:view' WHERE r.name='max162-reader'");
    await view.getByRole('button', { name: '重试', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(view.getByText('没有待重放的通知', { exact: true })).toBeVisible();
    await expect(view.getByRole('alert')).toHaveCount(0);
  } finally { await db.end(); }
});
