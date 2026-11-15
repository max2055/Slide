/** Explicit real acceptance: MAX555_PROFILES points to an authorized JSON profile;
 * MAX555_OUTPUT_DIR is required; MAX555_MANAGED_HOST selects a policy-allowed
 * host address reaching the same authorized MySQL target (loopback is rejected). Own schemas only; no default credential reads.
 * Run from frontend: pnpm exec ../apps/db-ops-api/node_modules/.bin/tsx scripts/schema-management.acceptance.ts
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import { MigrationRunner } from '../../apps/db-ops-api/src/migrations/runner.js';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
assert(process.env.MAX555_PROFILES && process.env.MAX555_OUTPUT_DIR, 'Explicit profiles/output required');
const output = resolve(process.env.MAX555_OUTPUT_DIR);
await mkdir(output, { recursive: true });
const profile = JSON.parse(await readFile(process.env.MAX555_PROFILES, 'utf8'))['mysql-test'];
const config = { host: profile.host, port: profile.port, user: profile.user, password: profile.password };
const suffix = randomBytes(5).toString('hex');
const schemas = [`max555_store_${suffix}`, `max555_a_${suffix}`, `max555_b_${suffix}`];
const admin = mysql.createPool(config), storage = mysql.createPool({ ...config, database: schemas[0] });
const username = `max555_${suffix}`, password = randomBytes(20).toString('hex');
const secret = randomBytes(32).toString('hex'), encryption = randomBytes(32).toString('hex');
let child: ReturnType<typeof spawn> | undefined, closed: Promise<unknown> | undefined;
let vite: Awaited<ReturnType<typeof createServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let logs = '', created: string[] = [], failure: unknown;
const observations: unknown[] = [];
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
async function freePort() {
  const server = createNetServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done())); return port;
}
try {
  for (const schema of schemas) { await admin.query(`CREATE DATABASE ${schema}`); created.push(schema); }
  await admin.query(`CREATE TABLE ${schemas[1]}.items_a (id INT, label VARCHAR(20) DEFAULT '0')`);
  await admin.query(`CREATE TABLE ${schemas[2]}.items_b (id INT)`);
  await new MigrationRunner(storage as any).run();
  await storage.query('UPDATE llm_providers SET enabled=FALSE,is_default=FALSE');
  const port = await freePort(), wsPort = await freePort(), vitePort = await freePort();
  const cwd = resolve('../apps/db-ops-api'), base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, NODE_ENV: 'production', DB_HOST: String(config.host), DB_PORT: String(config.port), DB_USER: config.user,
    DB_PASSWORD: config.password, DB_NAME: schemas[0], INITIAL_ADMIN_USERNAME: username, INITIAL_ADMIN_PASSWORD: password,
    JWT_SECRET_KEY: secret, ENCRYPTION_KEY: encryption, PORT: String(port), AGENT_WS_PORT: String(wsPort), PROMPT_HOT_RELOAD: 'false', CORS_ORIGINS: `http://127.0.0.1:${port},http://127.0.0.1:${vitePort}`,
  } });
  closed = once(child, 'close'); child.stdout!.on('data', chunk => { logs += chunk; }); child.stderr!.on('data', chunk => { logs += chunk; });
  observations.push({ pid: child.pid, port, wsPort, cwd, command: 'node --import tsx server.ts', head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), schemas, log: 'server.log' });
  let ready = false;
  for (let i = 0; i < 600; i++) {
    assert(child.exitCode === null && child.signalCode === null, 'server exited during startup');
    try { if ((await fetch(`${base}/api/health/ready`)).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert(ready, 'readiness deadline 60s');
  async function api(path: string, body?: unknown, token?: string, method = body === undefined ? 'GET' : 'POST', status = 200) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, status, `${method} ${path}`); return response.json();
  }
  const login = await api('/api/auth/login', { username, password }); const token = login.token;
  const ids: number[] = [];
  for (const [index, database_name] of schemas.slice(1).entries()) {
    const instance = await api('/api/database/instances', { name: `MAX555-${index}`, environment: 'testing', host: process.env.MAX555_MANAGED_HOST || config.host, port: config.port, username: config.user, password: config.password, db_type: 'mysql', database_name }, token);
    ids.push(instance.id); await api(`/api/database/instances/${instance.id}/reload`, {}, token);
  }
  for (const id of ids) await api(`/api/schema/collect/${id}`, {}, token);
  const actualHint = await api(`/api/schema/changes/${ids[0]}`, {}, token);
  assert.match(actualHint.hint, /至少两次/);
  vite = await createServer({ root: resolve('.'), configFile: resolve('vite.config.js'), server: { host: '127.0.0.1', port: vitePort, strictPort: true, proxy: { '/api': { target: base } } } });
  await vite.listen(); const url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(token => localStorage.setItem('token', token), token);
  // Component host only; every schema/instance/auth request reaches production server.
  await page.route('**/max555-host*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><link rel="stylesheet" href="/src/app/styles/tokens.css"><body><script type="module">import '/src/app/ui/views/schema-management.ts';const v=document.createElement('schema-management-page');v.instanceId=Number(new URL(location.href).searchParams.get('id'));document.body.append(v);addEventListener('popstate',()=>{v.instanceId=Number(new URL(location.href).searchParams.get('id'))});</script></body></html>` }));
  await page.goto(`${url}/max555-host?id=${ids[0]}`);
  const view = page.locator('schema-management-page');
  await expect(view).toContainText('items_a');
  await view.getByRole('button', { name: '检测变更', exact: true }).click();
  await expect(view.locator('p[role="status"]')).toContainText(actualHint.hint);
  await page.screenshot({ path: resolve(output, 'real-hint.png') });
  await page.evaluate(id => { history.pushState({}, '', `/max555-host?id=${id}`); dispatchEvent(new PopStateEvent('popstate')); }, ids[1]);
  await expect(view).toContainText('items_b'); await expect(view).not.toContainText('items_a');
  await page.goBack(); await expect(view).toContainText('items_a'); await expect(view).not.toContainText('items_b');
  observations.push({ case: '#676 direct instance binding/browser back, #677 one real snapshot', passed: true, ids });
  // Real information_schema collection → persisted snapshots → production comparison → UI.
  let old: string | null = '0';
  for (const next of [null, '0', '', 'restored']) {
    await admin.query(`ALTER TABLE ${schemas[1]}.items_a MODIFY label VARCHAR(20) DEFAULT ${next === null ? 'NULL' : mysql.escape(next)}`);
    await view.getByRole('button', { name: '采集快照', exact: true }).click();
    await expect(view).toContainText('采集成功：');
    await view.getByRole('button', { name: '检测变更', exact: true }).click();
    await view.getByRole('button', { name: '变更历史', exact: true }).click();
    const format = (v: string | null) => v === null ? 'NULL' : v === '' ? '""' : v;
    await expect(view.locator('.change-detail')).toContainText(`column_default: ${format(old)} → ${format(next)}`);
    await expect(view).not.toContainText(actualHint.hint);
    const [rows] = await storage.query<any[]>('SELECT column_default FROM schema_snapshots WHERE instance_id=? AND column_name=? ORDER BY snapshot_time DESC LIMIT 1', [ids[0], 'label']);
    assert.equal(rows[0].column_default, next);
    observations.push({ case: '#678 real default transition', old, next, passed: true }); old = next;
  }
  await page.screenshot({ path: resolve(output, 'real-default.png') });
  // Same token, live role permissions revoked, then restored. No captured JWT in trace.
  const [users] = await storage.query<any[]>('SELECT id FROM users WHERE username=?', [username]);
  const userId = users[0].id;
  const [role] = await storage.query<any>("INSERT INTO roles(name) VALUES ('max555_operator')");
  const roleId = role.insertId;
  await storage.query("INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code IN ('schema:view','schema:manage','instance:view')", [roleId]);
  await storage.query('DELETE FROM user_roles WHERE user_id=?', [userId]);
  await storage.query('INSERT INTO user_roles(user_id,role_id) VALUES (?,?)', [userId, roleId]);
  for (const id of ids) await storage.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES (?,?,'read-write') ON DUPLICATE KEY UPDATE access_level='read-write'", [userId, id]);
  await storage.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE p.code='schema:manage'");
  await view.getByRole('button', { name: '检测变更', exact: true }).click();
  await expect(view).toContainText('权限不足');
  await storage.query("INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r JOIN permissions p WHERE r.name='max555_operator' AND p.code='schema:manage'");
  const restored = page.waitForResponse(r => r.url().includes(`/api/schema/changes/${ids[0]}`) && r.request().method() === 'POST');
  await view.getByRole('button', { name: '检测变更', exact: true }).click();
  assert.equal((await restored).status(), 200);
  await expect(view).not.toContainText('权限不足');
  await expect(view.locator('.change-detail')).toContainText('column_default: "" → restored');
  observations.push({ case: 'same JWT live permission revocation/recovery', passed: true });
  observations.push({ mysqlVersion: (await storage.query<any[]>('SELECT VERSION() AS version'))[0][0].version, browserVersion: browser.version(), modelCalls: 0 });
} catch (error) { failure = error; }
finally {
  const cleanupErrors: unknown[] = [];
  const cleanup = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
  await cleanup(async () => browser?.close());
  await cleanup(async () => vite?.close());
  await cleanup(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const daemon = JSON.parse(execFileSync(process.env.MULTICA_CLI_PATH!, ['daemon', 'status', '--output', 'json'], { encoding: 'utf8' }));
      assert.notEqual(child.pid, daemon.pid); child.kill('SIGTERM');
      const deadline = setTimeout(() => { if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 15000);
      try { await closed; } finally { clearTimeout(deadline); }
    }
  });
  for (const value of [password, secret, encryption, config.password]) if (value) logs = logs.replaceAll(value, '[REDACTED]');
  await cleanup(() => writeFile(resolve(output, 'server.log'), logs, { mode: 0o600 }));
  await cleanup(() => storage.end());
  for (const schema of created.reverse()) await cleanup(() => admin.query(`DROP DATABASE ${schema}`));
  await cleanup(() => admin.end());
  observations.push({ cleanup: cleanupErrors.length ? 'failed' : 'owned schemas dropped; browser, Vite and exact child stopped', cleanupErrors: cleanupErrors.length });
  await writeFile(resolve(output, 'observations.json'), JSON.stringify(observations, null, 2));
  if (cleanupErrors.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Acceptance/cleanup failure; first error preserved');
}
if (failure) throw failure;
console.log('MAX555 real browser → production server/JWT → MySQL schema collection/detection acceptance passed');
