/** Full API acceptance (#626/#627), explicitly enabled with MAX675_HTTP=1.
 * Inject MAX675_MYSQL_CONFIG and MAX675_EVIDENCE_DIR; credentials stay in memory.
 * pnpm --filter slide-api exec tsx tests/user-preferences.real.ts
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../src/testing/owned-fixture.js';

if (process.env.MAX675_HTTP !== '1' || !process.env.MAX675_MYSQL_CONFIG || !process.env.MAX675_EVIDENCE_DIR) {
  throw new Error('Explicit acceptance requires MAX675_HTTP=1, MAX675_MYSQL_CONFIG and MAX675_EVIDENCE_DIR');
}
const config = JSON.parse(process.env.MAX675_MYSQL_CONFIG) as mysql.PoolOptions;
const output = process.env.MAX675_EVIDENCE_DIR;
mkdirSync(output, { recursive: true });
const cwd = fileURLToPath(new URL('../', import.meta.url));
const admin = mysql.createPool({ ...config, connectionLimit: 1, connectTimeout: 3000 });
let owned: OwnedDatabase | undefined;
let pool: mysql.Pool | undefined;
let api: ChildProcess | undefined;
let modelCalls = 0;
const modelEndpoint = createHttpServer((_request, response) => { modelCalls++; response.writeHead(503).end(); });
const events: Record<string, unknown>[] = [];
const record = (event: string, details: Record<string, unknown> = {}) => {
  events.push({ event, ...details });
  writeFileSync(join(output, 'http.json'), JSON.stringify(events, null, 2));
  console.log(event, details);
};
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
function start(name: string, args: string[], env: NodeJS.ProcessEnv) {
  const log = createWriteStream(join(output, `${name}.log`));
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
  child.once('close', () => log.end());
  return child;
}
async function completed(child: ChildProcess, timeout: number) {
  return new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Child completion timeout')), timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.env.MULTICA_CLI_PATH) {
    const daemon = JSON.parse(execFileSync(process.env.MULTICA_CLI_PATH, ['daemon', 'status', '--output', 'json'], { encoding: 'utf8' }));
    assert.notEqual(child.pid, daemon.pid);
  }
  record('stop-owned-api', { pid: child.pid,
    command: execFileSync('ps', ['-p', String(child.pid), '-o', 'pid,ppid,command'], { encoding: 'utf8' }).trim() });
  const exit = completed(child, 15000);
  child.kill('SIGTERM');
  try { assert.equal(await exit, 0, 'API graceful shutdown'); }
  catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const forcedExit = completed(child, 5000);
      child.kill('SIGKILL');
      await forcedExit;
    }
    throw error;
  }
}

try {
  owned = await createOwnedDatabase(admin, { nonce: generateRunNonce(), purpose: 'max675http', handleDir: output });
  const port = await freePort();
  const wsPort = await freePort();
  const password = randomBytes(24).toString('hex');
  const env = { ...process.env, DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user,
    DB_PASSWORD: config.password, DB_NAME: owned.database, JWT_SECRET_KEY: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'), INITIAL_ADMIN_USERNAME: 'max675admin', INITIAL_ADMIN_PASSWORD: password,
    NODE_ENV: 'production', CORS_ORIGINS: 'http://127.0.0.1', PORT: String(port), AGENT_WS_PORT: String(wsPort), PROMPT_HOT_RELOAD: 'false',
    METRICS_COLLECTION_ENABLED: 'false', INVESTIGATION_SYSTEM_EVENTS_ENABLED: 'false', INVESTIGATION_SYSTEM_AUTO_ENABLED: 'false',
    ANALYSIS_DISPATCH_ENABLED: 'false', SLIDE_MEMORY_PIPELINE_ENABLED: 'false', AGENT_WORKSPACE: join(output, 'agent-workspace') };
  const initializer = start('http-init', ['--import', 'tsx', 'init-db.ts'], env);
  try { assert.equal(await completed(initializer, 60000), 0, 'Migration initialization'); }
  finally { if (initializer.exitCode === null && initializer.signalCode === null) await stop(initializer); }
  pool = mysql.createPool({ ...config, database: owned.database, connectionLimit: 2 });
  // An observed local endpoint prevents external model traffic and counts unexpected requests.
  await new Promise<void>((resolve, reject) => { modelEndpoint.once('error', reject); modelEndpoint.listen(0, '127.0.0.1', resolve); });
  const modelAddress = modelEndpoint.address();
  assert.ok(modelAddress && typeof modelAddress === 'object');
  await pool.query('UPDATE llm_providers SET enabled=FALSE, is_default=FALSE');
  await pool.execute("UPDATE llm_providers SET enabled=TRUE, is_default=TRUE, api_format='openai-completions', api_base_url=? WHERE name='ollama'",
    [`http://127.0.0.1:${modelAddress.port}`]);
  api = start('http-api', ['--import', 'tsx', 'server.ts'], env);
  record('environment', { database: owned.database, cwd, port, wsPort, pid: api.pid,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() });
  const request = (path: string, token?: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : path === '/api/auth/login' ? 'POST' : 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000),
  });
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline && api.exitCode === null) {
    try { if ((await request('/api/health/ready')).ok) { ready = true; break; } } catch { /* startup */ }
    await delay(200);
  }
  assert.ok(ready, 'Actual API became ready');
  const login = await request('/api/auth/login', undefined, { username: 'max675admin', password });
  assert.equal(login.status, 200);
  const { token } = await login.json() as { token: string };
  assert.ok(token);
  const unauthenticated = await request('/api/user/preferences', undefined, { preferences: { navWidth: 999 } });
  record('unauthenticated-observation', { status: unauthenticated.status, body: await unauthenticated.json() });
  assert.ok(!unauthenticated.ok, 'Unauthenticated writes must be rejected');
  const [users] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM users WHERE username='max675admin'");
  const userId = users[0].id;
  async function stored() {
    const [rows] = await pool!.query<mysql.RowDataPacket[]>('SELECT preferences FROM user_preferences WHERE user_id=?', [userId]);
    return rows[0]?.preferences;
  }
  for (const existing of [false, true]) {
    await pool.execute('DELETE FROM user_preferences WHERE user_id=?', [userId]);
    if (existing) await pool.execute('INSERT INTO user_preferences (user_id, preferences) VALUES (?, ?)', [userId, '{"defaultModel":"retained"}']);
    const completedRequests = await Promise.allSettled([
      request('/api/user/preferences', token, { preferences: { navWidth: 410, visibleTabs: [], visibleTabsConfigured: true } }),
      request('/api/user/preferences', token, { preferences: { notificationEnabled: false, defaultPageSize: 100 } }),
    ]);
    const responses = completedRequests.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true }); }
    const prefs = await stored();
    assert.equal(prefs.navWidth, 410); assert.equal(prefs.notificationEnabled, false); assert.equal(prefs.defaultPageSize, 100);
    assert.deepEqual(prefs.visibleTabs, []); assert.equal(prefs.visibleTabsConfigured, true);
    if (existing) assert.equal(prefs.defaultModel, 'retained');
    assert.equal((await request('/api/user/preferences', token, { preferences: { navWidth: 420 } })).status, 200);
    const get = await request('/api/user/preferences', token);
    assert.equal(get.status, 200);
    const read = (await get.json() as { preferences: { navWidth: number; notificationEnabled: boolean } }).preferences;
    assert.equal(read.navWidth, 420); assert.equal(read.notificationEnabled, false);
    record('concurrent-http-save', { existing, statuses: responses.map(response => response.status), navWidth: 420, notificationEnabled: false });
  }
  await pool.execute('UPDATE user_preferences SET preferences=? WHERE user_id=?', ['[]', userId]);
  const invalid = await request('/api/user/preferences', token, { preferences: { navWidth: 500 } });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { success: false, error: '用户偏好数据损坏：必须是 JSON 对象' });
  assert.deepEqual(await stored(), []);
  record('corrupt-json-http-rejected', { status: 400, originalPreserved: true });
  assert.equal(modelCalls, 0, 'No model requests during preference acceptance');
  record('acceptance', { passed: true, modelCalls });
} catch (error) {
  record('acceptance-failure', { error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  // Complete in-flight requests before closing the API, pools and owned schema.
  try { if (api) await stop(api); }
  finally {
    try { await pool?.end(); await owned?.drop(); record('cleanup', { ownedSchemaRemoved: true }); }
    finally {
      try { await admin.end(); }
      finally { if (modelEndpoint.listening) await new Promise<void>((resolve, reject) => modelEndpoint.close(error => error ? reject(error) : resolve())); }
    }
  }
}
