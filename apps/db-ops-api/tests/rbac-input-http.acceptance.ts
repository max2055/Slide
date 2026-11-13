/** #493/#494/#495: real server.ts, login/JWT, disposable migrated MySQL.
 * RBAC_TEST_MYSQL_URL=<admin URL> pnpm --filter slide-api exec tsx tests/rbac-input-http.acceptance.ts
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
const schema = `max342_${randomBytes(6).toString('hex')}`;
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
      [`max342_${name}`, await bcrypt.hash(password, 10), 'active']);
    actors[name] = user.insertId;
    const [role] = await pool.execute<any>('INSERT INTO roles (name) VALUES (?)', [`max342_${name}`]);
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
    const login = await request('POST', '/api/auth/login', { username: `max342_${name}`, password });
    assert.equal(login.status, 200, `real login ${name}`);
    assert(login.body.token);
    tokens.push(login.body.token);
  }
  const snapshot = async () => {
    const rows = [];
    for (const table of ['roles', 'permissions', 'role_permissions', 'user_roles', 'instance_permissions']) {
      rows.push((await pool.query(`SELECT * FROM ${table} ORDER BY id`))[0]);
    }
    return JSON.stringify(rows);
  };
  const before = await snapshot();
  const writes = [
    ['POST', '/roles'], ['PUT', `/roles/${roles.viewer}`], ['POST', '/permissions'],
    ['POST', `/roles/${roles.viewer}/permissions`], ['POST', `/users/${actors.viewer}/roles`],
    ['POST', `/users/${actors.viewer}/instances`],
  ];
  for (const [method, path] of writes) {
    for (const body of [null, undefined, [], ['x'], 1, true, 'text']) {
      assert.equal((await rbac(method, path, body)).status, 400, `${method} ${path}: body shape`); checks++;
    }
    assert.equal((await rbac(method, path, null, tokens[1])).status, 403); checks++;
    assert.equal((await rbac(method, path, null, '')).status, 401); checks++;
    assert.equal((await rbac(method, path, null, 'invalid-jwt')).status, 401); checks++;
  }
  console.log('PASS #493: six write routes reject body shapes, preserve real JWT/permission guards');
  const idRoutes: Array<[string, string, unknown?]> = [
    ['GET', '/roles/BAD'], ['PUT', '/roles/BAD', { description: 'updated' }],
    ['DELETE', '/roles/BAD'], ['DELETE', '/permissions/BAD'],
    ['POST', '/roles/BAD/permissions', { permissionId: 1 }],
    ['GET', '/roles/BAD/permissions'], ['DELETE', '/roles/BAD/permissions/1'], ['DELETE', '/roles/1/permissions/BAD'],
    ['POST', '/users/BAD/roles', { roleId: 1 }], ['GET', '/users/BAD/roles'],
    ['DELETE', '/users/BAD/roles/1'], ['DELETE', '/users/1/roles/BAD'],
    ['POST', '/users/BAD/instances', { instanceId: 1 }], ['GET', '/users/BAD/instances'],
    ['DELETE', '/users/BAD/instances/1'], ['DELETE', '/users/1/instances/BAD'],
  ];
  for (const [method, path, body] of idRoutes) {
    for (const id of ['not-a-number', '0', '-1', '1.5', '9007199254740992', '1e2', '0x10', '%20']) {
      assert.equal((await rbac(method, path.replace('BAD', id), body)).status, 400, `${method} ${path}: ${id}`); checks++;
    }
  }
  for (const [path, key] of [[`/roles/${roles.viewer}/permissions`, 'permissionId'], [`/users/${actors.viewer}/roles`, 'roleId'], [`/users/${actors.viewer}/instances`, 'instanceId']]) {
    for (const value of [true, [], [1], null, 0, -1, 1.5, 'NaN', 9007199254740992]) {
      assert.equal((await rbac('POST', path, { [key]: value })).status, 400); checks++;
    }
  }
  assert.equal((await rbac('GET', '/roles/2147483647')).status, 404); checks++;
  assert.equal((await rbac('GET', '/roles/9007199254740991')).status, 404); checks++;
  console.log('PASS #494: all ID positions reject invalid IDs; valid missing role IDs return 404');
  const valid = { code: 'fixture:read', name: '读取', resource: 'fixture', action: 'read' };
  const invalid: unknown[] = [{ code: valid.code }];
  for (const field of ['code', 'name', 'resource', 'action']) {
    for (const value of [undefined, null, '', '  ', 1, true, [], {}]) invalid.push({ ...valid, [field]: value });
  }
  for (const [field, length] of [['code', 101], ['name', 101], ['resource', 51], ['action', 51], ['description', 256]] as const) {
    invalid.push({ ...valid, [field]: 'a'.repeat(length) });
  }
  invalid.push({ ...valid, resource: 'other' }, { ...valid, action: 'write' }, { ...valid, description: {} });
  for (const body of invalid) { assert.equal((await rbac('POST', '/permissions', body)).status, 400); checks++; }
  assert.equal(await snapshot(), before, 'all rejected requests preserve RBAC tables'); checks++;
  const resource = 'r'.repeat(49), action = 'a'.repeat(50);
  const created = await rbac('POST', '/permissions', { code: `${resource}:${action}`, name: '权'.repeat(100), resource, action, description: '描'.repeat(255) });
  assert.equal(created.status, 201); checks++;
  const [stored] = await pool.query<any[]>('SELECT code,name,resource,action,description FROM permissions WHERE id=?', [created.body.permissionId]);
  assert.deepEqual(stored[0], { code: `${resource}:${action}`, name: '权'.repeat(100), resource, action, description: '描'.repeat(255) }); checks++;
  const role = await rbac('POST', '/roles', { name: '角'.repeat(50), description: '描'.repeat(255) });
  assert.equal(role.status, 201); checks++;
  assert.equal((await rbac('PUT', `/roles/${role.body.roleId}`, { name: 'max342_updated', description: '' })).status, 200); checks++;
  assert.equal((await rbac('GET', `/roles/${role.body.roleId}`)).body.name, 'max342_updated'); checks++;
  assert.equal((await rbac('POST', `/roles/${role.body.roleId}/permissions`, { permissionId: String(created.body.permissionId) })).status, 201); checks++;
  assert.equal((await rbac('GET', `/roles/${role.body.roleId}/permissions`)).body.length, 1); checks++;
  console.log('PASS #495: required fields/lengths/code consistency; rejects preserve DB; boundary-length permission stored unchanged; role CRUD/assignment works');
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
