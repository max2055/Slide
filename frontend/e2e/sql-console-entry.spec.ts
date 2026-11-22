import { expect, test, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import { qualificationMysqlTarget, qualificationPassword } from './qualification-credentials.js';

const atPath = (path: string) => (response: Response) => new URL(response.url()).pathname === path;

// The isolated qualification service receives real credentials when provisioning the target.
test.use({ trace: 'off', locale: 'zh-CN' });

test('SQL workbench editor restores comment drafts from the operations menu and recovers from initialization failure', async ({ page }) => {
  const target = qualificationMysqlTarget();
  const queryRequests: string[] = [];
  const pageErrors: string[] = [];
  await page.addInitScript(() => localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' })));
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route(/\/api\/(?:database\/instances\/\d+\/(execute|explain)|approval\/submit)(?:\?|$)/, route => {
    queryRequests.push(route.request().method());
    return route.abort();
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard');
  await page.locator('.login-gate input[autocomplete="username"]').fill('admin');
  await page.locator('.login-gate input[autocomplete="current-password"]').fill(qualificationPassword());
  const [login] = await Promise.all([
    page.waitForResponse(atPath('/api/auth/login')),
    page.locator('.login-gate__connect').click(),
  ]);
  expect(login.status()).toBe(200);
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  const created = await page.request.post('/api/database/instances', { headers, data: {
    name: `qualification-sql-editor-${Date.now()}`, environment: 'testing', db_type: 'mysql', ...target,
  } });
  expect(created.status()).toBe(200);
  const { id } = await created.json();
  const instancePath = `/api/database/instances/${id}`;
  const table = `qualification_columns_${randomUUID().replaceAll('-', '')}`;
  const duplicateSchema = `${table}_copy`;
  const primaryTable = `${target.database_name}.${table}`;
  let db: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;

  try {
    db = await mysql.createConnection({ host: target.host, port: target.port, user: target.username, password: target.password });
    await db.query('CREATE TABLE ?? (id INT, `编号` INT, `名称` VARCHAR(32))', [primaryTable]);
    await db.query('CREATE DATABASE ??', [duplicateSchema]);
    await db.query('CREATE TABLE ?? (id INT, `编号` INT, `状态` INT)', [`${duplicateSchema}.${table}`]);
    const reloaded = await page.request.post(`${instancePath}/reload`, { headers });
    expect(reloaded.status()).toBe(200);

    const navigation = page.locator('.sidebar-nav');
    const menu = navigation.getByRole('link', { name: 'SQL 工作台' });
    const away = navigation.locator('a[href="/dashboard"]');
    const workbench = page.locator('sql-console-page');
    const instance = workbench.locator('.toolbar select').first();
    const editor = workbench.locator('.cm-content[contenteditable="true"]');
    const execute = workbench.getByRole('button', { name: /^执行/ });
    const explain = workbench.getByRole('button', { name: '分析计划' });
    const firstTab = workbench.getByText('标签 1', { exact: true });
    const secondTab = workbench.getByText('标签 2', { exact: true });
    const activeTab = workbench.locator('.tab.active .tab-label');

    const [instances] = await Promise.all([page.waitForResponse(atPath('/api/database/instances')), menu.click()]);
    expect(instances.status()).toBe(200);
    const [databases, schema] = await Promise.all([
      page.waitForResponse(atPath(`${instancePath}/databases`)),
      page.waitForResponse(atPath(`${instancePath}/schema-objects`)),
      instance.selectOption(String(id)),
    ]);
    expect(databases.status()).toBe(200);
    expect((await databases.json()).includes(target.database_name)).toBe(true);
    expect(schema.status()).toBe(200);
    expect((await schema.json()).some((item: { schema: string; tables: unknown[] }) =>
      item.schema === target.database_name && item.tables.length > 0)).toBe(true);
    await expect(workbench.locator('.table-name').first()).toBeVisible();

    await expect(editor).toBeVisible();
    await test.step('Complete and insert a unique column after a table name or a SQL alias', async () => {
      const candidates = page.getByRole('listbox');
      const column = candidates.getByRole('option').filter({ has: page.getByText('编号', { exact: true }) });
      for (const sql of [`SELECT ${table}.`, `SELECT 1 FROM ${table} AS q WHERE q.`]) {
        await editor.pressSequentially(sql);
        await expect(column).toHaveCount(1);
        await expect(column).toBeVisible();
        await expect(candidates.getByText('名称', { exact: true })).toBeVisible();
        await expect(candidates.getByText('状态', { exact: true })).toBeVisible();
        await column.click();
        await expect(editor).toHaveText(`${sql}编号`);
        await editor.press('ControlOrMeta+a');
        await editor.press('Backspace');

        await editor.pressSequentially(sql);
        await expect(column).toBeVisible();
        await editor.pressSequentially('编');
        await expect(column).toBeVisible();
        await expect(candidates.getByRole('option')).toHaveCount(1);
        await expect(column).toHaveAttribute('aria-selected', 'true');
        // CodeMirror delays keyboard acceptance for 75 ms after the popup opens.
        await page.waitForTimeout(75);
        await editor.press('Enter');
        await expect(editor).toHaveText(`${sql}编号`);
        await editor.press('ControlOrMeta+a');
        await editor.press('Backspace');
      }
    });
    await editor.pressSequentially('-- 草稿 1');
    await editor.press('ArrowLeft');
    await editor.press('A');
    await expect(editor).toHaveText('-- 草稿 A1');
    await editor.press('ControlOrMeta+a');
    await editor.press('Backspace');
    await expect(editor).toBeEmpty();

    const firstDraft = '-- 第一份草稿';
    const secondDraft = '-- 第二份草稿';
    await editor.pressSequentially(firstDraft);
    await editor.evaluate(node => node.setAttribute('data-mount-probe', 'first'));
    await workbench.locator('.tab-add').click();
    await editor.pressSequentially(secondDraft);
    await editor.evaluate(node => node.setAttribute('data-mount-probe', 'second'));
    await firstTab.click();
    await expect(editor).toHaveText(firstDraft);
    await expect(editor).toHaveAttribute('data-mount-probe', 'first');
    await secondTab.click();
    await expect(editor).toHaveText(secondDraft);
    await expect(editor).toHaveAttribute('data-mount-probe', 'second');
    await expect(workbench.locator('.cm-editor')).toHaveCount(1);

    // Switching without editing must persist the selected tab.
    await firstTab.click();
    await away.click();
    await expect(workbench).toHaveCount(0);
    await menu.click();
    await expect(activeTab).toHaveText('标签 1');
    await expect(editor).toHaveText(firstDraft);
    await secondTab.click();
    await expect(editor).toHaveText(secondDraft);

    // Fail the next state construction in the real application, including in the built app.
    await workbench.evaluate(element => {
      const prototype = Object.getPrototypeOf(element);
      const sqlLanguage = prototype._sqlLanguage;
      prototype._sqlLanguage = () => {
        prototype._sqlLanguage = sqlLanguage;
        throw new Error('Controlled SQL editor initialization failure');
      };
    });
    await away.click();
    await expect(workbench).toHaveCount(0);
    await page.setViewportSize({ width: 1366, height: 768 });
    await menu.click();
    await expect(activeTab).toHaveText('标签 2');
    await expect(workbench.getByRole('alert')).toContainText('SQL 编辑器初始化失败');
    await expect(instance).toHaveValue(String(id));
    await expect(editor).toHaveCount(0);
    await expect(execute).toBeDisabled();
    await expect(explain).toBeDisabled();
    await expect(workbench.getByRole('button', { name: '格式化' })).toBeDisabled();
    await instance.press('Control+Enter');
    await instance.press('Meta+Enter');
    for (const button of [execute, explain]) {
      await button.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    }
    await workbench.getByRole('button', { name: '历史', exact: true }).click();
    await expect(workbench.getByRole('combobox', { name: '查询历史实例' })).toBeVisible();
    expect(queryRequests).toEqual([]);

    const retry = workbench.getByRole('button', { name: '重试初始化' });
    await expect(retry).toBeInViewport();
    await retry.press('Enter');
    await expect(activeTab).toHaveText('标签 2');
    await expect(workbench.getByRole('alert')).toHaveCount(0);
    await expect(workbench.locator('.cm-editor')).toHaveCount(1);
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText(secondDraft);
    await editor.press('End');
    await editor.pressSequentially(' 已恢复');
    await expect(editor).toHaveText(`${secondDraft} 已恢复`);
    await expect(execute).toBeEnabled();
    await expect(explain).toBeEnabled();

    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(editor).toBeInViewport();
    await expect(execute).toBeInViewport();
    expect(queryRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    try {
      if (db) {
        await db.query('DROP TABLE IF EXISTS ??', [primaryTable]);
        await db.query('DROP DATABASE IF EXISTS ??', [duplicateSchema]);
      }
    } finally {
      await db?.end();
      const removed = await page.request.delete(instancePath, { headers }).catch(() => undefined);
      expect.soft(removed?.status(), '清理隔离测试实例').toBe(200);
    }
  }
});
