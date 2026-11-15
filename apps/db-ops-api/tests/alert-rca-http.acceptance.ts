/** MAX-571 / #425/#485. Explicit MAX571_MYSQL_* and MAX571_OUTPUT_DIR.
 * Full production server and formal migrations on an exclusive schema.
 * Browser observes persisted legacy RCA rows; POST admission is injected only
 * for the legacy browser handoff. Real missing/fault/authority POSTs use server.
 * No collector or model execution is claimed or enabled.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { createRequire } from 'node:module';
import { MigrationRunner } from '../src/migrations/runner.js';

for (const key of ['MAX571_MYSQL_HOST', 'MAX571_MYSQL_PORT', 'MAX571_MYSQL_USER', 'MAX571_MYSQL_PASSWORD', 'MAX571_OUTPUT_DIR']) {
  assert(process.env[key] !== undefined, `${key} required`);
}
const config = { host: process.env.MAX571_MYSQL_HOST!, port: Number(process.env.MAX571_MYSQL_PORT),
  user: process.env.MAX571_MYSQL_USER!, password: process.env.MAX571_MYSQL_PASSWORD! };
assert(Number.isInteger(config.port) && config.port > 0);
const output = resolve(process.env.MAX571_OUTPUT_DIR!);
mkdirSync(output, { recursive: true });
const schema = `max571_${randomBytes(6).toString('hex')}`;
const admin = mysql.createPool(config);
const pool = mysql.createPool({ ...config, database: schema });
const username = 'max571_operator';
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
let browser: any;
let vite: ReturnType<typeof spawn> | undefined;
let viteClosed: Promise<unknown> | undefined;
let viteLog = '';
try {
  assert.equal(config.port, 3308, 'explicit shared test endpoint only');
  const [occupancy] = await admin.query<any[]>('SELECT ID, DB, COMMAND FROM information_schema.PROCESSLIST WHERE DB IS NOT NULL');
  observations.push({ phase: 'preflight', connections: occupancy.map(row => ({ id: row.ID, schema: row.DB, command: row.COMMAND })) });
  await admin.query(`CREATE DATABASE ${schema}`); created = true;
  await new MigrationRunner(pool as any).run();
  await pool.execute('UPDATE llm_providers SET enabled=FALSE,is_default=FALSE');
  await pool.query("INSERT INTO database_instances(id,name,host,port,username,password_encrypted) VALUES(571,'RCA验收','fixture.invalid',3308,'fixture','unused')");
  await pool.query("INSERT INTO alerts(id,instance_id,alert_type,level,title,message,status) VALUES(571,571,'performance','warning','RCA隔离验收','仅测试持久化观察','unread')");
  await pool.query("INSERT INTO ai_analysis(id,analysis_type,target_type,instance_id,related_id,status,trigger_type) VALUES(571,'alert_rca','instance',571,571,'running','manual')");
  const base = await start();
  const login = await request(base, '/api/auth/login', { username, password }, 200);
  const token = login.token;
  assert.match((await request(base, '/api/alerts/999999/investigation', {}, 422, token)).error, /不存在/);
  await request(base, '/api/alerts/571/investigation', {}, 401);
  await request(base, '/api/users', { username: 'max571_reader', password: 'synthetic-password' }, 201, token);
  const reader = await request(base, '/api/auth/login', { username: 'max571_reader', password: 'synthetic-password' }, 200);
  await pool.query("INSERT INTO roles(id,name) VALUES(571,'max571_role')");
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT id,571 FROM users WHERE username='max571_reader'");
  for (const code of ['ai:view', 'ai:manage']) await pool.execute('INSERT IGNORE INTO permissions(code,name,resource,action) VALUES (?,?,?,?)', [code, code, ...code.split(':')]);
  await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 571,id FROM permissions WHERE code IN ('ai:view','ai:manage')");
  await request(base, '/api/alerts/571/investigation', {}, 404, reader.token);
  await request(base, '/api/ai/analysis/571/status', undefined, 404, reader.token, 'GET', false);
  await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) SELECT id,571,'read-only' FROM users WHERE username='max571_reader'");
  await request(base, '/api/ai/analysis/571/status', undefined, 200, reader.token, 'GET', false);
  await pool.query("DELETE FROM instance_permissions WHERE instance_id=571");
  await request(base, '/api/ai/analysis/571/status', undefined, 404, reader.token, 'GET', false);
  await pool.query("DELETE FROM role_permissions WHERE role_id=571");
  await request(base, '/api/alerts/571/investigation', {}, 403, reader.token);
  observations.push({ case: 'real JWT/current permissions and resource masking grant/revoke', passed: true });
  // Schema-local SELECT fault, restored before any subsequent business read.
  await pool.query('ALTER TABLE alerts RENAME COLUMN metric_name TO max571_fault_metric');
  const unavailable = await request(base, '/api/alerts/571/investigation', {}, 503, token);
  assert(!JSON.stringify(unavailable).includes('不存在'));
  await pool.query('ALTER TABLE alerts RENAME COLUMN max571_fault_metric TO metric_name');
  assert.match((await request(base, '/api/alerts/999999/investigation', {}, 422, token)).error, /不存在/);
  observations.push({ case: 'real SQL column failure => 503; restored zero-row => missing', passed: true });
  const vitePort = await freePort();
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: resolve('../../frontend'), env: { ...process.env, VITE_API_PROXY_TARGET: base }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  viteClosed = once(vite, 'close'); vite.stdout!.on('data', chunk => { viteLog += chunk; }); vite.stderr!.on('data', chunk => { viteLog += chunk; });
  const url = `http://127.0.0.1:${vitePort}/e2e/fixtures/alert-rca.html`;
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) { ready = true; break; } } catch {} await delay(100); }
  assert(ready, 'Vite deadline');
  const { chromium, expect } = createRequire(resolve('../../frontend/package.json'))('@playwright/test');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  observations.push({ browser: browser.version(), engine: 'installed Microsoft Edge stable', api: base, vite: url });
  await page.goto(url);
  await page.evaluate(async token => { localStorage.token = token; await (window as any).ready(); }, token);
  let submissions = 0, reads = 0, inFlight = 0, maxInFlight = 0;
  let mode: 'real' | '503' | 'slow' | 'unknown' = 'real';
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>(done => { releaseSlow = done; });
  await page.route('**/api/alerts/571/investigation', async route => {
    submissions++;
    // Only browser legacy admission handoff is controlled; subsequent reads
    // and the error/permission HTTP cases above run production handlers.
    await route.fulfill({ json: { success: true, id: 571, status: 'running' } });
  });
  await page.route('**/api/ai/analysis/571/status', async route => {
    reads++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (mode === '503') await route.fulfill({ status: 503, json: { error: 'controlled-read-fault' } });
      else if (mode === 'unknown') await route.fulfill({ json: { status: 'unknown' } });
      else if (mode === 'slow') { await slowGate; await route.fulfill({ json: { status: 'running' } }).catch(() => {}); }
      else await route.continue();
    } finally { inFlight--; }
  });
  await page.clock.install();
  const begin = async () => page.evaluate(async () => { const el = (window as any).alerts; await el._startRCA({ id: 571 }); await el.updateComplete; });
  const advance = async (ms: number) => { await page.clock.runFor(ms); await delay(50); };
  await begin();
  // Real running rows, browser time moves while HTTP remains real.
  for (let i = 0; i < 20; i++) await advance(3000);
  await expect(page.getByRole('status').filter({ hasText: '状态未知' }).first()).toBeVisible();
  assert(reads > 0); assert.equal(maxInFlight, 1);
  const before = reads; await advance(9000); assert.equal(reads, before);
  observations.push({ case: 'persisted running observation deadline 60s', reads, submissions, maxInFlight, passed: true });
  // Resume reads the same persisted result, never repeats the model POST.
  await pool.query("UPDATE ai_analysis SET status='completed',result=JSON_OBJECT('summary','持久化恢复结果') WHERE id=571");
  await page.getByRole('button', { name: '继续观察', exact: true }).first().focus(); await page.keyboard.press('Enter');
  await advance(3000);
  await expect.poll(() => page.evaluate(() => (window as any).alerts.diagnosisStatus)).toBe('completed');
  assert.equal(submissions, 1);
  const result = await page.evaluate(() => (window as any).alerts.diagnosisResult);
  assert.equal(result.summary, '持久化恢复结果');
  observations.push({ case: 'keyboard resume -> actual status/result HTTP -> same MySQL row; POST count unchanged', passed: true });
  mode = '503'; await begin();
  for (let i = 0; i < 20; i++) await advance(3000);
  await expect(page.getByRole('status').filter({ hasText: '状态未知' }).first()).toBeVisible();
  observations.push({ case: 'controlled HTTP503 bounded observation', passed: true });
  mode = 'unknown';
  await page.getByRole('button', { name: '继续观察', exact: true }).first().click(); await advance(3000);
  await expect(page.getByRole('status').filter({ hasText: '状态未知' }).first()).toBeVisible();
  for (const [width,height] of [[1440,900],[1366,768],[1920,1080]]) {
    await page.setViewportSize({width,height});
    const resume = page.getByRole('button', { name: '继续观察', exact: true }).first();
    await expect(resume).toBeInViewport(); await expect(resume).toHaveAccessibleName('继续观察');
    await page.screenshot({ path: resolve(output, `unknown-${width}x${height}.png`) });
  }
  mode = 'slow';
  const beforeSlow = reads;
  await page.getByRole('button', { name: '继续观察', exact: true }).first().click();
  await page.clock.runFor(3000);
  await expect.poll(() => reads).toBe(beforeSlow + 1);
  await page.clock.runFor(15_000);
  assert.equal(reads, beforeSlow + 1, 'pending read never overlaps another poll');
  await page.evaluate(() => { const el = (window as any).alerts; el.activeRCAAnalysis = { alertId: 572, analysisId: 572 }; el._startDiagnosisPolling(572); el.remove(); });
  releaseSlow(); await delay(100);
  assert.equal(await page.evaluate(() => (window as any).alerts.diagnosisResult), null);
  const stopped = reads; await advance(9000); assert.equal(reads, stopped);
  observations.push({ case: 'slow response after switch and unmount is ignored; no more reads', passed: true });
  // Real connection lifecycle: use a dedicated pool, never stop shared mysql3308.
  const { dbConnection } = await import('../src/db-connection.js');
  const { AlertRCAService } = await import('../src/alert-rca-service.js');
  const local = mysql.createPool({ ...config, database: schema });
  const original = dbConnection.getPool;
  dbConnection.getPool = () => local;
  try {
    await local.end();
    await assert.rejects(new AlertRCAService().analyzeAlert(571), /ALERT_RCA_SERVICE_UNAVAILABLE/);
    dbConnection.getPool = () => null;
    await assert.rejects(new AlertRCAService().analyzeAlert(571), /ALERT_RCA_SERVICE_UNAVAILABLE/);
  } finally { dbConnection.getPool = original; }
  observations.push({ case: 'closed real mysql2 pool and absent pool are unavailable, not missing', passed: true });
  assert(logs.includes('获取告警详情失败'), 'server SQL failure log retained');
  console.log('PASS browser + production HTTP/JWT + isolated MySQL; model requests=0');
} catch (error) { failure = error; }
finally {
  const cleanup: unknown[] = [];
  for (const step of [async () => { await browser?.close(); }, async () => { if (vite) { vite.kill('SIGTERM'); await viteClosed; } writeFileSync(resolve(output, 'vite.log'), viteLog); }, stop, () => pool.end(), async () => { if (created) await admin.query(`DROP DATABASE ${schema}`); }, () => admin.end()]) {
    try { await step(); } catch (error) { cleanup.push(error); }
  }
  writeFileSync(resolve(output, 'http-results.json'), JSON.stringify({ schema, observations, failure: failure ? String(failure) : null, cleanupErrors: cleanup.map(String), passed: !failure && !cleanup.length }, null, 2));
  if (failure || cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], 'MAX-571 acceptance failed; business and cleanup failures retained');
  console.log('PASS browser and child stopped; exclusive schema dropped');
}
