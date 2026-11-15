/** MAX-670 / #319 / #499. Full server + real MySQL, no model calls.
 * Explicit MAX670_MYSQL_HOST/PORT/USER/PASSWORD and MAX670_OUTPUT_DIR required.
 * Run from slide-api: pnpm exec tsx tests/branding-config-http.acceptance.ts
 * Uses only its generated schema. Default test collection never loads credentials.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { MigrationRunner } from '../src/migrations/runner.js';
import { brandingConfigService, DEFAULTS } from '../src/branding-config-service.js';
import { dbConnection } from '../src/db-connection.js';

for (const key of ['MAX670_MYSQL_HOST', 'MAX670_MYSQL_PORT', 'MAX670_MYSQL_USER', 'MAX670_MYSQL_PASSWORD', 'MAX670_OUTPUT_DIR']) {
  assert(process.env[key] !== undefined, `${key} required`);
}
const config = { host: process.env.MAX670_MYSQL_HOST!, port: Number(process.env.MAX670_MYSQL_PORT),
  user: process.env.MAX670_MYSQL_USER!, password: process.env.MAX670_MYSQL_PASSWORD! };
assert(Number.isInteger(config.port) && config.port > 0);
const output = resolve(process.env.MAX670_OUTPUT_DIR!);
mkdirSync(output, { recursive: true });
const schema = `max670_${randomBytes(6).toString('hex')}`;
const admin = mysql.createPool(config);
const pool = mysql.createPool({ ...config, database: schema, connectionLimit: 2 });
const username = 'max670_operator';
const password = randomBytes(24).toString('hex');
const jwtSecret = randomBytes(32).toString('hex');
const encryptionKey = randomBytes(32).toString('hex');
const observations: unknown[] = [];
let child: ReturnType<typeof spawn> | undefined;
let closed: Promise<unknown> | undefined;
let logs = '';
let created = false;
let failure: unknown;
const originalGetPool = dbConnection.getPool;
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}
try {
  await admin.query(`CREATE DATABASE ${schema}`);
  created = true;
  await new MigrationRunner(pool as any).run();
  await pool.execute('UPDATE llm_providers SET enabled=FALSE,is_default=FALSE');
  const port = await freePort(), wsPort = await freePort();
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, NODE_ENV: 'production', DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user,
    DB_PASSWORD: config.password, DB_NAME: schema, INITIAL_ADMIN_USERNAME: username, INITIAL_ADMIN_PASSWORD: password,
    JWT_SECRET_KEY: jwtSecret, ENCRYPTION_KEY: encryptionKey, PORT: String(port), AGENT_WS_PORT: String(wsPort),
    PROMPT_HOT_RELOAD: 'false', CORS_ORIGINS: `http://127.0.0.1:${port}`,
  } });
  closed = once(child, 'close');
  child.stdout!.on('data', chunk => { logs += chunk; });
  child.stderr!.on('data', chunk => { logs += chunk; });
  observations.push({ environment: { pid: child.pid, port, wsPort, cwd: process.cwd(), command: 'node --import tsx server.ts',
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), log: 'server.log', schema,
    mysql: `${config.host}:${config.port}`, mysqlVersion: (await pool.query<any[]>('SELECT VERSION() AS version'))[0][0].version,
    nodeEnv: 'production', connectionLimit: 2 } });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 600; attempt++) {
    assert(child.exitCode === null && child.signalCode === null, 'server exited during startup');
    try { ready = (await fetch(`${base}/api/health/ready`)).ok; } catch {}
    if (ready) break;
    await new Promise(done => setTimeout(done, 100));
  }
  assert(ready, 'full server readiness deadline 60s');
  async function request(method: string, path: string, body: unknown, status: number, token?: string) {
    const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json() as any;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  }
  const login = await request('POST', '/api/auth/login', { username, password }, 200);
  const token = login.token;
  assert.equal(typeof token, 'string');
  const path = '/api/branding/config';
  const put = (body: unknown, status = 200) => request('PUT', path, body, status, token);
  const get = () => request('GET', path, undefined, 200, token);
  const row = async () => (await pool.query<any[]>('SELECT * FROM system_config WHERE config_key=?', ['branding.config']))[0][0];
  await request('PUT', path, { cli_name: 'unauthorized' }, 401);
  await request('PUT', path, { cli_name: 'unauthorized' }, 401, 'invalid-token');
  observations.push({ check: 'unauthenticated and invalid JWT rejected', passed: true });
  // First insert race and existing-row race, through actual server HTTP handlers.
  for (const first of [true, false]) {
    await pool.execute('DELETE FROM system_config WHERE config_key=?', ['branding.config']);
    if (!first) await put(DEFAULTS);
    const results = await Promise.all([put({ cli_name: 'parallel' }), put({ state_dir: '.parallel' })]);
    assert(results.every(result => result.success));
    assert.deepEqual(await get(), { ...DEFAULTS, cli_name: 'parallel', state_dir: '.parallel' });
    observations.push({ check: first ? 'concurrent first insert' : 'concurrent different fields', passed: true });
  }
  // Preserve id, value_type, description, updated_by; updated_at may advance on actual writes.
  await pool.execute("UPDATE system_config SET value_type='json', description='max670 metadata', updated_by=42 WHERE config_key=?", ['branding.config']);
  const before = await row();
  const results = await Promise.all(['One', 'Two'].map(product_name => put({ product_name })));
  assert(results.every(result => result.success));
  const after = await row();
  for (const key of ['id', 'value_type', 'description', 'updated_by']) assert.deepEqual(after[key], before[key], key);
  assert(['One', 'Two'].includes((await get()).product_name));
  assert.equal((await get()).cli_name, 'parallel');
  await put({ product_name: 'Last commit' });
  assert.equal((await get()).product_name, 'Last commit');
  observations.push({ check: 'same-field concurrency, last completed sequential write, metadata preservation', passed: true });
  const valid = await row();
  for (const body of [null, [], 7, {}, { extra: 'bad' }, ...Object.keys(DEFAULTS).map(key => ({ cli_name: 'valid', [key]: null })),
    { product_name: 7 }, { product_name: [] }, { env_prefix: 'lower' }, { cli_name: 'UPPER' }, { state_dir: ' ' }]) {
    await put(body, 400);
    assert.deepEqual(await row(), valid);
  }
  observations.push({ check: 'null for each field and malformed patches rejected atomically', passed: true });
  for (const stored of ['null', '[]', '7', '{', '{"product_name":null}', '{"cli_name":9}']) {
    await pool.execute('UPDATE system_config SET config_value=? WHERE config_key=?', [stored, 'branding.config']);
    const invalid = await row();
    assert.deepEqual(await get(), DEFAULTS);
    const result = await put({ product_name: 'Must not overwrite' }, 400);
    assert.match(result.error, /已存品牌配置无效/);
    assert.deepEqual(await row(), invalid);
  }
  observations.push({ check: 'invalid historical storage returns legal fallback; PUT fails without data loss', passed: true });
  await pool.execute('UPDATE system_config SET config_value=? WHERE config_key=?', [JSON.stringify({ product_name: 'Legacy' }), 'branding.config']);
  await put({ state_dir: '.legacy' });
  assert.deepEqual(await get(), { ...DEFAULTS, product_name: 'Legacy', state_dir: '.legacy' });
  // Inject only a locked-SELECT failure; all transactions and persisted rows remain real MySQL.
  const stable = await row();
  dbConnection.getPool = () => ({ getConnection: async () => {
    const connection = await pool.getConnection();
    return { beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(),
      rollback: () => connection.rollback(), release: () => connection.release(),
      execute: async (sql: string, args: any) => {
        if (sql.startsWith('SELECT')) throw new Error('MAX670 injected locked read failure');
        return connection.execute(sql, args);
      } };
  } } as any);
  assert.equal((await brandingConfigService.saveBranding({ cli_name: 'must-not-write' })).success, false);
  assert.deepEqual(await row(), stable);
  dbConnection.getPool = () => pool;
  assert.equal((await brandingConfigService.saveBranding({ cli_name: 'recovered' })).success, true);
  assert.equal((await get()).cli_name, 'recovered');
  observations.push({ check: 'injected locked read failure rolls back real transaction; subsequent write succeeds', passed: true,
    limitation: 'SELECT failure is injected at driver boundary; not a real MySQL outage' });
  // A pool of one must not need a second connection while holding the transaction lock.
  const single = mysql.createPool({ ...config, database: schema, connectionLimit: 1 });
  try {
    dbConnection.getPool = () => single;
    const result = await Promise.all([brandingConfigService.saveBranding({ cli_name: 'single' }), brandingConfigService.saveBranding({ state_dir: '.single' })]);
    assert(result.every(r => r.success));
    assert.equal((await get()).cli_name, 'single');
    assert.equal((await get()).state_dir, '.single');
  } finally { dbConnection.getPool = originalGetPool; await single.end(); }
  observations.push({ check: 'single-connection pool concurrent writes do not starve', passed: true });
  await request('POST', '/api/users', { username: 'max670_reader', password }, 201, token);
  const reader = await request('POST', '/api/auth/login', { username: 'max670_reader', password }, 200);
  const protectedRow = await row();
  await request('PUT', path, { product_name: 'forbidden' }, 403, reader.token);
  assert.deepEqual(await row(), protectedRow);
  // Existing token after RBAC revocation must not retain branding write permission.
  await pool.execute('DELETE ur FROM user_roles ur JOIN users u ON u.id=ur.user_id WHERE u.username=?', [username]);
  await put({ product_name: 'revoked' }, 403);
  assert.deepEqual(await row(), protectedRow);
  observations.push({ check: 'non-admin and live permission revocation deny writes', passed: true });
  const [audits] = await pool.query<any[]>("SELECT event_type,result,COUNT(*) AS count FROM audit_log_entries GROUP BY event_type,result");
  assert(audits.some(a => a.event_type === 'config_change'));
  observations.push({ check: 'persisted audit summary', audits });
} catch (error) { failure = error; }
finally {
  dbConnection.getPool = originalGetPool;
  const cleanupErrors: string[] = [];
  if (child) {
    try {
      const daemon = JSON.parse(execFileSync(process.env.MULTICA_CLI_PATH!, ['daemon', 'status', '--output', 'json'], { encoding: 'utf8' }));
      assert.notEqual(child.pid, daemon.pid);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 15000);
      try { await closed; } finally { clearTimeout(timer); }
    } catch (error) { cleanupErrors.push(String(error)); }
  }
  // Keep test, evidence and cleanup failures distinct.
  for (const secret of [password, jwtSecret, encryptionKey, config.password].filter(Boolean)) logs = logs.split(secret).join('[REDACTED]');
  writeFileSync(resolve(output, 'server.log'), logs, { mode: 0o600 });
  try { await pool.end(); } catch (error) { cleanupErrors.push(String(error)); }
  if (created) {
    try { await admin.query(`DROP DATABASE ${schema}`); } catch (error) { cleanupErrors.push(String(error)); }
  }
  try { await admin.end(); } catch (error) { cleanupErrors.push(String(error)); }
  const report = { passed: !failure && cleanupErrors.length === 0, observations, failure: failure ? String(failure) : null, cleanupErrors, schemaDropped: created && cleanupErrors.length === 0 };
  writeFileSync(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
