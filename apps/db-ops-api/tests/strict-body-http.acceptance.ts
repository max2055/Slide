/** MAX-647 / #395: full production server, TCP HTTP, real MySQL and live JWT/RBAC.
 * Explicit MAX647_MYSQL_HOST/PORT/USER/PASSWORD and MAX647_OUTPUT_DIR required.
 * Run from slide-api: pnpm exec tsx tests/strict-body-http.acceptance.ts
 * Never loads credentials from a private file. Only the generated schema is changed.
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

for (const key of ['MAX647_MYSQL_HOST', 'MAX647_MYSQL_PORT', 'MAX647_MYSQL_USER', 'MAX647_MYSQL_PASSWORD', 'MAX647_OUTPUT_DIR']) {
  assert(process.env[key] !== undefined, `${key} required`);
}
const config = { host: process.env.MAX647_MYSQL_HOST!, port: Number(process.env.MAX647_MYSQL_PORT),
  user: process.env.MAX647_MYSQL_USER!, password: process.env.MAX647_MYSQL_PASSWORD! };
assert(Number.isInteger(config.port) && config.port > 0);
const output = resolve(process.env.MAX647_OUTPUT_DIR!);
mkdirSync(output, { recursive: true });
const schema = `max647_${randomBytes(6).toString('hex')}`;
const admin = mysql.createPool(config);
const pool = mysql.createPool({ ...config, database: schema });
const username = 'max647_operator';
const password = randomBytes(24).toString('hex');
const jwtSecret = randomBytes(32).toString('hex');
const encryptionKey = randomBytes(32).toString('hex');
const observations: unknown[] = [];
let active: ReturnType<typeof spawn> | undefined;
let closed: Promise<unknown> | undefined;
let logs = '';
let created = false;
let failure: unknown;
let round = 0;
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}
async function stop() {
  if (!active) return;
  // Only signal the exact server child started here, never a name or port owner.
  const daemon = JSON.parse(execFileSync(process.env.MULTICA_CLI_PATH!, ['daemon', 'status', '--output', 'json'], { encoding: 'utf8' }));
  assert.notEqual(active.pid, daemon.pid, 'child must not be the workspace daemon');
  if (active.exitCode === null && active.signalCode === null) active.kill('SIGTERM');
  const timer = setTimeout(() => { if (active?.exitCode === null && active.signalCode === null) active.kill('SIGKILL'); }, 15000);
  try { await closed; } finally { clearTimeout(timer); }
  for (const secret of [password, jwtSecret, encryptionKey, config.password].filter(Boolean)) assert(!logs.includes(secret), 'process log secret scan');
  writeFileSync(resolve(output, `server-${round}.log`), logs, { mode: 0o600 });
  active = undefined;
}
async function start() {
  round++;
  logs = '';
  const port = await freePort(), wsPort = await freePort();
  active = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, NODE_ENV: 'production', DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user,
    DB_PASSWORD: config.password, DB_NAME: schema, INITIAL_ADMIN_USERNAME: username, INITIAL_ADMIN_PASSWORD: password,
    JWT_SECRET_KEY: jwtSecret, ENCRYPTION_KEY: encryptionKey, PORT: String(port), AGENT_WS_PORT: String(wsPort),
    PROMPT_HOT_RELOAD: 'false', CORS_ORIGINS: `http://127.0.0.1:${port}`,
  } });
  closed = once(active, 'close');
  active.stdout!.on('data', chunk => { logs += chunk; });
  active.stderr!.on('data', chunk => { logs += chunk; });
  console.log(JSON.stringify({ pid: active.pid, port, wsPort, cwd: process.cwd(), command: 'node --import tsx server.ts',
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), log: `server-${round}.log`, schema, mysql: `${config.host}:${config.port}`, nodeEnv: 'production' }));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 600; attempt++) {
    assert(active.exitCode === null && active.signalCode === null, 'server exited during startup');
    try { if ((await fetch(`${base}/api/health/ready`)).ok) return base; } catch {}
    await delay(100);
  }
  throw new Error('server readiness deadline 60s exceeded');
}
async function request(base: string, path: string, body: unknown, status: number, token?: string, method = 'POST', json = true) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json() as any;
  observations.push({ round, path, method, input: body === undefined ? (json ? 'empty-json-body' : 'absent-body') :
    body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body, expected: status, actual: response.status,
    ...(response.status === 400 ? { error: result.error, message: result.message } : {}) });
  assert.equal(response.status, status, `${method} ${path} input ${body === null ? 'null' : typeof body}`);
  return result;
}
try {
  await admin.query(`CREATE DATABASE ${schema}`);
  created = true;
  await new MigrationRunner(pool as any).run();
  await pool.execute('UPDATE llm_providers SET enabled=FALSE,is_default=FALSE');
  let base = await start();
  const login = await request(base, '/api/auth/login', { username, password }, 200);
  const token = login.token;
  assert(typeof token === 'string');
  for (const body of [null, [], 7, true, '']) await request(base, '/api/auth/login', body, 400);
  await request(base, '/api/auth/login', undefined, 400);
  const unknown = await request(base, '/api/auth/login', { username, password, extra: true }, 400);
  assert.match(unknown.error, /未知字段: extra/);
  await request(base, '/api/auth/login', { username, password: 'wrong-synthetic-password' }, 401);
  for (const [path, method] of [['/api/users', 'POST'], ['/api/servers', 'POST'], ['/api/servers/999999', 'PUT'],
    ['/api/servers/999999/rotate-key', 'POST'], ['/api/llm/configs', 'POST'], ['/api/database/instances', 'POST'],
    ['/api/database/instances/999999', 'PUT']] as const) {
    for (const body of [null, [], 7, true, '', undefined]) {
      await request(base, path, body, 400, token, method);
    }
  }
  const guidance = await request(base, '/api/users', { username: 'must_not_exist', password: 'synthetic-password', role: 'admin' }, 400, token);
  assert.match(guidance.error, /POST \/api\/v1\/rbac\/users\/\{userId\}\/roles/);
  await request(base, '/api/users', { username: 'max647_created', password: 'synthetic-password' }, 201, token);
  await request(base, '/api/users', null, 401);
  const unprivileged = await request(base, '/api/auth/login', { username: 'max647_created', password: 'synthetic-password' }, 200);
  await request(base, '/api/users', {}, 403, unprivileged.token);
  const [users] = await pool.query<any[]>('SELECT username FROM users ORDER BY id');
  assert(users.some(row => row.username === 'max647_created'));
  assert(!users.some(row => row.username === 'must_not_exist'));
  const [audits] = await pool.query<any[]>('SELECT event_type,result,COUNT(*) AS count FROM audit_log_entries GROUP BY event_type,result');
  observations.push({ users: users.map(row => row.username), audits });
  await stop();
  // Fresh rate limiter permits the absent-body and {} cases without weakening production limits.
  base = await start();
  await request(base, '/api/auth/login', undefined, 400, undefined, 'POST', false);
  const empty = await request(base, '/api/auth/login', {}, 400);
  assert.equal(empty.error, '用户名和密码不能为空');
  const restarted = await request(base, '/api/auth/login', { username, password }, 200);
  await pool.execute("UPDATE users SET status='locked' WHERE username=?", [username]);
  await request(base, '/api/users', {}, 401, restarted.token);
  await stop();
  console.log('PASS full production HTTP login, live JWT/RBAC, strict and warning-only management routes; LLM requests=0');
} catch (error) {
  failure = error;
} finally {
  const cleanup: unknown[] = [];
  for (const step of [stop, () => pool.end(), async () => { if (created) await admin.query(`DROP DATABASE ${schema}`); }, () => admin.end()]) {
    try { await step(); } catch (error) { cleanup.push(error); }
  }
  writeFileSync(resolve(output, 'http-results.json'), JSON.stringify({ schema, observations, cleanupErrors: cleanup.map(String), passed: !failure && !cleanup.length }, null, 2));
  if (failure || cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], 'MAX-647 acceptance failed; business and cleanup failures retained');
  console.log('PASS child stopped; exclusive schema dropped; no shared business data changed');
}
