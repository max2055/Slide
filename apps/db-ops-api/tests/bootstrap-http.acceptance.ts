/** MAX-267 / MAX-266: formal init/start entrypoints against a disposable, real MySQL schema. */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import { trackBootstrapProcess } from './bootstrap-process.js';
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
 JWT_SECRET_KEY: '\n' + randomBytes(32).toString('hex') + '\n', ENCRYPTION_KEY: randomBytes(32).toString('base64'), INITIAL_ADMIN_USERNAME: 'operator', INITIAL_ADMIN_PASSWORD: 'synthetic-operator-password', PORT: String(httpPort), AGENT_WS_PORT: String(wsPort), PROMPT_HOT_RELOAD: 'false', CORS_ORIGINS: `http://127.0.0.1:${httpPort}` };
let sequence = 0;
let applicationReady = false;
let processOutput = '';
let active: ReturnType<typeof spawn> | undefined;
const processes = new WeakMap<ReturnType<typeof spawn>, ReturnType<typeof trackBootstrapProcess>>();
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
function launch(command: string[], overrides = {}) {
  applicationReady = false;
  processOutput = '';
  const log = createWriteStream(resolve(output, `${++sequence}-process.log`));
  const child = spawn('pnpm', ['--filter', 'slide-api', ...command], { cwd: root, env: { ...env, ...overrides }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.set(child, trackBootstrapProcess(child));
  child.stdout!.on('data', chunk => { processOutput += String(chunk); if (String(chunk).includes('WORKER_READY')) applicationReady = true; });
  child.stderr!.on('data', chunk => { processOutput += String(chunk); });
  child.stdout!.pipe(log); child.stderr!.pipe(log);
  child.once('close', () => log.end());
  console.log(JSON.stringify({ pid: child.pid, httpPort, wsPort, cwd: root, command: ['pnpm', '--filter', 'slide-api', ...command], log: `${sequence}-process.log`, head: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim() }));
  active = child; return child;
}
async function stop() {
  if (!active) return;
  await processes.get(active)!.stop();
  for (const port of [httpPort, wsPort]) {
    await new Promise<void>((done, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : done()));
    });
  }
  active = undefined;
}
async function completed(child: ReturnType<typeof spawn>) {
  const result = await processes.get(child)!.closed;
  await stop(); return result.code;
}
const base = `http://127.0.0.1:${httpPort}`;
async function start(overrides = {}) {
  const child = launch(['start'], overrides);
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`start exited ${child.exitCode ?? child.signalCode}; inspect process log`);
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
let businessError: unknown;
try {
  assert.equal(await completed(launch(['init-db'])), 0);
  for (const [name, value] of [
    ['missing', undefined], ['empty', ''], ['spaces', ' '.repeat(32)],
    ['tabs/newlines', '\t\r\n '.repeat(8)], ['Unicode whitespace', '\u00a0\u2003\u2028\u3000'.repeat(8)],
    ['31 characters', 'j'.repeat(31)], ['known default', 'change-this-to-a-random-32-char-key'],
  ] as const) {
    let listenerSeen = false;
    const invalid = launch(['start'], { JWT_SECRET_KEY: value });
    for (let attempt = 0; invalid.exitCode === null && invalid.signalCode === null && attempt < 1200; attempt++) {
      try { await fetch(`${base}/api/health`); listenerSeen = true; } catch {}
      await delay(50);
    }
    assert.notEqual(invalid.exitCode, null, 'invalid JWT startup must terminate');
    assert.notEqual(invalid.exitCode, 0); assert.equal(listenerSeen, false);
    // The installed fatal handler intentionally suppresses exception details.
    assert.match(processOutput, /FATAL_UNCAUGHT_EXCEPTION/);
    for (const secret of [env.ENCRYPTION_KEY, env.INITIAL_ADMIN_PASSWORD]) assert.equal(processOutput.includes(secret), false, 'startup log must not disclose secrets');
    await stop();
    console.log(`MAX-266 JWT ${name}: nonzero exit, no HTTP listener, no secret disclosure: PASS`);
  }
  // Startup constructs a provider but this test never invokes it. Keep all endpoints local.
  await pool.query("UPDATE llm_providers SET enabled=0,is_default=0");
  await pool.query("UPDATE llm_providers SET enabled=1,is_default=1,supports_function_call=1,api_format='openai-completions',api_base_url='http://127.0.0.1:9' WHERE name='ollama'");
  await start();
  const operator = await login('operator', env.INITIAL_ADMIN_PASSWORD, 200);
  assert.doesNotThrow(() => jwt.verify(operator.token, env.JWT_SECRET_KEY));
  assert.throws(() => jwt.verify(operator.token, env.JWT_SECRET_KEY.trim()));
  for (const secret of [env.JWT_SECRET_KEY.trim(), env.ENCRYPTION_KEY, env.INITIAL_ADMIN_PASSWORD, operator.token]) assert.equal(processOutput.includes(secret), false, 'successful startup log must not disclose secrets');
  console.log('MAX-266 legitimate production startup: HTTP-issued JWT uses exact untrimmed key; logs omit credentials/token: PASS');
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
  for (let attempt = 0; invalid.exitCode === null && invalid.signalCode === null && attempt < 1200; attempt++) {
    try { await fetch(`${base}/api/health`); listenerSeen = true; } catch {}
    await delay(50);
  }
  assert.notEqual(invalid.exitCode, null, 'invalid startup must terminate');
  assert.notEqual(invalid.exitCode, 0); assert.equal(listenerSeen, false);
  await stop();
  console.log('Invalid production bootstrap config: nonzero exit, HTTP listener never available: PASS');
} catch (error) {
  businessError = error;
  throw error;
} finally {
  const errors: unknown[] = [];
  for (const cleanup of [() => stop(), () => pool.end(), () => admin.query(`DROP DATABASE ${database}`), () => admin.end()]) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError([...(businessError ? [businessError] : []), ...errors], 'Bootstrap acceptance cleanup failed; original business failure retained');
}
console.log('MAX-267 formal-entry HTTP acceptance PASS; schemas removed; child processes stopped; LLM calls=0');
