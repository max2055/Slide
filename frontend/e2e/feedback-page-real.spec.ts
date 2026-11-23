import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { FeedbackService } from '../../apps/db-ops-api/src/feedback-service.ts';
import { registerFeedbackRoutes } from '../../apps/db-ops-api/src/feedback-routes.ts';
import { openFeedbackFromSidebar } from './fixtures/feedback-shell.js';

// Explicit opt-in; default CI never reads private credentials or shared databases.
test.skip(process.env.FEEDBACK_REAL_MYSQL !== '1', 'Requires an explicitly injected MySQL connection');
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
let db: any, pool: any, app: any, api: string;
const schema = `slide_feedback_${process.pid}_${randomBytes(4).toString('hex')}`;
const secret = randomBytes(32).toString('hex');
const token = (id: number) => jwt.sign({ userId: id }, secret, { expiresIn: '10m' });
let ownerCanAccessAll = true;

test.beforeAll(async () => {
  const config = JSON.parse(process.env.FEEDBACK_MYSQL_CONNECTION || '{}');
  if (!config.host || !config.port || !config.user || typeof config.password !== 'string') {
    throw new Error('FEEDBACK_MYSQL_CONNECTION must supply host, port, user and password');
  }
  db = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, timezone: 'Z' });
  await db.query(`CREATE DATABASE \`${schema}\``);
  await db.query(`USE \`${schema}\``);
  await db.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY, username VARCHAR(50)) ENGINE=InnoDB');
  await db.query("INSERT INTO users VALUES (7, 'owner'), (8, 'other')");
  for (const migration of ['084_problem_feedback.sql', '085_problem_feedback_status.sql']) {
    await db.query(await readFile(resolve('../apps/db-ops-api/sql/migrations', migration), 'utf8'));
  }
  pool = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password, database: schema, timezone: 'Z' });
  app = require('fastify')();
  // Isolated JWT actor harness; production feedback routes/service and MySQL are real.
  await registerFeedbackRoutes(app, async (request: any, reply: any) => {
    try {
      const claims = jwt.verify((request.headers.authorization || '').replace(/^Bearer /, ''), secret);
      const [users] = await pool.execute('SELECT id, username FROM users WHERE id=?', [claims.userId]);
      if (!users[0]) return reply.code(401).send({ error: 'UNAUTHORIZED' });
      const roles = claims.userId === 7 && ownerCanAccessAll ? ['admin'] : [];
      request.user = { userId: users[0].id, username: users[0].username, roles, permissions: [], instanceScopes: {}, sessionVersion: 1, requestId: 'feedback-real' };
    } catch { return reply.code(401).send({ error: 'UNAUTHORIZED' }); }
  }, new FeedbackService(() => pool));
  api = await app.listen({ host: '127.0.0.1', port: 0 });
});

test.afterAll(async () => {
  await app?.close();
  await pool?.end();
  if (db) {
    await db.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    await db.end();
  }
});

test('MAX-724/MAX-430: real feedback reads, permission downgrade, status rollback and persistence through the sidebar', async ({ page }, info) => {
  const description = '第一行真实反馈\n第二行真实反馈\n第三行完整内容';
  async function createFeedback(userId: number, title: string) {
    const response = await fetch(`${api}/api/feedback`, {
      method: 'POST', headers: { Authorization: `Bearer ${token(userId)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).feedback;
  }
  const feedback = await createFeedback(8, '真实反馈验收');
  const ownFeedback = await createFeedback(7, '自己的反馈');
  const sqlStatus = async () => (await db.execute('SELECT status FROM problem_feedback WHERE id=?', [feedback.id]))[0][0].status;
  let failNextRead = true;
  const writes: string[] = [];
  const readStatuses: number[] = [];
  const listReadAt = new Date(Math.max(Date.now(), Date.parse(feedback.createdAt), Date.parse(ownFeedback.createdAt)));
  await page.clock.setFixedTime(listReadAt);

  // Forward requests to the task-owned Fastify listener instead of a shared API.
  await page.route('**/api/feedback**', async route => {
    const request = route.request();
    if (request.method() === 'GET' && failNextRead) {
      failNextRead = false;
      readStatuses.push(503);
      return route.fulfill({ status: 503, json: { error: 'SERVICE_UNAVAILABLE' } });
    }
    const response = await route.fetch({ url: api + new URL(request.url()).pathname });
    if (request.method() === 'GET') readStatuses.push(response.status());
    else writes.push(request.method());
    await route.fulfill({ response });
  });
  const view = await openFeedbackFromSidebar(page, token(7), ['view_dashboard']);
  const results = view.getByRole('region', { name: '问题反馈列表' });
  const retry = results.getByRole('button', { name: '重试', exact: true });
  const failure = results.getByRole('alert');
  await expect(failure).toContainText('HTTP 503');
  const restored = page.waitForResponse(r => new URL(r.url()).pathname === '/api/feedback' && r.status() === 200);
  await retry.click();
  await restored;
  const select = view.getByRole('combobox', { name: '更新 真实反馈验收 的状态' });
  await expect(select).toHaveValue('pending');
  expect(writes).toEqual([]);
  const toggle = view.getByRole('button', { name: '展开 真实反馈验收 的问题描述' });
  await toggle.press('Enter');
  // The toggle name changes when the row is expanded.
  await expect(view.getByRole('button', { name: '收起 真实反馈验收 的问题描述' })).toHaveAttribute('aria-expanded', 'true');
  await expect(view.getByRole('row').filter({ hasText: '真实反馈验收' }).locator('.feedback-description__text')).toHaveText(description);
  ownerCanAccessAll = false;
  const denied = page.waitForResponse(r => r.request().method() === 'PUT');
  await select.selectOption('resolved');
  expect((await denied).status()).toBe(404);
  await expect(page.getByText('更新问题状态失败', { exact: true })).toBeVisible();
  await expect(select).toHaveValue('pending');
  expect(await sqlStatus()).toBe('pending');
  ownerCanAccessAll = true;
  await expect.poll(Date.now).toBeGreaterThan(listReadAt.getTime() + 1_000);
  const success = page.waitForResponse(r => r.request().method() === 'PUT');
  await select.selectOption('resolved');
  const saved = await success;
  expect(saved.status()).toBe(200);
  const savedAt = (await saved.json()).feedback.updatedAt;
  expect(Date.parse(savedAt)).toBeGreaterThan(listReadAt.getTime());
  await expect(select).toHaveValue('resolved');
  expect(await sqlStatus()).toBe('resolved');

  const feedbackUrl = page.url();
  const readStart = readStatuses.length;
  const writesBeforeRetry = [...writes];
  failNextRead = true;
  await view.getByRole('button', { name: '刷新', exact: true }).press('Enter');
  await expect(failure).toContainText('HTTP 503');
  await expect(failure).toContainText('上次成功读取列表');
  await expect(failure).toContainText('随后保存的结果');
  await expect(failure.locator('time')).toHaveAttribute('datetime', listReadAt.toISOString());
  const savedRow = results.getByRole('row').filter({ hasText: '真实反馈验收' });
  const fromLastRead = results.getByRole('row').filter({ hasText: '自己的反馈' });
  const savedLabel = '读取后已保存';
  await expect(savedRow.getByText('已解决', { exact: true })).toBeVisible();
  await expect(savedRow.getByText(savedLabel, { exact: true })).toBeVisible();
  const savedTimeLabel = await page.evaluate(value => new Date(value).toLocaleString('zh-CN'), savedAt);
  await expect(savedRow.getByRole('cell').nth(7)).toHaveText(savedTimeLabel);
  await expect(fromLastRead.getByText('未接收', { exact: true })).toBeVisible();
  await expect(fromLastRead.getByText(savedLabel, { exact: true })).toHaveCount(0);
  await expect(results.getByRole('combobox')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('saved-status-after-list-503.png') });

  const retryReadAt = new Date(Date.parse(savedAt) + 1_000);
  await page.clock.setFixedTime(retryReadAt);
  await retry.press('Enter');
  await expect(select).toHaveValue('resolved');
  await expect(results).toBeFocused();
  await expect(failure).toHaveCount(0);
  await expect(results.getByText(savedLabel, { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(feedbackUrl);
  expect(readStatuses.slice(readStart)).toEqual([503, 200]);
  expect(writes).toEqual(writesBeforeRetry);
  expect(await sqlStatus()).toBe('resolved');

  failNextRead = true;
  await view.getByRole('button', { name: '刷新', exact: true }).press('Enter');
  await expect(failure).toContainText('HTTP 503');
  await expect(failure).toContainText('显示上次读取成功的记录');
  const nextReadAt = await failure.locator('time').getAttribute('datetime');
  expect(nextReadAt).toBe(retryReadAt.toISOString());
  await expect(savedRow.getByText('已解决', { exact: true })).toBeVisible();
  await expect(results.getByText(savedLabel, { exact: true })).toHaveCount(0);
  expect(writes).toEqual(writesBeforeRetry);

  await page.reload();
  await expect(select).toHaveValue('resolved');
  await page.screenshot({ path: info.outputPath('real-feedback.png'), fullPage: true });
  expect(writes).toEqual(['PUT', 'PUT']);
  ownerCanAccessAll = false;
  failNextRead = true;
  await page.evaluate(() => {
    const permissions = ['view_dashboard'];
    localStorage.setItem('permissions', JSON.stringify(permissions));
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions } }));
  });
  await expect(failure).toContainText('HTTP 503');
  await expect(view.getByText('真实反馈验收', { exact: true })).toHaveCount(0);
  await expect(results.locator('time')).toHaveCount(0);
  await retry.click();
  await expect(results.getByRole('cell', { name: '自己的反馈', exact: true })).toBeVisible();
  await expect(results.getByRole('cell', { name: '真实反馈验收', exact: true })).toHaveCount(0);
  expect(writes).toEqual(['PUT', 'PUT']);
  await page.screenshot({ path: info.outputPath('real-feedback-scoped.png'), fullPage: true });
  const evidence = info.outputPath('real-evidence.json');
  await writeFile(evidence, JSON.stringify({
    browser: page.context().browser()?.version(), viewport: page.viewportSize(),
    databaseVersion: (await db.query('SELECT VERSION() AS version'))[0][0].version,
    create: 201, denied: 404, statusAfterDenial: 'pending', retry: 200, statusAfterReload: await sqlStatus(),
    listRecovery: [503, 200], scopedReadRecovery: [503, 200], writes,
    statusWriteRecovery: { lastSuccessfulReadAt: listReadAt.toISOString(), savedAt, listStatuses: [503, 200],
      savedStatus: 'resolved', savedLabel, unchangedRow: 'pending', nextReadAt, retryWrites: 0, focusRestored: true },
    auth: 'isolated JWT actor harness', storage: 'real MySQL, production feedback migrations/routes/service', modelCalls: 0,
  }, null, 2));
  await info.attach('real-evidence', { contentType: 'application/json', path: evidence });
});
