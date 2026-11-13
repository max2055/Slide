/** #317: real server.ts, login/JWT, disposable migrated MySQL.
 * RBAC_TEST_MYSQL_URL=<admin URL> pnpm --filter slide-api exec tsx tests/rbac-instance-grant-http.acceptance.ts
 * Only creates/drops its randomly named schema; no model calls.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import { MigrationRunner } from '../src/migrations/runner.js';

assert(process.env.RBAC_TEST_MYSQL_URL, 'RBAC_TEST_MYSQL_URL required');
const url = new URL(process.env.RBAC_TEST_MYSQL_URL);
const schema = `max357_${randomBytes(6).toString('hex')}`;
const connectionOptions = { host: url.hostname, port: Number(url.port || 3306),
  user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  connectTimeout: 5000, charset: 'utf8mb4', timezone: 'Z' };
console.log(`Isolated schema: ${schema}; MySQL endpoint: ${url.hostname}:${connectionOptions.port}`);
const admin = mysql.createPool(connectionOptions);
await admin.query(`CREATE DATABASE ${schema}`);
const pool = mysql.createPool({ ...connectionOptions, database: schema });
const password = randomBytes(24).toString('hex');
let child: ReturnType<typeof spawn> | undefined;
let exited: Promise<unknown> | undefined;
let logs = '';
let checks = 0;
const tokens: string[] = [];
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
  const actors: Record<string, number> = {};
  const roles: Record<string, number> = {};
  for (const name of ['manager', 'viewer']) {
    const [user] = await pool.execute<any>('INSERT INTO users (username,password_hash,status) VALUES (?,?,?)',
      [`max357_${name}`, await bcrypt.hash(password, 10), 'active']);
    actors[name] = user.insertId;
    const [role] = await pool.execute<any>('INSERT INTO roles (name) VALUES (?)', [`max357_${name}`]);
    roles[name] = role.insertId;
    await pool.execute('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)', [user.insertId, role.insertId]);
  }
  await pool.execute('INSERT IGNORE INTO permissions (code,name,resource,action) VALUES (?,?,?,?)', ['admin:*', 'fixture manager', 'admin', '*']);
  await pool.execute('INSERT INTO role_permissions (role_id,permission_id) SELECT ?,id FROM permissions WHERE code=?', [roles.manager, 'admin:*']);
  const port = await freePort(), wsPort = await freePort();
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', DB_HOST: url.hostname, DB_PORT: url.port || '3306',
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password), DB_NAME: schema,
      JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      PORT: String(port), AGENT_WS_PORT: String(wsPort), PROMPT_HOT_RELOAD: 'false' },
  });
  console.log(`Owned server: PID=${child.pid}; HTTP=${port}; WS=${wsPort}; cwd=slide-api; command=node --import tsx server.ts`);
  child.stdout!.on('data', chunk => { logs += chunk; });
  child.stderr!.on('data', chunk => { logs += chunk; });
  exited = once(child, 'exit');
  let ready = false;
  for (let attempt = 0; attempt < 600; attempt++) {
    assert(child.exitCode === null && child.signalCode === null, 'server exited before readiness');
    try { ready = (await fetch(`http://127.0.0.1:${port}/api/health/ready`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'full server readiness timeout');
  const request = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const rbac = (method: string, path: string, body?: unknown, token = tokens[0]) => request(method, `/api/v1/rbac${path}`, body, token);
  for (const name of ['manager', 'viewer']) {
    const login = await request('POST', '/api/auth/login', { username: `max357_${name}`, password });
    assert.equal(login.status, 200, `real login ${name}`);
    assert(login.body.token);
    tokens.push(login.body.token);
  }
  const [instance] = await pool.execute<any>(`INSERT INTO database_instances
    (name,host,port,username,password_encrypted) VALUES ('grant-fixture','fixture.invalid',3306,'fixture','unused')`);
  const instanceId = instance.insertId;
  const path = `/users/${actors.viewer}/instances`;
  const grant = (accessLevel?: string) => rbac('POST', path, { instanceId, ...(accessLevel ? { accessLevel } : {}) });
  const state = async () => (await pool.query<any[]>('SELECT id,access_level,grant_expiry,created_at FROM instance_permissions WHERE user_id=? AND instance_id=?', [actors.viewer, instanceId]))[0];
  for (let round = 0; round < 10; round++) {
    await pool.execute('DELETE FROM instance_permissions WHERE user_id=?', [actors.viewer]);
    const results = await Promise.all(Array.from({ length: 16 }, () => grant('read-write')));
    assert(results.every(r => r.status === 201 && r.body.success === true));
    const rows = await state();
    assert.equal(rows.length, 1); assert.equal(rows[0].access_level, 'read-write'); checks++;
  }
  console.log('PASS same grants: 10 bursts x 16 concurrent real HTTP requests, all 201, one row');
  for (let round = 0; round < 10; round++) {
    await pool.execute('DELETE FROM instance_permissions WHERE user_id=?', [actors.viewer]);
    const levels = ['read-only', 'read-write', 'admin'];
    const results = await Promise.all(Array.from({ length: 18 }, (_, i) => grant(levels[i % 3])));
    assert(results.every(r => r.status === 201 && r.body.success === true));
    const rows = await state(); assert.equal(rows.length, 1); assert(levels.includes(rows[0].access_level)); checks++;
  }
  console.log('PASS mixed levels: 10 bursts x 18, all 201, one legal final level (database last write wins)');
  await pool.execute('UPDATE instance_permissions SET grant_expiry=DATE_ADD(NOW(), INTERVAL 1 DAY) WHERE user_id=?', [actors.viewer]);
  const original = (await state())[0];
  for (const level of ['admin', 'read-write', undefined]) {
    assert.equal((await grant(level)).status, 201);
    const row = (await state())[0];
    assert.equal(row.access_level, level ?? 'read-only');
    assert.equal(row.id, original.id); assert.deepEqual(row.grant_expiry, original.grant_expiry);
    assert.deepEqual(row.created_at, original.created_at); checks++;
  }
  const before = JSON.stringify(await state());
  for (const payload of [{ instanceId: 0 }, { instanceId: [] }, { instanceId, accessLevel: 'root' }, null]) {
    assert.equal((await rbac('POST', path, payload)).status, 400); checks++;
  }
  assert.equal((await rbac('POST', path, { instanceId }, tokens[1])).status, 403); checks++;
  assert.equal((await rbac('POST', path, { instanceId }, '')).status, 401); checks++;
  assert.equal((await rbac('POST', path, { instanceId }, 'invalid-jwt')).status, 401); checks++;
  assert.equal(JSON.stringify(await state()), before); checks++;
  console.log('PASS existing grant metadata/default read-only and invalid input/JWT/permission guards');
  await pool.execute('DELETE FROM role_permissions WHERE role_id=?', [roles.manager]);
  assert.equal((await rbac('POST', '/roles', { name: 'revoked' })).status, 403); checks++;
  assert(!logs.includes(password), 'no password in server logs');
  for (const token of tokens) assert(!logs.includes(token), 'no JWT in server logs');
  console.log(`PASS ${checks} HTTP/DB assertions; real server.ts/login/JWT/MySQL; live permission revocation; no model requests`);
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
  console.log('CLEANUP: generated schema dropped; owned server stopped');
}
