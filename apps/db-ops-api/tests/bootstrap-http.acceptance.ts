/** MAX-267: formal init/start entrypoints against a disposable, real MySQL schema. */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
const port = Number(process.env.BOOTSTRAP_TEST_MYSQL_PORT);
assert(port, 'Dedicated BOOTSTRAP_TEST_MYSQL_PORT required');
const root = resolve('../..');
const output = resolve(root, 'outputs/max267-http');
mkdirSync(output, { recursive: true });
const config = { host: '127.0.0.1', port, user: 'root', password: process.env.BOOTSTRAP_TEST_MYSQL_PASSWORD ?? '' };
const admin = mysql.createPool(config);
const database = `max267_http_${randomUUID().replaceAll('-', '')}`;
const freePort = () => new Promise<number>(done => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => done(p)); }); });
const httpPort = await freePort(), wsPort = await freePort();
const env = { ...process.env, NODE_ENV: 'production', DB_HOST: config.host, DB_PORT: String(port), DB_USER: 'root', DB_PASSWORD: config.password, DB_NAME: database,
 JWT_SECRET_KEY: 'synthetic-jwt-key-for-max267-acceptance-only', ENCRYPTION_KEY: 'e'.repeat(32), INITIAL_ADMIN_USERNAME: 'operator', INITIAL_ADMIN_PASSWORD: 'synthetic-operator-password', PORT: String(httpPort), AGENT_WS_PORT: String(wsPort), PROMPT_HOT_RELOAD: 'false', CORS_ORIGINS: `http://127.0.0.1:${httpPort}` };
let sequence = 0;
let applicationReady = false;
let active: ReturnType<typeof spawn> | undefined;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
function launch(command: string[], overrides = {}) {
  applicationReady = false;
  const log = createWriteStream(resolve(output, `${++sequence}-process.log`));
  const child = spawn('pnpm', ['--filter', 'slide-api', ...command], { cwd: root, env: { ...env, ...overrides }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', chunk => { if (String(chunk).includes('WORKER_READY')) applicationReady = true; });
  child.stdout!.pipe(log); child.stderr!.pipe(log);
  child.once('close', () => log.end());
  console.log(JSON.stringify({ pid: child.pid, httpPort, wsPort, cwd: root, command: ['pnpm', '--filter', 'slide-api', ...command], log: `${sequence}-process.log`, head: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim() }));
  active = child; return child;
}
async function stop() {
  if (!active || active.exitCode !== null) { active = undefined; return; }
  const child = active;
  // This process group was created exclusively by this harness; never stop by port/name.
  process.kill(-child.pid!, 'SIGTERM');
  for (let i = 0; i < 100 && child.exitCode === null; i++) await delay(100);
  if (child.exitCode === null) { process.kill(-child.pid!, 'SIGKILL'); await new Promise(r => child.once('close', r)); }
  active = undefined;
}
async function completed(child: ReturnType<typeof spawn>) {
  const code = await new Promise<number | null>(r => child.once('close', r));
  active = undefined; return code;
}
const base = `http://127.0.0.1:${httpPort}`;
async function start(overrides = {}) {
  const child = launch(['start'], overrides);
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`start exited ${child.exitCode}; inspect process log`);
    try { const res = await fetch(`${base}/api/health`); if (res.ok && applicationReady) return; } catch {}
    await delay(250);
  }
  throw new Error('HTTP startup deadline exceeded');
}
async function login(username: string, password: string, expected: number) {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(r.status, expected, `login ${username}`);
  console.log(`HTTP login ${username}: ${r.status}`);
  return r.json() as Promise<any>;
}
async function permissions(token: string, expected: number) {
  const r = await fetch(`${base}/api/auth/permissions`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, expected, 'JWT with live actor checks');
  console.log(`HTTP JWT/live permissions: ${r.status}`);
}
await admin.query(`CREATE DATABASE ${database}`);
const pool = mysql.createPool({ ...config, database });
try {
  assert.equal(await completed(launch(['init-db'])), 0);
  // Startup constructs a provider but this test never invokes it. Keep all endpoints local.
  await pool.query("UPDATE llm_providers SET enabled=0,is_default=0");
  await pool.query("UPDATE llm_providers SET enabled=1,is_default=1,supports_function_call=1,api_format='openai-completions',api_base_url='http://127.0.0.1:9' WHERE name='ollama'");
  await start();
  const operator = await login('operator', env.INITIAL_ADMIN_PASSWORD, 200);
  await permissions(operator.token, 200);
  await login('admin', 'Tpam1234', 401); await login('user', 'Tpam1234', 401);
  await stop();
  const [ledger] = await pool.query('SELECT migration_id,checksum,status FROM app_schema_migrations ORDER BY migration_id');
  await start(); await login('operator', env.INITIAL_ADMIN_PASSWORD, 200); await stop();
  assert.deepEqual((await pool.query('SELECT migration_id,checksum,status FROM app_schema_migrations ORDER BY migration_id'))[0], ledger);
  console.log('Production init-db, start, restart and ledger preservation: PASS');
  // Existing seeded deployment: retain the operator, install the exact historical credentials/RBAC.
  const hash = '4f32fc2ba7f8dfa43328d1ee7e5eb7607c78ab2e73c5cd001979aeaf5532c817';
  await pool.query("INSERT INTO users(username,password_hash,status,role_backup) VALUES ('admin',?,'active','admin'),('user',?,'active','viewer')", [hash,hash]);
  await pool.query('INSERT INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name=u.role_backup');
  await start({ NODE_ENV: 'development' });
  const legacy = await login('admin', 'Tpam1234', 200);
  await permissions(legacy.token, 200);
  await stop();
  await start();
  await login('admin', 'Tpam1234', 401); await login('user', 'Tpam1234', 401);
  await permissions(legacy.token, 401);
  const retained = await login('operator', env.INITIAL_ADMIN_PASSWORD, 200); await permissions(retained.token, 200);
  await stop();
  console.log('Upgrade: previously working HTTP-issued JWT rejected after production startup: PASS');
  let listenerSeen = false;
  const invalid = launch(['start'], { INITIAL_ADMIN_PASSWORD: '' });
  for (let attempt = 0; invalid.exitCode === null && attempt < 1200; attempt++) {
    try { await fetch(`${base}/api/health`); listenerSeen = true; } catch {}
    await delay(50);
  }
  assert.notEqual(invalid.exitCode, null, 'invalid startup must terminate');
  assert.notEqual(invalid.exitCode, 0); assert.equal(listenerSeen, false);
  active = undefined;
  console.log('Invalid production bootstrap config: nonzero exit, HTTP listener never available: PASS');
} finally {
  await stop(); await pool.end(); await admin.query(`DROP DATABASE ${database}`); await admin.end();
}
console.log('MAX-267 formal-entry HTTP acceptance PASS; schemas removed; child processes stopped; LLM calls=0');
