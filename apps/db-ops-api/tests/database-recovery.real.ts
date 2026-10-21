/** Opt-in isolated fault drill: real MySQL, API, Vite and Chromium. No product
 * model calls, shared DB writes, external notification channels or SSH targets. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { chromium, type Browser } from '@playwright/test';

if (process.env.RUN_DATABASE_RECOVERY_DRILL !== 'true') throw new Error('Set RUN_DATABASE_RECOVERY_DRILL=true to create a disposable MySQL container');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const apiDirectory = `${root}apps/db-ops-api`;
const frontendDirectory = `${root}frontend`;
const output = process.env.RELEASE_OUTPUT_DIR;
if (!output?.startsWith('/Users/max/Coding/40-Slide/outputs/')) throw new Error('Set RELEASE_OUTPUT_DIR to a task directory under /Users/max/Coding/40-Slide/outputs');
mkdirSync(output, { recursive: true });
const container = `slide-max209-drill-${process.pid}`;
const ports = { db: 33209, api: 31209, ws: 28209, frontend: 51209 };
const secret = () => randomBytes(32).toString('hex');
const password = secret();
const environment = { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: String(ports.db), DB_USER: 'root', DB_PASSWORD: password,
  DB_NAME: 'max209_recovery', JWT_SECRET_KEY: secret(), ENCRYPTION_KEY: secret(),
  PORT: String(ports.api), AGENT_WS_PORT: String(ports.ws), PROMPT_HOT_RELOAD: 'false',
  METRICS_COLLECTION_ENABLED: 'true', INVESTIGATION_SYSTEM_EVENTS_ENABLED: 'false', INVESTIGATION_SYSTEM_AUTO_ENABLED: 'false',
  ANALYSIS_DISPATCH_ENABLED: 'false', SLIDE_MEMORY_PIPELINE_ENABLED: 'false',
  AGENT_WORKSPACE: `${output}/agent-workspace`, NODE_ENV: 'development',
  VITE_API_PROXY_TARGET: `http://127.0.0.1:${ports.api}`, VITE_AGENT_WS_PROXY_TARGET: `http://127.0.0.1:${ports.ws}` };
const children: ChildProcess[] = [];
const events: Record<string, unknown>[] = [];
let browser: Browser | undefined;
let pool: mysql.Pool | undefined;
const record = (event: string, details: Record<string, unknown> = {}) => {
  const entry = { event, at: new Date().toISOString(), ...details };
  events.push(entry); console.log(JSON.stringify(entry));
  writeFileSync(`${output}/receipt.json`, JSON.stringify({ container, ports, events, productModelCalls: 0 }, null, 2));
};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate().catch(() => false)) return; await wait(500); }
  throw new Error('DRILL_CONDITION_TIMEOUT');
}
function docker(...args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, env: { ...process.env, MYSQL_ROOT_PASSWORD: password } });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function start(name: string, cwd: string, args: string[]) {
  const logs = createWriteStream(`${output}/${name}.log`);
  const child = spawn(process.execPath, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(logs); child.stderr!.pipe(logs); children.push(child);
  return child;
}
async function run(args: string[]) {
  const child = start('initialize', apiDirectory, args);
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, 'database initialization');
}
async function request(path: string, token?: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${ports.api}${path}`, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers }, signal: AbortSignal.timeout(8_000) });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => { timer = setTimeout(resolve, 12_000); })]); }
  finally { if (timer) clearTimeout(timer); }
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
}

try {
  record('isolation', { root, commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    diff: spawnSync('git', ['diff', '--stat', '--', 'apps/db-ops-api', 'frontend'], { cwd: root, encoding: 'utf8' }).stdout.trim() });
  docker('run', '-d', '--name', container, '--label', 'slide.task=MAX-209', '--env', 'MYSQL_ROOT_PASSWORD',
    '--env', 'MYSQL_ROOT_HOST=%', '--memory', '512m', '-p', `127.0.0.1:${ports.db}:3306`, 'mysql:8.4',
    '--innodb-buffer-pool-size=32M', '--performance-schema=OFF', '--max-connections=60');
  await until(async () => {
    const connection = await mysql.createConnection({ host: '127.0.0.1', port: ports.db, user: 'root', password, connectTimeout: 1_000 });
    await connection.end(); return true;
  });
  await run(['--import', 'tsx', 'init-db.ts']);
  pool = mysql.createPool({ host: '127.0.0.1', port: ports.db, user: 'root', password, database: environment.DB_NAME });
  await pool.execute("UPDATE users SET password_hash = ?, status = 'active' WHERE username = 'admin'", [await bcrypt.hash(password, 4)]);
  await pool.execute('UPDATE llm_providers SET enabled = FALSE');
  await pool.execute("INSERT INTO servers (host, label, os_type, credential_type, credential_encrypted, collection_enabled) VALUES ('192.0.2.209', 'MAX209 isolated asset', 'linux', 'password', 'unused-disabled-fixture', 0)");
  const api = start('api', apiDirectory, ['--import', 'tsx', 'server.ts']);
  const frontend = start('frontend', frontendDirectory, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(ports.frontend), '--strictPort']);
  await until(async () => (await request('/api/health/ready')).status === 200);
  await until(async () => (await fetch(`http://127.0.0.1:${ports.frontend}`)).ok);
  const login = await request('/api/auth/login', undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
  assert.equal(login.status, 200); const session = await login.json() as { token: string; refreshToken: string };
  assert.ok(session.token); assert.ok(session.refreshToken);
  const expired = jwt.sign({ userId: 1, sessionVersion: 1 }, environment.JWT_SECRET_KEY, { expiresIn: -1 });
  assert.equal((await request('/api/resources/overview', expired)).status, 401);
  assert.equal((await request('/api/auth/refresh', undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: 'invalid-refresh' }) })).status, 401);
  record('expired-authentication', { accessStatus: 401, refreshStatus: 401 });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ token, refreshToken }) => {
    localStorage.setItem('token', token); localStorage.setItem('refreshToken', refreshToken);
    localStorage.setItem('permissions', '["*"]'); localStorage.setItem('user', JSON.stringify({ id: 1, username: 'admin' }));
  }, session);
  const page = await context.newPage();
  const overviewReads: Array<{ status: number; at: number }> = [];
  const mutations: string[] = [];
  page.on('response', response => { if (response.url().includes('/api/resources/overview')) overviewReads.push({ status: response.status(), at: Date.now() }); });
  page.on('request', request => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(new URL(request.url()).pathname);
  });
  await page.goto(`http://127.0.0.1:${ports.frontend}/dashboard?scope=server&q=MAX209`);
  await page.waitForFunction(() => !!(document.querySelector('dashboard-page') as any)?.resourceOverview?.items?.length);
  await page.evaluate(() => { (document.querySelector('dashboard-page') as any).startDate = '2026-10-01'; });
  await page.screenshot({ path: `${output}/before.png`, fullPage: true });
  record('ready', { apiPid: api.pid, frontendPid: frontend.pid, overviewStatus: (await request('/api/resources/overview', session.token)).status,
    processIdentity: spawnSync('ps', ['-p', `${api.pid},${frontend.pid}`, '-o', 'pid,ppid,command'], { encoding: 'utf8' }).stdout.trim() });

  for (const [index, durationMs] of [6_000, 36_000, 6_000].entries()) {
    await page.waitForFunction(() => (document.querySelector('slide-app') as any)?.connected === true, undefined, { timeout: 60_000 });
    const readCount = overviewReads.length;
    docker('stop', '-t', '2', container);
    await until(async () => (await request('/api/health/ready')).status === 503, 20_000);
    assert.equal((await request('/api/health')).status, 200);
    assert.equal((await request('/api/resources/overview', session.token)).status, 503);
    assert.equal((await request('/api/servers', session.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 503);
    // Trigger an actual read in the still-open browser; do not reload/navigation.
    await page.evaluate(async () => { await (document.querySelector('dashboard-page') as any).loadDashboardData(); });
    assert.equal(await page.evaluate(async () => (await (window as any).__apiClient.fetchResponseWithAuth('/api/servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status), 503);
    record('degraded', { index, durationMs, live: 200, ready: 503, overview: 503, blockedWrite: 503, apiPid: api.pid, frontendPid: frontend.pid });
    await wait(durationMs);
    docker('start', container);
    await until(async () => { const c = await pool!.getConnection(); try { await c.ping(); return true; } finally { c.release(); } });
    const availableAt = Date.now();
    await until(async () => (await request('/api/health/ready')).status === 200);
    await until(async () => overviewReads.slice(readCount).some(read => read.status === 200 && read.at >= availableAt));
    assert.equal((await request('/api/resources/overview', session.token)).status, 200);
    assert.equal(api.exitCode, null); assert.equal(frontend.exitCode, null);
    assert.equal(await page.evaluate(() => localStorage.getItem('token')), session.token);
    assert.equal(await page.evaluate(() => (document.querySelector('dashboard-page') as any).startDate), '2026-10-01');
    assert.match(page.url(), /q=MAX209/);
    await page.waitForFunction(() => (document.querySelector('slide-app') as any)?.connected === true, undefined, { timeout: 60_000 });
    assert.ok(Date.now() - availableAt < 60_000, 'ready, page reads and authenticated WS within 60s');
    await page.screenshot({ path: `${output}/recovered-${index}.png`, fullPage: true });
    record('recovered', { index, durationMs, recoveredWithinMs: Date.now() - availableAt, apiPid: api.pid, frontendPid: frontend.pid, overviewReads: overviewReads.length });
  }

  // Controlled renewal row lock: no database restart, identify the SQL stage.
  await page.waitForFunction(() => (document.querySelector('slide-app') as any)?.connected === true, undefined, { timeout: 60_000 });
  const lock = await pool.getConnection();
  try {
    await lock.beginTransaction();
    await lock.query("SELECT * FROM worker_leases WHERE lease_name = 'slide-singleton-workers' FOR UPDATE");
    const readCount = overviewReads.length;
    await until(async () => (await request('/api/health/ready')).status === 503, 20_000);
    assert.equal((await request('/api/health')).status, 200);
    record('lease-lock-timeout', { apiPid: api.pid, live: 200, ready: 503 });
    await lock.rollback();
    const releasedAt = Date.now();
    await until(async () => (await request('/api/health/ready')).status === 200);
    await until(async () => overviewReads.slice(readCount).some(read => read.status === 200 && read.at >= releasedAt));
    await page.waitForFunction(() => (document.querySelector('slide-app') as any)?.connected === true, undefined, { timeout: 60_000 });
    record('lease-lock-recovered', { recoveredWithinMs: Date.now() - releasedAt });
  } finally { await lock.rollback().catch(() => {}); lock.release(); }
  const [leaseRows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM worker_leases');
  assert.equal(Number(leaseRows[0].count), 1);
  const [serverRows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM servers');
  assert.equal(Number(serverRows[0].count), 1);
  const apiLog = readFileSync(`${output}/api.log`, 'utf8');
  assert.ok(apiLog.includes('"state":"recovering"'));
  assert.ok(apiLog.includes('PLATFORM_QUERY_TIMEOUT'));
  assert.ok(!apiLog.includes('Pool is closed'));
  // Additive device identity bootstrap is expected; no failed business write,
  // action, model, notification or refresh rotation may be replayed.
  assert.ok(mutations.every(path => ['/api/device/register', '/api/device/challenge', '/api/servers'].includes(path)), mutations.join(','));
  assert.equal(mutations.filter(path => path === '/api/servers').length, 3, 'failed browser writes are never replayed');
  record('passed', { leaseOwners: 1, assets: 1, mutationPaths: mutations, overviewReads, apiPid: api.pid, frontendPid: frontend.pid });
} catch (error) {
  record('failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of [...children].reverse()) await stop(child);
  await pool?.end();
  // Only the exact container created by this foreground drill is removed.
  const result = spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
  record('cleanup', { containerRemoved: result.status === 0, childPids: children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode })) });
}
