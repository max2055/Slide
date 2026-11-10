import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Opt-in real Fastify/JWT/MySQL acceptance. Never mutates the source schema.
test.skip(process.env.MAX354_REAL !== '1', 'Requires authorized local MySQL access');
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt'), dotenv = require('dotenv');
const output = resolve('../outputs/max354-acceptance/real');
const schema = `db_ops_ai_qualification_max354_${process.pid}`;
const password = randomBytes(24).toString('hex');
const children: ChildProcess[] = [];
let db: any, userId: number, targetId: number, roleId: number;
const perms: number[] = [], instances: number[] = [];
const report: any = { schema, modelCalls: 0, checks: [], processes: [], ports: { api: 3194, agent: 28994, vite: 5194 } };
async function start(command: string, args: string[], env: any, cwd: string, label: string) {
  const log = await open(`${output}/${label}.private.log`, 'w', 0o600);
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', log.fd, log.fd] });
  await log.close(); children.push(child);
  report.processes.push({ pid: child.pid, cwd, command: [command, ...args], label });
  return child;
}
async function ready(url: string, child: ChildProcess) {
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error('Owned process exited; inspect private log');
    try { return (await fetch(url)).status; } catch { return 0; }
  }, { timeout: 90000 }).toBe(200);
}
test.beforeAll(async () => {
  test.setTimeout(180000);
  await mkdir(output, { recursive: true });
  const cfg = dotenv.parse(await readFile(process.env.SLIDE_DEBUG_ENV_FILE!));
  const connection = { host: cfg.DB_HOST || '127.0.0.1', port: Number(cfg.DB_PORT || 3306), user: cfg.DB_USER, password: cfg.DB_PASSWORD };
  db = await mysql.createConnection(connection);
  report.database = { host: connection.host, port: connection.port, version: (await db.query('SELECT VERSION() AS version'))[0][0].version };
  await db.query(`CREATE DATABASE \`${schema}\``);
  const apiDir = resolve('../apps/db-ops-api');
  const env = { ...cfg, DB_NAME: schema, PORT: '3194', AGENT_WS_PORT: '28994', NODE_ENV: 'test', JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: cfg.ENCRYPTION_KEY };
  const init = await start(process.execPath, ['--import', 'tsx', 'init-db.ts'], env, apiDir, 'migration');
  expect(await new Promise(done => init.once('exit', done))).toBe(0);
  await db.query(`USE \`${schema}\``);
  const [user] = await db.execute("INSERT INTO users(username,password_hash,status) VALUES('max354-test',?,'active')", [await bcrypt.hash(password, 10)]);
  userId = user.insertId;
  await db.execute("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='admin'", [userId]);
  const [target] = await db.execute("INSERT INTO users(username,password_hash,status,email) VALUES('max354-dual',?,'active','before@example.test')", [await bcrypt.hash(password, 10)]);
  targetId = target.insertId;
  await db.execute("INSERT INTO user_roles(user_id,role_id,grant_expiry) SELECT ?,id,'2030-01-01 00:00:00' FROM roles WHERE name IN ('dba','auditor')", [targetId]);
  await db.query('UPDATE llm_providers SET enabled=FALSE,is_default=FALSE');
  const [role] = await db.execute("INSERT INTO roles(name) VALUES('max354-role')");
  roleId = role.insertId;
  for (let n = 1; n <= 4; n++) {
    const [p] = await db.execute('INSERT INTO permissions(code,name,resource,action) VALUES(?,?,?,?)', [`max354:${n}`, `权限${n}`, 'max354', String(n)]);
    perms.push(p.insertId);
    const [i] = await db.execute("INSERT INTO database_instances(name,host,port,database_name,username,password_encrypted) VALUES(?,'127.0.0.1',3306,?,'fixture','unused')", [`实例${n}`, `max354-${n}`]);
    instances.push(i.insertId);
  }
  const api = await start(process.execPath, ['--import', 'tsx', 'server.ts'], env, apiDir, 'api');
  await ready('http://127.0.0.1:3194/api/health/ready', api);
  const vite = await start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5194', '--strictPort'], { VITE_API_PROXY_TARGET: 'http://127.0.0.1:3194', VITE_AGENT_WS_PROXY_TARGET: 'http://127.0.0.1:28994', VITE_AGENT_WS_URL: 'ws://127.0.0.1:28994' }, resolve('.'), 'vite');
  await ready('http://127.0.0.1:5194', vite);
});
test.afterAll(async () => {
  for (const child of children.reverse()) if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(done, 5000))]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(done => child.once('exit', done)); }
  }
  report.processesStopped = children.every(child => child.exitCode !== null || child.signalCode !== null);
  if (db) {
    try { await db.query(`DROP DATABASE IF EXISTS \`${schema}\``); report.cleaned = true; }
    catch { report.cleaned = false; }
    finally { await db.end(); }
  }
  await writeFile(`${output}/real-result.json`, JSON.stringify(report, null, 2));
});

for (const kind of ['role', 'instance'] as const) test(`MAX-354/MAX-356 real ${kind} partial save`, async ({ page }, info) => {
  test.setTimeout(120000);
  const role = kind === 'role', ids = role ? perms : instances;
  const prefix = role ? '权限' : '实例';
  const table = role ? 'role_permissions' : 'instance_permissions';
  const key = role ? 'permission_id' : 'instance_id';
  const ownerKey = role ? 'role_id' : 'user_id', owner = role ? roleId : targetId;
  const endpoint = role ? `/api/v1/rbac/roles/${roleId}/permissions` : `/api/v1/rbac/users/${targetId}/instances`;
  const selected = async () => (await db.query(`SELECT ${key} AS id FROM ${table} WHERE ${ownerKey}=? ORDER BY ${key}`, [owner]))[0].map((r: any) => r.id);
  const seed = async () => {
    await db.query(`DELETE FROM ${table} WHERE ${ownerKey}=?`, [owner]);
    for (const id of ids.slice(0, 2)) await db.query(`INSERT INTO ${table}(${ownerKey},${key}) VALUES(?,?)`, [owner, id]);
  };
  await seed();
  // Load the production Lit components against a real authenticated server.
  await page.route('**/rbac-save-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  await page.goto('http://127.0.0.1:5194/rbac-save-fixture');
  const login = await page.request.post('/api/auth/login', { data: { username: 'max354-test', password } });
  expect(login.status()).toBe(200);
  const token = (await login.json()).token;
  await page.evaluate(async ({ token, role }) => {
    localStorage.setItem('token', token);
    await import('/src/app/styles.css');
    await import('/src/app/ui/views/rbac-page.ts');
    document.body.append(document.createElement(role ? 'role-management-tab' : 'instance-permissions-tab'));
  }, { token, role });
  const open = page.getByRole('row').filter({ hasText: role ? 'max354-role' : 'max354-dual' }).getByRole('button', { name: role ? '编辑权限' : '实例权限', exact: true });
  const checkbox = (n: number) => page.getByRole('checkbox', { name: new RegExp(`^${prefix}${n}`) });
  const expand = async () => { if (role) await page.locator('summary').filter({ hasText: 'max354' }).click(); };
  const reopen = async () => { await open.click(); await expand(); await expect(checkbox(1)).toBeVisible(); };
  const close = async () => { await page.getByRole('button', { name: '取消', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); };
  const save = () => page.getByRole('button', { name: '保存权限', exact: true }).click();
  // Real database rejection on the second grant. First grant remains committed.
  await db.query(`CREATE TRIGGER max354_fail_grant BEFORE INSERT ON ${table} FOR EACH ROW BEGIN IF NEW.${ownerKey}=${owner} AND NEW.${key}=${ids[3]} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='max354 injected grant failure'; END IF; END`);
  await reopen();
  await checkbox(1).uncheck(); await checkbox(3).check(); await checkbox(4).check();
  await save();
  await expect(page.locator('.save-error')).toContainText(`新增授权：${prefix}3`);
  await expect(checkbox(1)).toBeChecked(); await expect(checkbox(3)).toBeChecked(); await expect(checkbox(4)).not.toBeChecked();
  expect(await selected()).toEqual(ids.slice(0, 3));
  report.checks.push({ kind, scenario: 'mid-grant database failure', sqlIds: await selected() });
  for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    const box = await page.getByRole('dialog').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await expect(page.getByRole('button', { name: '保存权限', exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`${kind}-${width}.png`) });
  }
  await close(); await reopen();
  await expect(checkbox(1)).toBeChecked(); await expect(checkbox(3)).toBeChecked(); await expect(checkbox(4)).not.toBeChecked();
  await close();
  await db.query('DROP TRIGGER max354_fail_grant');
  // Real database rejection on the second revoke, after a successful grant/revoke.
  await seed();
  await db.query(`CREATE TRIGGER max354_fail_revoke BEFORE DELETE ON ${table} FOR EACH ROW BEGIN IF OLD.${ownerKey}=${owner} AND OLD.${key}=${ids[1]} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='max354 injected revoke failure'; END IF; END`);
  await reopen(); await checkbox(1).uncheck(); await checkbox(2).uncheck(); await checkbox(3).check(); await save();
  await expect(page.locator('.save-error')).toContainText(`撤销授权：${prefix}1`);
  await expect(page.locator('.save-error')).toContainText(`新增授权：${prefix}3`);
  await expect(checkbox(1)).not.toBeChecked(); await expect(checkbox(2)).toBeChecked();
  expect(await selected()).toEqual([ids[1], ids[2]]);
  report.checks.push({ kind, scenario: 'mid-revoke database failure', sqlIds: await selected() });
  await db.query('DROP TRIGGER max354_fail_revoke');
  await close(); await reopen(); await checkbox(2).uncheck(); await checkbox(4).check(); await save();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await selected()).toEqual([ids[2], ids[3]]);
  await reopen(); await expect(checkbox(3)).toBeChecked(); await expect(checkbox(4)).toBeChecked();
  report.checks.push({ kind, scenario: 'successful save and reopen', sqlIds: await selected() });
  await close();
  // Unknown receipt: commit the real HTTP request, then replace only its response.
  let lose = true;
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() === 'POST' && lose) {
      lose = false;
      const real = await route.fetch(); expect(real.status()).toBe(201);
      await route.fulfill({ status: 502, json: { error: 'injected lost response' } });
    } else await route.continue();
  });
  await reopen(); await checkbox(1).check(); await save();
  await expect(page.locator('.save-error')).toContainText(`新增授权：${prefix}1`);
  await expect(checkbox(1)).toBeChecked();
  expect(await selected()).toEqual([ids[0], ids[2], ids[3]]);
  report.checks.push({ kind, scenario: 'committed write with lost response', sqlIds: await selected() });
  await page.unroute(`**${endpoint}`);
  await close();
  // A failed write followed by a failed read must never enable a stale save.
  await db.query(`CREATE TRIGGER max354_fail_grant BEFORE INSERT ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='max354 injected failure'`);
  await reopen();
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() === 'GET') await route.fulfill({ status: 503, json: { error: 'injected read unavailable' } });
    else await route.continue();
  });
  await checkbox(2).check(); await save();
  await expect(page.locator('.save-error')).toContainText('重新加载失败');
  await expect(page.getByRole('button', { name: '保存权限', exact: true })).toBeDisabled();
  await close();
  await page.unroute(`**${endpoint}`); await db.query('DROP TRIGGER max354_fail_grant');
  await reopen(); await expect(checkbox(2)).not.toBeChecked();
  await expect(page.getByRole('button', { name: '保存权限', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(open).toBeFocused();
  report.checks.push({ kind, scenario: 'failed reread blocked save, reopen and keyboard focus recovery', sqlIds: await selected() });
  // A disposable view raises a real MySQL error only for the managed subject.
  // The admin's own grants remain readable by real-time JWT authorization.
  const backingTable = `${table}_backing`;
  let readUnavailable = false;
  const readFault = async (enabled: boolean) => {
    if (enabled) {
      const [columns] = await db.query(`SHOW COLUMNS FROM ${table}`);
      await db.query(`CREATE FUNCTION max354_read_failure() RETURNS INT DETERMINISTIC NO SQL BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='max354-storage-sensitive-query'; RETURN 0; END`);
      await db.query(`RENAME TABLE ${table} TO ${backingTable}`);
      const fields = columns.map((c: any) => c.Field === key
        ? `IF(${ownerKey}=${owner},max354_read_failure(),${key}) AS ${key}` : c.Field).join(',');
      await db.query(`CREATE ALGORITHM=MERGE VIEW ${table} AS SELECT ${fields} FROM ${backingTable}`);
      readUnavailable = true;
    } else {
      await db.query(`DROP VIEW ${table}`);
      await db.query(`RENAME TABLE ${backingTable} TO ${table}`);
      await db.query('DROP FUNCTION max354_read_failure');
      readUnavailable = false;
    }
  };
  const readResponse = () => page.waitForResponse(r => new URL(r.url()).pathname === endpoint && r.request().method() === 'GET');
  const assertUnavailable = async (response: any) => {
    expect(response.status()).toBe(503);
    const body = await response.json();
    // The real server's existing 5xx serializer further masks route text.
    expect(body).toEqual({ error: 'INTERNAL_ERROR' });
    expect(JSON.stringify(body)).not.toMatch(/SELECT|Unknown column|permission_id|instance_id|sensitive|unavailable/);
  };
  try {
    await seed();
    await readFault(true);
    const firstRead = readResponse();
    await open.click();
    await assertUnavailable(await firstRead);
    await expect(page.locator('.save-error')).toContainText(role ? '加载权限失败' : '加载实例数据失败');
    await expect(page.getByRole('button', { name: '保存权限', exact: true })).toBeDisabled();
    await close();
    await readFault(false);
    expect(await selected()).toEqual(ids.slice(0, 2));
    await reopen(); await expect(checkbox(1)).toBeChecked(); await expect(checkbox(2)).toBeChecked(); await close();
    report.checks.push({ kind, scenario: 'real database read failure on first open: sanitized 503, blocked save, recovery', sqlIds: await selected() });

    // Let the first write commit, then break the database column before the
    // next write and recovery GET. Existing and committed grants must survive.
    let firstGrant = true;
    await page.route(`**${endpoint}`, async route => {
      if (route.request().method() === 'POST' && firstGrant) {
        firstGrant = false;
        const response = await route.fetch(); expect(response.status()).toBe(201);
        await readFault(true);
        await route.fulfill({ response });
      } else await route.continue();
    });
    await reopen(); await checkbox(3).check(); await checkbox(4).check();
    const failedRead = readResponse();
    await save();
    await assertUnavailable(await failedRead);
    await expect(page.locator('.save-error')).toContainText('重新加载失败');
    await expect(page.locator('.save-error')).not.toContainText('已重新加载服务端权限');
    await expect(page.locator('.save-error')).toContainText(`新增授权：${prefix}3`);
    await expect(page.getByRole('button', { name: '保存权限', exact: true })).toBeDisabled();
    await expect(checkbox(1)).toBeChecked(); await expect(checkbox(2)).toBeChecked();
    await page.locator('.save-error').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${kind}-database-read-failure.png`) });
    const preserved = (await db.query(`SELECT ${key} AS id FROM ${backingTable} WHERE ${ownerKey}=? ORDER BY ${key}`, [owner]))[0].map((r: any) => r.id);
    expect(preserved).toEqual(ids.slice(0, 3));
    await close(); await page.unroute(`**${endpoint}`); await readFault(false);
    await reopen(); await expect(checkbox(1)).toBeChecked(); await expect(checkbox(2)).toBeChecked(); await expect(checkbox(3)).toBeChecked(); await expect(checkbox(4)).not.toBeChecked();
    await expect(page.getByRole('button', { name: '保存权限', exact: true })).toBeEnabled(); await close();
    report.checks.push({ kind, scenario: 'real database read failure after partial write: sanitized 503, preserved grants, blocked save, recovery', sqlIds: preserved });

    // Empty is a real successful result, not the fallback for a storage error.
    await db.query(`DELETE FROM ${table} WHERE ${ownerKey}=?`, [owner]);
    const emptyRead = readResponse();
    await open.click(); if (role) await expand();
    const empty = await emptyRead;
    expect(empty.status()).toBe(200); expect(await empty.json()).toEqual([]);
    await expect(page.getByRole('button', { name: '保存权限', exact: true })).toBeEnabled();
    await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(0);
    await save(); await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await selected()).toEqual([]);
    report.checks.push({ kind, scenario: 'real empty grants are 200 and remain editable', sqlIds: [] });
  } finally {
    await page.unroute(`**${endpoint}`);
    if (readUnavailable) await readFault(false);
  }

});
