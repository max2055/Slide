import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';

// MAX-319 / #662. Requires a disposable MySQL with a dual-password target user.
// Never enable traces/HAR here: connection-test request bodies contain credentials.
test('列表试连：不同有效密码、失败重试、关闭均不保存或重载', async ({ page }, info) => {
  test.setTimeout(90_000);
  if (process.env.MAX319_REAL !== '1') throw new Error('MAX319_REAL disposable environment required');
  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  try {
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.MAX319_ADMIN_PASSWORD } });
    expect(login.status()).toBe(200);
    const session = await login.json();
    const headers = { Authorization: `Bearer ${session.token}` };
    const permissions = await page.request.get('/api/auth/permissions', { headers });
    expect(permissions.status()).toBe(200);
    const created = await page.request.post('/api/database/instances', { headers, data: {
      name: 'MAX319-真实试连', environment: 'testing', db_type: 'mysql', host: process.env.MAX319_TARGET_HOST,
      port: Number(process.env.DB_PORT), username: 'max319_target', password: process.env.MAX319_SAVED_PASSWORD,
      database_name: 'max319_target',
    } });
    expect(created.status()).toBe(200);
    const { id } = await created.json();
    expect(id).toBeGreaterThan(0);
    const snapshot = async () => {
      const [rows] = await db.query('SELECT password_encrypted, updated_at FROM database_instances WHERE id = ?', [id]);
      return JSON.stringify(rows);
    };
    const original = await snapshot();
    await page.addInitScript(({ session, permissions }) => {
      localStorage.setItem('token', session.token); localStorage.setItem('refreshToken', session.refreshToken);
      localStorage.setItem('user', JSON.stringify(session.user)); localStorage.setItem('permissions', JSON.stringify(permissions));
      localStorage.setItem('slide.i18n.locale', 'zh-CN');
    }, { session, permissions: await permissions.json() });
    const traffic: { method: string; path: string; status: number }[] = [];
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith('/api/database/instances')) traffic.push({ method: response.request().method(), path, status: response.status() });
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/instances-db');
    const row = page.locator('instances-page tr').filter({ hasText: 'MAX319-真实试连' });
    const trigger = row.getByRole('button', { name: '测试', exact: true });
    await expect(trigger).toBeVisible();
    const dialog = page.locator('instances-page app-dialog');
    const input = dialog.getByLabel('密码', { exact: true });
    const submit = dialog.getByRole('button', { name: '测试连接', exact: true });
    const close = dialog.getByRole('button', { name: '关闭', exact: true });
    const attempt = async (password: string, success: boolean) => {
      await input.fill(password);
      await input.press('Tab'); await expect(close).toBeFocused();
      await page.keyboard.press('Tab'); await expect(submit).toBeFocused();
      const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/database/instances/test-connection'));
      await page.keyboard.press('Enter');
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      expect((await response.json()).success).toBe(success);
      await expect(dialog.getByText(success ? '连接测试成功' : '用户名或密码错误', { exact: true })).toBeVisible();
      expect(await snapshot() === original, 'saved ciphertext and updated_at unchanged').toBe(true);
    };
    for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await trigger.focus(); await trigger.press('Enter');
      await expect(input).toHaveAccessibleName('密码');
      await expect(submit).toBeEnabled();
      const frame = await dialog.locator('.dialog').boundingBox();
      expect(Boolean(frame && frame.x >= 0 && frame.y >= 0 && frame.x + frame.width <= width && frame.y + frame.height <= height)).toBe(true);
      if (width === 1440) {
        expect(process.env.MAX319_SAVED_PASSWORD !== process.env.MAX319_TEST_PASSWORD).toBe(true);
        await attempt(process.env.MAX319_TEST_PASSWORD!, true);
        await page.screenshot({ path: info.outputPath('real-success-1440.png') });
        await close.click(); await expect(trigger).toBeFocused();
        await trigger.press('Enter');
        await expect(input).toHaveValue('');
        await attempt('MAX319-deliberately-invalid', false);
        await page.screenshot({ path: info.outputPath('real-failure-1440.png') });
        await attempt(process.env.MAX319_TEST_PASSWORD!, true);
      } else {
        await page.screenshot({ path: info.outputPath(`real-dialog-${width}.png`) });
      }
      await close.click(); await expect(trigger).toBeFocused();
    }
    await trigger.press('Enter'); await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '测试连接 - MAX319-真实试连', exact: true })).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.reload(); await expect(trigger).toBeVisible();
    expect(await snapshot() === original, 'persisted credentials remain unchanged after reload').toBe(true);
    expect(traffic.filter(r => r.method !== 'GET').map(r => `${r.method} ${r.path}`))
      .toEqual(Array(3).fill('POST /api/database/instances/test-connection'));
    expect(errors).toEqual([]);
    const evidence = JSON.stringify({ traffic, savedCredentialUnchanged: true,
      realMysqlTests: ['different-valid:success', 'invalid:failure', 'retry:success'], modelCalls: 0 }, null, 2);
    await writeFile(info.outputPath('sanitized-network.json'), evidence);
    await info.attach('sanitized-network.json', { body: evidence, contentType: 'application/json' });
  } finally { await db.end(); }
});
