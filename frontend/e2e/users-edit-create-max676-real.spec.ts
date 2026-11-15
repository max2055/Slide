import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Explicit local acceptance only. Credentials are injected, never collected by unit tests.
test.skip(process.env.MAX676_REAL !== '1', 'Requires explicit isolated MySQL acceptance');
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt'), dotenv = require('dotenv');
const schema = `db_ops_ai_qualification_max676_${process.pid}`;
const password = randomBytes(24).toString('hex');
const children: ChildProcess[] = [];
let output: string, db: any, userId: number;
const report: any = { schema, modelCalls: 0, checks: [], processes: [], ports: { api: 3676, agent: 29676, vite: 5676 } };

async function start(args: string[], env: Record<string, string>, cwd: string, label: string) {
  const log = await open(resolve(output, `${label}.private.log`), 'w', 0o600);
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', log.fd, log.fd] });
  children.push(child);
  await log.close();
  report.processes.push({ pid: child.pid, cwd, command: [process.execPath, ...args], label });
  return child;
}
async function ready(url: string, child: ChildProcess) {
  await expect.poll(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned process exited; inspect private log');
    try { return (await fetch(url)).status; } catch { return 0; }
  }, { timeout: 90_000 }).toBe(200);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  for (const key of ['MAX676_PROFILES_FILE', 'SLIDE_DEBUG_ENV_FILE', 'MAX676_EVIDENCE_DIR']) {
    if (!process.env[key]) throw new Error(`Missing explicit ${key}`);
  }
  output = resolve(process.env.MAX676_EVIDENCE_DIR!);
  await mkdir(output, { recursive: true });
  const profiles = JSON.parse(await readFile(process.env.MAX676_PROFILES_FILE!, 'utf8'));
  const connection = profiles['mysql-test'];
  if (Number(connection.port) !== 3308) throw new Error('Acceptance requires mysql-test on 3308');
  const cfg = dotenv.parse(await readFile(process.env.SLIDE_DEBUG_ENV_FILE!));
  db = await mysql.createConnection(connection);
  report.database = { host: connection.host, port: connection.port, version: (await db.query('SELECT VERSION() AS version'))[0][0].version };
  await db.query(`CREATE DATABASE \`${schema}\``);
  const apiDir = resolve('../apps/db-ops-api');
  const env = {
    DB_HOST: connection.host, DB_PORT: String(connection.port), DB_USER: connection.user, DB_PASSWORD: connection.password,
    DB_NAME: schema, PORT: '3676', AGENT_WS_PORT: '29676', NODE_ENV: 'test',
    JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: cfg.ENCRYPTION_KEY,
    PROMPT_HOT_RELOAD: 'false',
  };
  const init = await start(['--import', 'tsx', 'init-db.ts'], env, apiDir, 'migration');
  expect(await new Promise(done => init.once('exit', done))).toBe(0);
  await db.query(`USE \`${schema}\``);
  const [user] = await db.execute("INSERT INTO users(username,password_hash,status) VALUES('max676-test',?,'active')", [await bcrypt.hash(password, 10)]);
  userId = user.insertId;
  await db.execute("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='admin'", [userId]);
  // Read encrypted provider rows solely for full application startup. No model request.
  const source = await mysql.createConnection(profiles['slide-platform']);
  try {
    for (const table of ['llm_providers', 'llm_scene_bindings']) {
      const [rows] = await source.query('SELECT * FROM ??', [table]);
      const [columns] = await db.query('SHOW COLUMNS FROM ??', [table]);
      const names = new Set(columns.map((column: any) => column.Field));
      await db.query('DELETE FROM ??', [table]);
      for (const row of rows) {
        const copy = Object.fromEntries(Object.entries(row).filter(([key]) => names.has(key)).map(([key, value]) =>
          [key, value && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value]));
        await db.query('INSERT INTO ?? SET ?', [table, copy]);
      }
    }
  } finally { await source.end(); }
  const api = await start(['--import', 'tsx', 'server.ts'], env, apiDir, 'api');
  await ready('http://127.0.0.1:3676/api/health/ready', api);
  const vite = await start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5676', '--strictPort'], {
    VITE_API_PROXY_TARGET: 'http://127.0.0.1:3676', VITE_AGENT_WS_PROXY_TARGET: 'http://127.0.0.1:29676',
    VITE_AGENT_WS_URL: 'ws://127.0.0.1:29676',
  }, resolve('.'), 'vite');
  await ready('http://127.0.0.1:5676', vite);
});

test.afterAll(async () => {
  const cleanupErrors: string[] = [];
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill('SIGTERM');
      await new Promise<void>(done => {
        const timer = setTimeout(done, 5000);
        child.once('exit', () => { clearTimeout(timer); done(); });
      });
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise(done => child.once('exit', done));
      }
    } catch { cleanupErrors.push(`Failed to stop owned PID ${child.pid}`); }
  }
  report.processesStopped = children.every(child => child.exitCode !== null || child.signalCode !== null);
  if (db) {
    try { await db.query(`DROP DATABASE IF EXISTS \`${schema}\``); report.cleaned = true; }
    catch { cleanupErrors.push('Failed to drop owned schema'); }
    finally { await db.end(); }
  }
  report.cleanupErrors = cleanupErrors;
  if (output) await writeFile(resolve(output, 'real-result.json'), JSON.stringify(report, null, 2));
  expect(cleanupErrors).toEqual([]);
});


test('#625 / #686: real persistence and recoverable role binding', async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('slide.i18n.locale', 'zh-CN'));
  await page.goto('/settings/access/users', { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill('max676-test');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const view = page.locator('users-management');
  await expect(view.locator('.table')).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const headers = { Authorization: 'Bearer ' + token };
  const create = await page.request.post('/api/users', { headers, data: { username: 'max676-existing', password, email: 'before@example.test' } });
  expect(create.status()).toBe(201);
  const target = (await create.json()).userId;
  const profile = async () => (await db.execute('SELECT email,status FROM users WHERE id=?', [target]))[0][0];
  // MAX-676 D1: both profile fields and session invalidation must commit together.
  expect((await page.request.post('/api/auth/login', { data: { username: 'max676-existing', password } })).status()).toBe(200);
  await db.execute('INSERT INTO refresh_tokens(user_id,token_hash,expires_at,revoked) VALUES(?,?,NOW()+INTERVAL 1 DAY,TRUE)', [target, randomBytes(32).toString('hex')]);
  const snapshot = async () => ({
    user: (await db.execute('SELECT email,status,session_version FROM users WHERE id=?', [target]))[0][0],
    tokens: (await db.execute('SELECT * FROM refresh_tokens WHERE user_id=? ORDER BY id', [target]))[0].map((row: any) => {
      const { revoked, ...metadata } = row;
      return { id: row.id, session_version: row.session_version, revoked,
        metadataHash: createHash('sha256').update(JSON.stringify(metadata)).digest('hex') };
    }),
  });
  const beforeFailure = await snapshot();
  expect(beforeFailure.tokens.some((row: any) => !row.revoked)).toBe(true);
  expect(beforeFailure.tokens.some((row: any) => row.revoked)).toBe(true);
  await db.query(`CREATE TRIGGER max676_reject_email BEFORE UPDATE ON users FOR EACH ROW BEGIN IF OLD.id=${target} AND NOT (NEW.email <=> OLD.email) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='max676 controlled email failure'; END IF; END`);
  const rejectedEmail = await page.request.put('/api/users/' + target, { headers, data: { status: 'inactive', email: '' } });
  expect([400,500]).toContain(rejectedEmail.status());
  expect(await snapshot()).toEqual(beforeFailure);
  await db.query('DROP TRIGGER max676_reject_email');
  // A later failure in refresh token revocation must roll back the user UPDATE too.
  await db.query(`CREATE TRIGGER max676_reject_revoke BEFORE UPDATE ON refresh_tokens FOR EACH ROW BEGIN IF OLD.id=${beforeFailure.tokens.find((row: any) => row.revoked).id} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='max676 controlled revoke failure'; END IF; END`);
  const rejectedRevoke = await page.request.put('/api/users/' + target, { headers, data: { status: 'inactive', email: '' } });
  expect([400,500]).toContain(rejectedRevoke.status());
  expect(await snapshot()).toEqual(beforeFailure);
  await db.query('DROP TRIGGER max676_reject_revoke');
  expect((await page.request.put('/api/users/' + target, { headers, data: { status: 'inactive', email: '' } })).status()).toBe(200);
  const recovered = await snapshot();
  expect(recovered.user).toEqual({ email: '', status: 'inactive', session_version: beforeFailure.user.session_version + 1 });
  expect(recovered.tokens).toEqual(beforeFailure.tokens.map((row: any) => ({ ...row, revoked: 1 })));
  const sameSessions = await snapshot();
  expect((await page.request.put('/api/users/' + target, { headers, data: { email: 'before@example.test' } })).status()).toBe(200);
  const emailOnly = await snapshot();
  expect(emailOnly.user).toEqual({ ...sameSessions.user, email: 'before@example.test' });
  expect(emailOnly.tokens).toEqual(sameSessions.tokens);
  report.atomicProfile = { beforeFailure, recovered, emailOnly, rejectedEmailStatus: rejectedEmail.status(), rejectedRevokeStatus: rejectedRevoke.status() };
  report.checks.push('D1 real MySQL email UPDATE failure and refresh revocation failure each preserve status/email/session_version/all refresh token flags; recovery commits fields + session increment + revocation; email-only preserves session behavior');
  const update = await page.request.put('/api/users/' + target, { headers, data: { status: 'inactive' } });
  expect(update.status()).toBe(200);
  expect(await profile()).toMatchObject({ email: 'before@example.test', status: 'inactive' });
  // Email-only update must not stringify an absent status or change it.
  expect((await page.request.put('/api/users/' + target, { headers, data: { email: 'before@example.test' } })).status()).toBe(200);
  expect((await profile()).status).toBe('inactive');
  await page.reload();
  const edit = view.getByRole('row').filter({ hasText: 'max676-existing' }).getByRole('button', { name: '编辑', exact: true });
  await edit.click();
  await view.getByLabel('邮箱', { exact: true }).fill('');
  await view.getByRole('button', { name: '保存', exact: true }).click();
  await expect(view.getByRole('dialog')).toHaveCount(0);
  expect(await profile()).toMatchObject({ email: '', status: 'inactive' });
  await edit.click(); await expect(view.getByLabel('邮箱', { exact: true })).toHaveValue('');
  await view.getByRole('button', { name: '取消', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(view.getByRole('dialog')).toHaveCount(0);
  await expect(edit).toBeFocused();
  report.checks.push('#625 email: explicit empty persisted and reopened empty; omitted email retained; email-only retained inactive status; keyboard cancel/focus passed');
  const [role] = await db.execute("INSERT INTO roles(name,description,is_system) VALUES('max676-role','before',0)");
  const roleId = role.insertId;
  await page.goto('/settings/access/users?view=roles');
  const roleRow = page.getByRole('row').filter({ hasText: 'max676-role' });
  await roleRow.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByPlaceholder('可选角色说明').fill('');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await db.execute('SELECT description FROM roles WHERE id=?', [roleId]))[0][0].description).toBe('');
  await roleRow.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByPlaceholder('可选角色说明')).toHaveValue('');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  report.checks.push('#625 role description: real PUT, SQL empty string and reopened empty');
  await page.goto('/settings/access/users');
  await expect(view.locator('.table')).toBeVisible();
  const writes: any[] = [];
  page.on('request', req => {
    const path = new URL(req.url()).pathname;
    if (req.method() === 'POST' && (path === '/api/users' || /rbac\/users\/\d+\/roles$/.test(path))) writes.push({ path, body: path === '/api/users' ? { username: req.postDataJSON().username } : req.postDataJSON() });
  });
  await db.query(`CREATE TRIGGER max676_reject_role BEFORE INSERT ON user_roles FOR EACH ROW BEGIN IF NEW.role_id=${roleId} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='max676 controlled binding failure'; END IF; END`);
  await view.getByRole('button', { name: /新建用户/ }).click();
  await view.getByLabel('用户名', { exact: true }).fill('max676-created');
  await view.getByLabel('密码', { exact: true }).fill(password);
  await view.getByLabel('角色', { exact: true }).selectOption(String(roleId));
  await view.getByRole('button', { name: '保存', exact: true }).click();
  await expect(view.locator('.save-error')).toContainText('用户已创建');
  await expect(view.locator('.save-error')).toContainText('角色未绑定');
  await expect(view.getByRole('dialog')).toBeVisible();
  await expect(view.getByLabel('用户名', { exact: true })).toBeDisabled();
  const [created] = await db.query("SELECT id FROM users WHERE username='max676-created'");
  expect(created).toHaveLength(1);
  const createdId = created[0].id;
  expect((await db.execute('SELECT * FROM user_roles WHERE user_id=?', [createdId]))[0]).toHaveLength(0);
  await view.getByRole('button', { name: '重试绑定', exact: true }).click();
  await expect.poll(() => writes.length).toBe(3);
  await expect(view.getByRole('button', { name: '重试绑定', exact: true })).toBeEnabled();
  for (const [width,height] of [[1440,900],[1366,768],[1920,1080]]) {
    await page.setViewportSize({ width,height });
    const rect = await view.getByRole('button', { name: '重试绑定', exact: true }).boundingBox();
    expect(rect).not.toBeNull(); expect(rect!.y + rect!.height).toBeLessThanOrEqual(height);
    await page.screenshot({ path: info.outputPath(`role-failure-${width}.png`) });
  }
  await db.query('DROP TRIGGER max676_reject_role');
  await view.getByRole('button', { name: '重试绑定', exact: true }).click();
  await expect(view.getByRole('dialog')).toHaveCount(0);
  await expect(view.getByRole('row').filter({ hasText: 'max676-created' })).toContainText('max676-role');
  const bindings = (await db.execute('SELECT user_id,role_id FROM user_roles WHERE user_id=?', [createdId]))[0];
  expect(bindings).toEqual([{ user_id: createdId, role_id: roleId }]);
  expect(writes.map(w => w.path)).toEqual(['/api/users', ...Array(3).fill(['/api/v1/rbac/users', createdId, 'roles'].join('/'))]);
  expect((await db.query("SELECT COUNT(*) AS count FROM users WHERE username='max676-created'"))[0][0].count).toBe(1);
  report.writes = writes; report.bindings = bindings;
  report.checks.push('#686 controlled real MySQL failure twice: dialog retained, Chinese partial-success message, retry only existing userId, one user, final binding visible; 3 desktop sizes');
  // Real permission boundaries: anonymous and newly created unprivileged user.
  const lowerLogin = await page.request.post('/api/auth/login', { data: { username: 'max676-created', password } });
  expect(lowerLogin.status()).toBe(200);
  const lower = { Authorization: 'Bearer ' + (await lowerLogin.json()).token };
  expect((await page.request.put('/api/users/' + target, { headers: lower, data: { email: 'attack@example.test' } })).status()).toBe(403);
  expect((await page.request.post(['/api/v1/rbac/users', createdId, 'roles'].join('/'), { headers: lower, data: { roleId } })).status()).toBe(403);
  expect((await page.request.put('/api/users/' + target, { data: { email: '' } })).status()).toBe(401);
  expect((await profile()).email).toBe('');
  for (const data of [{ email: null }, { email: [] }, { email: {} }, { status: '' }, { status: 'invalid' }, { role: 'admin' }]) {
    expect((await page.request.put('/api/users/' + target, { headers, data })).status()).toBe(400);
  }
  report.checks.push('real JWT 403 for non-admin email/binding; anonymous 401; malformed email/status and unknown role 400; SQL unchanged');
});
