/** #369/#559: full server, real JWT and disposable migrated MySQL schema.
 * SCORING_TEST_MYSQL_CONFIG must be an explicit mysql2 connection options JSON.
 * Run: pnpm --filter slide-api exec tsx tests/scoring-config-http.acceptance.ts
 * No default database, private credential files, model calls or historical migration edits.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import { MigrationRunner } from '../src/migrations/runner.js';

assert(process.env.SCORING_TEST_MYSQL_CONFIG, 'SCORING_TEST_MYSQL_CONFIG required');
const config = JSON.parse(process.env.SCORING_TEST_MYSQL_CONFIG);
assert(config.host && config.port && config.user, 'Explicit MySQL host/port/user required');
const schema = `max6_scoring_${randomBytes(6).toString('hex')}`;
const admin = mysql.createPool({ ...config, database: undefined });
await admin.query(`CREATE DATABASE ${schema}`);
const pool = mysql.createPool({ ...config, database: schema });
const password = randomBytes(24).toString('hex');
const weights = { availability: .35, performance: .35, capacity: .2, security: .1 };
const changed = { availability: .4, performance: .3, capacity: .2, security: .1 };
let child: ReturnType<typeof spawn> | undefined;
let exited: Promise<unknown> | undefined;
let checks = 0;
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
try {
  await new MigrationRunner(pool as any).run();
  await pool.execute('UPDATE llm_providers SET enabled=FALSE, is_default=FALSE');
  const [actor] = await pool.execute<any>('INSERT INTO users(username,password_hash,status) VALUES(?,?,?)',
    ['max6_writer', await bcrypt.hash(password, 10), 'active']);
  const [role] = await pool.execute<any>('INSERT INTO roles(name,description) VALUES(?,?)', ['max6_writer', 'scoring acceptance']);
  await pool.execute('INSERT INTO user_roles(user_id,role_id) VALUES(?,?)', [actor.insertId, role.insertId]);
  await pool.execute("INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code IN ('metric:view','metric:manage')", [role.insertId]);
  const port = await freePort();
  const wsPort = await freePort();
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', DB_HOST: config.host, DB_PORT: String(config.port),
      DB_USER: config.user, DB_PASSWORD: config.password, DB_NAME: schema,
      JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      PORT: String(port), AGENT_WS_PORT: String(wsPort), PROMPT_HOT_RELOAD: 'false' },
  });
  child.stdout!.resume();
  child.stderr!.resume();
  exited = once(child, 'exit');
  let ready = false;
  for (let attempt = 0; attempt < 600; attempt++) {
    assert(child.exitCode === null && child.signalCode === null, 'server exited before readiness');
    try { ready = (await fetch(`http://127.0.0.1:${port}/api/health/ready`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'full server readiness timeout');
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'max6_writer', password }) });
  assert.equal(login.status, 200);
  const { token } = await login.json() as any;
  assert(token);
  const put = async (body: unknown, auth: string | null = token) => {
    const response = await fetch(`${base}/api/scoring/config`, { method: 'PUT',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const row = async () => (await pool.query<any[]>("SELECT id,config_value,value_type,description,updated_by FROM system_config WHERE config_key='scoring.weights'"))[0][0];
  // New insert and default metadata, through the normal HTTP entry point.
  await pool.execute("DELETE FROM system_config WHERE config_key='scoring.weights'");
  assert.equal((await put(weights)).status, 200);
  const inserted = await row();
  assert.equal(inserted.value_type, 'json'); assert.equal(inserted.updated_by, null); checks++;
  await pool.execute("UPDATE system_config SET value_type='string',description='preserve scoring metadata',updated_by=? WHERE config_key='scoring.weights'", [actor.insertId]);
  const before = await row();
  for (const invalid of [null, false, true, 123, 'weights', [], [weights], {}, { availability: .35 },
    { ...weights, security: null }, { ...weights, security: '0.1' }, { ...weights, availability: -1 },
    { ...weights, availability: 1.1 }, { ...weights, availability: .1 }]) {
    const result = await put(invalid);
    assert.equal(result.status, 400, JSON.stringify(invalid));
    assert(!JSON.stringify(result.body).includes('TypeError'));
    assert.deepEqual(await row(), before, 'invalid request must not write'); checks++;
  }
  assert.equal((await put(changed, null)).status, 401); checks++;
  assert.equal((await put(changed, 'invalid')).status, 401); checks++;
  const assertMetadata = async () => {
    const stored = await row();
    assert.equal(stored.id, before.id); assert.equal(stored.description, before.description);
    assert.equal(stored.updated_by, before.updated_by); assert.equal(stored.value_type, 'json');
    return stored;
  };
  for (const value of [changed, weights, weights]) {
    assert.equal((await put(value)).status, 200);
    assert.deepEqual(JSON.parse((await assertMetadata()).config_value), value); checks++;
  }
  const read = await fetch(`${base}/api/scoring/config`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(read.status, 200); assert.deepEqual(await read.json(), weights); checks++;
  const concurrent = await Promise.all([put(changed), put(weights)]);
  assert(concurrent.every(result => result.status === 200));
  const last = JSON.parse((await assertMetadata()).config_value);
  assert([JSON.stringify(changed), JSON.stringify(weights)].includes(JSON.stringify(last))); checks++;
  // Database failure: atomic update preserves prior data; public error conceals SQL details.
  await pool.query("CREATE TRIGGER max6_fail BEFORE UPDATE ON system_config FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MAX6_INTERNAL_SQL_SENTINEL'");
  const priorFailure = await row();
  const failure = await put(changed);
  // Production HTTP security normalizes all 500 responses to INTERNAL_ERROR.
  assert.equal(failure.status, 500); assert.deepEqual(failure.body, { error: 'INTERNAL_ERROR' });
  assert.deepEqual(await row(), priorFailure); checks++;
  await pool.query('DROP TRIGGER max6_fail');
  assert.equal((await put(changed)).status, 200); await assertMetadata(); checks++;
  await pool.execute("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=? AND p.code='metric:manage'", [role.insertId]);
  const priorRevocation = await row();
  assert.equal((await put(weights)).status, 403);
  assert.deepEqual(await row(), priorRevocation); checks++;
  const [version] = await pool.query<any[]>('SELECT VERSION() AS version');
  console.log(JSON.stringify({ checks, schema, mysql: version[0].version, port: config.port,
    entry: 'full server.ts, real login/JWT, HTTP PUT/GET',
    issues: { '369': 'PASS invalid bodies 400 without writes; ranges and sum preserved',
      '559': 'PASS insert/repeated/concurrent saves preserve metadata; json type; DB failure/recovery' },
    permissions: '401 missing/invalid token; 403 same-token live permission revocation; writes unchanged',
    operatorRule: 'preserve existing updated_by; new insert NULL; no new audit attribution' }));
} finally {
  if (child && exited) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timeout = setTimeout(() => { if (child!.exitCode === null && child!.signalCode === null) child!.kill('SIGKILL'); }, 15000);
    await exited;
    clearTimeout(timeout);
  }
  await pool.end();
  await admin.query(`DROP DATABASE ${schema}`);
  await admin.end();
  console.log('CLEANUP: isolated schema dropped; owned server stopped; no model requests');
}
