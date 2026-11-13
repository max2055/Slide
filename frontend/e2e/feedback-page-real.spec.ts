import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { FeedbackService } from '../../apps/db-ops-api/src/feedback-service.ts';
import { registerFeedbackRoutes } from '../../apps/db-ops-api/src/feedback-routes.ts';

// Explicit opt-in; default CI never reads private credentials or shared databases.
test.skip(process.env.FEEDBACK_REAL_MYSQL !== '1', 'Requires an explicitly injected MySQL connection');
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
let db: any, pool: any, app: any, api: string;
const schema = `slide_max430_${process.pid}`;
const secret = randomBytes(32).toString('hex');
const token = (id: number) => jwt.sign({ userId: id }, secret, { expiresIn: '10m' });

test.beforeAll(async () => {
  const config = JSON.parse(process.env.FEEDBACK_MYSQL_CONNECTION || '{}');
  if (!config.host || !config.port || !config.user || typeof config.password !== 'string') {
    throw new Error('FEEDBACK_MYSQL_CONNECTION must supply host, port, user and password');
  }
  db = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password });
  await db.query(`CREATE DATABASE \`${schema}\``);
  await db.query(`USE \`${schema}\``);
  await db.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY, username VARCHAR(50)) ENGINE=InnoDB');
  await db.query("INSERT INTO users VALUES (7, 'owner'), (8, 'other')");
  for (const migration of ['084_problem_feedback.sql', '085_problem_feedback_status.sql']) {
    await db.query(await readFile(resolve('../apps/db-ops-api/sql/migrations', migration), 'utf8'));
  }
  pool = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password, database: schema });
  app = require('fastify')();
  // Isolated JWT actor harness; production feedback routes/service and MySQL are real.
  await registerFeedbackRoutes(app, async (request: any, reply: any) => {
    try {
      const claims = jwt.verify((request.headers.authorization || '').replace(/^Bearer /, ''), secret);
      const [users] = await pool.execute('SELECT id, username FROM users WHERE id=?', [claims.userId]);
      if (!users[0]) return reply.code(401).send({ error: 'UNAUTHORIZED' });
      request.user = { userId: users[0].id, username: users[0].username, roles: [], permissions: [], instanceScopes: {}, sessionVersion: 1, requestId: 'max430-real' };
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

test('real feedback routes/MySQL: create, display, expand, denied write rollback, successful retry and reload', async ({ page }, info) => {
  const description = '第一行真实反馈\n第二行真实反馈\n第三行完整内容';
  const created = await fetch(`${api}/api/feedback`, {
    method: 'POST', headers: { Authorization: `Bearer ${token(7)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '真实反馈验收', description }),
  });
  expect(created.status).toBe(201);
  const { feedback } = await created.json();
  const sqlStatus = async () => (await db.execute('SELECT status FROM problem_feedback WHERE id=?', [feedback.id]))[0][0].status;
  // Forward requests to the task-owned Fastify listener instead of a shared API.
  await page.route('**/api/feedback**', async route => {
    const response = await route.fetch({ url: api + new URL(route.request().url()).pathname });
    await route.fulfill({ response });
  });
  await page.route('**/feedback-real', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
    <link rel="stylesheet" href="/src/app/styles.css"></head><body><feedback-page></feedback-page><app-toast-container></app-toast-container>
    <script type="module" src="/src/app/ui/views/feedback-page.ts"></script></body></html>` }));
  await page.addInitScript(ownerToken => localStorage.setItem('token', ownerToken), token(7));
  await page.goto('/feedback-real');
  const select = page.getByRole('combobox', { name: '更新 真实反馈验收 的状态' });
  await expect(select).toHaveValue('pending');
  const toggle = page.locator('.description-toggle');
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.feedback-description__text')).toHaveText(description);
  await page.evaluate(otherToken => localStorage.setItem('token', otherToken), token(8));
  const denied = page.waitForResponse(r => r.request().method() === 'PUT');
  await select.selectOption('resolved');
  expect((await denied).status()).toBe(404);
  await expect(page.getByText('更新问题状态失败', { exact: true })).toBeVisible();
  await expect(select).toHaveValue('pending');
  expect(await sqlStatus()).toBe('pending');
  await page.evaluate(ownerToken => localStorage.setItem('token', ownerToken), token(7));
  const success = page.waitForResponse(r => r.request().method() === 'PUT');
  await select.selectOption('resolved');
  expect((await success).status()).toBe(200);
  await expect(select).toHaveValue('resolved');
  expect(await sqlStatus()).toBe('resolved');
  await page.reload();
  await expect(select).toHaveValue('resolved');
  await page.screenshot({ path: info.outputPath('real-feedback.png'), fullPage: true });
  const evidence = info.outputPath('real-evidence.json');
  await writeFile(evidence, JSON.stringify({
    schema, api, databaseVersion: (await db.query('SELECT VERSION() AS version'))[0][0].version,
    create: 201, denied: 404, statusAfterDenial: 'pending', retry: 200, statusAfterReload: await sqlStatus(),
    auth: 'isolated JWT actor harness', storage: 'real MySQL, production feedback migrations/routes/service', modelCalls: 0,
  }, null, 2));
  await info.attach('real-evidence', { contentType: 'application/json', path: evidence });
});
