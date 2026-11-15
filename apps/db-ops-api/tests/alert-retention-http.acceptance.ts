/** MAX-563 / #311: full production server, TCP HTTP, real MySQL and live JWT/RBAC.
 * Explicit MAX563_MYSQL_HOST/PORT/USER/PASSWORD and MAX563_OUTPUT_DIR required.
 * Run from slide-api: pnpm exec tsx tests/alert-retention-http.acceptance.ts
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

for (const key of ['MAX563_MYSQL_HOST', 'MAX563_MYSQL_PORT', 'MAX563_MYSQL_USER', 'MAX563_MYSQL_PASSWORD', 'MAX563_OUTPUT_DIR']) {
  assert(process.env[key] !== undefined, `${key} required`);
}
const config = { host: process.env.MAX563_MYSQL_HOST!, port: Number(process.env.MAX563_MYSQL_PORT),
  user: process.env.MAX563_MYSQL_USER!, password: process.env.MAX563_MYSQL_PASSWORD! };
assert(Number.isInteger(config.port) && config.port > 0);
const output = resolve(process.env.MAX563_OUTPUT_DIR!);
mkdirSync(output, { recursive: true });
const schema = `max563_${randomBytes(6).toString('hex')}`;
const admin = mysql.createPool(config);
const pool = mysql.createPool({ ...config, database: schema });
const username = 'max563_operator';
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

  const seed = async () => {
    await pool.execute('DELETE FROM alerts');
    for (const [title, age, source] of [['old', 60, null], ['middle', 15, 'manual'], ['recent', 1, null], ['protected', 90, 'template-trigger']] as const) {
      await pool.execute("INSERT INTO alerts (alert_type,level,title,message,source,created_at) VALUES ('performance','warning',?,'retention fixture',?,DATE_SUB(NOW(), INTERVAL ? DAY))", [title, source, age]);
    }
  };
  const titles = async () => (await pool.query<any[]>('SELECT title FROM alerts ORDER BY title'))[0].map(row => row.title);
  const clear = (query: string, status: number, actor: string | undefined = token) =>
    request(base, '/api/alerts' + query, undefined, status, actor, 'DELETE', false);
  await seed();
  const before = await titles();
  for (const value of ['-1','-0.5','NaN','Infinity','-Infinity','1.5','abc','',' ','9007199254740992','0&retentionDays=0']) {
    await clear('?retentionDays=' + (value.includes('&') ? value : encodeURIComponent(value)), 400);
    assert.deepEqual(await titles(), before);
  }
  await request(base, '/api/alerts?retentionDays=0', undefined, 401, undefined, 'DELETE', false);
  await request(base, '/api/users', { username: 'max563_reader', password: 'synthetic-password' }, 201, token);
  const reader = await request(base, '/api/auth/login', { username: 'max563_reader', password: 'synthetic-password' }, 200);
  await clear('?retentionDays=0', 403, reader.token);
  const [users] = await pool.query<any[]>("SELECT id FROM users WHERE username='max563_reader'");
  const [role] = await pool.execute<any>("INSERT INTO roles (name) VALUES ('max563_scoped')");
  await pool.execute('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)', [users[0].id, role.insertId]);
  await pool.execute("INSERT INTO role_permissions (role_id,permission_id) SELECT ?,id FROM permissions WHERE code='alert:manage'", [role.insertId]);
  const scoped = await clear('?retentionDays=0', 403, reader.token);
  assert.equal(scoped.error, '清除全局告警需要不受限的实例管理权限');
  assert.deepEqual(await titles(), before);
  await pool.execute("INSERT INTO role_permissions (role_id,permission_id) SELECT ?,id FROM permissions WHERE code='instance:*'", [role.insertId]);
  await clear('?retentionDays=0', 200, reader.token);
  await seed();
  await pool.execute("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=? AND p.code='alert:manage'", [role.insertId]);
  await clear('?retentionDays=0', 403, reader.token);
  assert.deepEqual(await titles(), before);
  for (const [query, remaining, deleted] of [
    ['', ['middle','protected','recent'], 1],
    ['?retentionDays=10', ['protected','recent'], 2],
    ['?retentionDays=0', ['protected'], 3],
  ] as const) {
    await seed();
    const result = await clear(query, 200);
    assert.equal(result.deletedCount, deleted);
    assert.deepEqual(await titles(), remaining);
    observations.push({ query, deleted, remaining: await titles() });
  }
  console.log('PASS production HTTP retention defaults/positive/zero/invalid and live JWT/RBAC; LLM requests=0');

} catch (error) {
  failure = error;
} finally {
  const cleanup: unknown[] = [];
  for (const step of [stop, () => pool.end(), async () => { if (created) await admin.query(`DROP DATABASE ${schema}`); }, () => admin.end()]) {
    try { await step(); } catch (error) { cleanup.push(error); }
  }
  writeFileSync(resolve(output, 'http-results.json'), JSON.stringify({ schema, observations, cleanupErrors: cleanup.map(String), passed: !failure && !cleanup.length }, null, 2));
  if (failure || cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], 'MAX-563 acceptance failed; business and cleanup failures retained');
  console.log('PASS child stopped; exclusive schema dropped; no shared business data changed');
}
