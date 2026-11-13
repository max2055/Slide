/** MAX-413: opt-in MySQL + real JWT/Fastify/SQL executor + Lit/Chromium acceptance.
 * CRON_ACCEPTANCE_PROFILE_FILE selects a local connection profile, never a default DB.
 * CRON_ACCEPTANCE_OUTPUT must name a task-owned evidence directory.
 * No scheduler, model, mocks or shared service lifecycle changes.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import { dbConnection } from '../src/db-connection.js';
import { databaseService } from '../src/database-service.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import { createOwnedDatabase } from '../src/testing/owned-fixture.js';
import { actorContextService, signAccessToken } from '../src/auth/actor-context.js';
import { createVerifyToken } from '../src/auth-middleware.js';
import { registerCronRoutes } from '../src/cron/cron-routes.js';
import { registerInstanceListRoutes } from '../src/instance-list-routes.js';

assert(process.env.CRON_ACCEPTANCE_PROFILE_FILE, 'explicit connection profile required');
assert(process.env.CRON_ACCEPTANCE_OUTPUT, 'explicit evidence directory required');
const directory = resolve(process.env.CRON_ACCEPTANCE_OUTPUT);
mkdirSync(directory, { recursive: true });
const profile = JSON.parse(readFileSync(process.env.CRON_ACCEPTANCE_PROFILE_FILE, 'utf8'))['mysql-test'];
assert.equal(profile.port, 3308, 'only the authorized test MySQL is supported');
const config = { host: profile.host, port: profile.port, user: profile.user, password: profile.password };
const root = mysql.createPool({ ...config, connectTimeout: 3000, connectionLimit: 2 });
const nonce = randomBytes(8).toString('hex');
const app = Fastify();
let owned: Awaited<ReturnType<typeof createOwnedDatabase>> | undefined;
let browser: any, vite: any;
let phase = 'connect';
const checks: string[] = [];
let testExit = 0, cleanupExit = 0;
try {
  await root.query('SELECT 1');
  owned = await createOwnedDatabase(root as any, { nonce, purpose: 'cronpage', handleDir: directory });
  assert(await dbConnection.initialize({ ...config, database: owned.database }));
  const pool = dbConnection.getPool()!;
  phase = 'migrate'; const started = Date.now();
  await new MigrationRunner(pool as any).run();
  writeFileSync(resolve(directory, 'migration.json'), JSON.stringify({ elapsedMs: Date.now() - started, complete: true }));
  phase = 'seed';
  // The schema is owned by this run; remove only its migration-seeded tasks.
  await pool.query('DELETE FROM cron_jobs');
  await pool.query("INSERT INTO users(id,username,password_hash) VALUES(7413,'cron-page-tester','no-login')");
  await pool.query("INSERT INTO roles(id,name) VALUES(7413,'cron-page-fixture')");
  await pool.query('INSERT INTO role_permissions(role_id,permission_id) SELECT 7413,id FROM permissions');
  await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(7413,7413)');
  await pool.query("INSERT INTO database_instances(id,name,host,port,database_name,username,password_encrypted) VALUES(7413,'Cron 独占测试库',?,?,?,'fixture','unused')", [profile.host, profile.port, owned.database]);
  assert(await databaseService.addConnection(7413, 'Cron 独占测试库', { ...config, db_type: 'mysql', database: owned.database }));
  const actor = await actorContextService.loadActiveActor(7413);
  // Use one secret for the token and the production verification middleware.
  const secret = randomBytes(32).toString('hex');
  const accessToken = signAccessToken(actor, secret);
  const verify = createVerifyToken(secret);
  registerCronRoutes(app, verify, () => undefined);
  registerInstanceListRoutes(app, verify);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const { createServer } = await import('../../../frontend/node_modules/vite/dist/node/index.js');
  vite = await createServer({ configFile: false, root: resolve('../../frontend'), server: { host: '127.0.0.1', port: 0, proxy: { '/api': address } } });
  await vite.listen();
  const req = createRequire(resolve('../../frontend/package.json'));
  const { chromium, expect } = req('@playwright/test');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.addInitScript(({ accessToken, permissions }) => {
    localStorage.setItem('token', accessToken);
    localStorage.setItem('permissions', JSON.stringify(permissions));
  }, { accessToken, permissions: actor.permissions });
  // Host document only; every API request goes to production routes and real MySQL.
  await page.route('**/max413-fixture', (route: any) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><cron-jobs-settings></cron-jobs-settings><script type="module">import "/src/app/styles.css"; import "/src/app/ui/views/cron-jobs-settings.ts";</script></body></html>' }));
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  await page.goto(`${origin}/max413-fixture`);
  const create = page.getByRole('button', { name: '+ 新建任务', exact: true });
  const cancel = page.getByRole('button', { name: '取消', exact: true });
  phase = 'empty-layout';
  for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await expect(create).toBeEnabled(); await expect(page.getByText('暂无定时任务', { exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(directory, `empty-${width}.png`) });
    await create.focus(); await page.keyboard.press('Enter');
    const save = page.getByRole('button', { name: '创建任务', exact: true });
    await expect(save).toBeInViewport(); await expect(cancel).toBeInViewport();
    await page.screenshot({ path: resolve(directory, `dialog-${width}.png`) });
    await cancel.click(); await expect(create).toBeFocused();
  }
  checks.push('#427 first empty list, keyboard entry, cancel/focus and three desktop sizes');
  phase = 'create';
  await create.click();
  await page.getByLabel('任务名称', { exact: true }).fill('首个真实任务');
  await page.getByLabel('任务内容（自然语言）', { exact: true }).fill('检查数据库实例的运行状态并输出报告');
  await page.getByLabel('Cron 表达式', { exact: true }).fill('invalid cron');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByText('无效的 cron 表达式', { exact: true })).toBeVisible();
  await page.getByLabel('Cron 表达式', { exact: true }).fill('0 0 1 1 *');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.locator('.table-row')).toContainText('首个真实任务');
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByText('暂无定时任务', { exact: true })).toBeVisible();
  await create.click(); await expect(page.getByLabel('任务名称', { exact: true })).toBeVisible(); await cancel.click();
  checks.push('#427 actual create rejection, success and deletion of last persisted job');
  phase = 'draft';
  const [before] = await pool.query<any[]>('SELECT id FROM cron_scripts ORDER BY id');
  await create.click(); await page.getByLabel('执行模式', { exact: true }).selectOption('script');
  await page.getByLabel('目标实例', { exact: true }).selectOption('7413');
  await page.locator('script-editor').evaluate((editor: HTMLElement) => editor.dispatchEvent(new CustomEvent('content-change', { detail: { content: 'SELECT 413 AS verified' }, bubbles: true, composed: true })));
  await page.getByPlaceholder('例如：information_schema').fill(owned.database);
  await page.getByRole('button', { name: '测试执行', exact: true }).click();
  await expect(page.locator('pre.log-entry__result')).toContainText('413');
  await expect(page.locator('pre.log-entry__result')).toContainText('"success": true');
  await cancel.click();
  const [after] = await pool.query<any[]>('SELECT id FROM cron_scripts ORDER BY id');
  assert.deepEqual(after, before);
  checks.push('#654 real draft SELECT succeeded; script library IDs unchanged after close');
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  let response = await fetch(`${address}/api/cron/scripts`, { headers, method: 'POST', body: JSON.stringify({ name: 'saved script', content: 'SELECT 1 AS old_value', target_db_type: 'mysql' }) });
  assert.equal(response.status, 201); const scriptId = (await response.json() as any).id;
  response = await fetch(`${address}/api/cron/jobs`, { headers, method: 'POST', body: JSON.stringify({ name: '已保存脚本任务', task_description: 'SELECT 1 AS old_value', task_type: 'script', script_id: scriptId, target_instance_id: 7413, cron_expr: '0 0 1 1 *' }) });
  assert.equal(response.status, 201);
  await page.reload(); await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.locator('script-editor .cm-content')).toContainText('SELECT 1');
  await page.locator('script-editor').evaluate((editor: HTMLElement) => editor.dispatchEvent(new CustomEvent('content-change', { detail: { content: 'SELECT 654 AS updated' }, bubbles: true, composed: true })));
  await page.getByPlaceholder('例如：information_schema').fill(owned.database);
  await page.getByRole('button', { name: '测试执行', exact: true }).click();
  await expect(page.locator('pre.log-entry__result')).toContainText('654'); await cancel.click();
  const [updated] = await pool.query<any[]>('SELECT id,content FROM cron_scripts WHERE id=?', [scriptId]);
  assert.deepEqual(updated, [{ id: scriptId, content: 'SELECT 654 AS updated' }]);
  checks.push('#654 saved script updated and executed under the same persisted ID');
  phase = 'authorization';
  await pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON rp.permission_id=p.id WHERE rp.role_id=7413 AND p.code <> 'cron:view'");
  response = await fetch(`${address}/api/cron/scripts/test`, { headers, method: 'POST', body: JSON.stringify({ instance_id: 7413, content: 'SELECT 1' }) });
  assert.equal(response.status, 403);
  await page.evaluate(() => { localStorage.setItem('permissions', JSON.stringify(['cron:view'])); window.dispatchEvent(new Event('slide-permissions-loaded')); });
  await expect(create).toBeDisabled();
  await pool.query('DELETE FROM role_permissions WHERE role_id=7413');
  await page.reload(); await expect(page.getByText('加载定时任务失败', { exact: true })).toBeVisible();
  await expect(page.getByText('暂无定时任务', { exact: true })).toHaveCount(0);
  checks.push('real JWT permission revocation rejects draft execution and list load; no empty-state masking');
  assert.deepEqual(errors, []);
} catch (error) {
  testExit = 1; console.error('acceptance failed at', phase, error instanceof Error ? error.message : 'unknown');
} finally {
  try {
    await browser?.close(); await vite?.close(); await app.close();
    await databaseService.removeConnection(7413); await dbConnection.close();
    if (owned) await owned.drop(); await root.end();
  } catch (error) { cleanupExit = 1; console.error('cleanup failed; ownership handle retained', error instanceof Error ? error.message : 'unknown'); }
  writeFileSync(resolve(directory, 'acceptance.json'), JSON.stringify({ nonce, phase, checks, testExit, cleanupExit, modelCalls: 0 }, null, 2));
}
process.exitCode = testExit || cleanupExit;
