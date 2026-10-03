/** Foreground qualification: disposable MySQL, real API processes, fake credentials only. */
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import { WorkerLease } from '../../apps/db-ops-api/src/lifecycle/worker-lease.js';
import { CronRunStore } from '../../apps/db-ops-api/src/cron/cron-run-store.js';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const api = join(root, 'apps/db-ops-api');
const directory = await mkdtemp(join(tmpdir(), 'slide-w07-'));
const container = `slide-w07-${process.pid}`;
const composeProject = `slide-w07-flags-${process.pid}`;
const children: Array<{ child: ChildProcess; output: () => string; exit: Promise<unknown> }> = [];
const events: string[] = [];
const fakeProvider = createHttpServer((_request, response) => { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'QUALIFICATION_MODEL_DISABLED' })); });
fakeProvider.listen(0, '127.0.0.1'); await once(fakeProvider, 'listening');
const fakeProviderPort = (fakeProvider.address() as { port: number }).port;
let pool: ReturnType<typeof mysql.createPool> | undefined;
let lock: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => Promise<boolean>, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check().catch(() => false)) return; await delay(250); }
  throw new Error(`Qualification timeout: ${label}\n${children.map(p => p.output().slice(-6000)).join("\n")}`);
}
async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function probe(port: number, path = '/api/health/ready') {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4_000) });
  return { code: response.status, body: await response.json() };
}
async function stop(process: typeof children[number]) {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill('SIGTERM');
  await Promise.race([process.exit, delay(12_000).then(() => { if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGKILL'); })]);
  await process.exit;
}
function start(env: NodeJS.ProcessEnv) {
  let output = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: api, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; });
  const run = { child, output: () => output, exit: once(child, 'exit') }; children.push(run); return run;
}

try {
  await exec('docker', ['run', '-d', '--rm', '--name', container, '-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', '-p', '127.0.0.1::3306', 'mysql:8.4']);
  const mapped = (await exec('docker', ['port', container, '3306/tcp'])).stdout.trim();
  const port = Number(mapped.split(':').at(-1));
  pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
  let stable = 0;
  await waitFor(async () => { try { await pool!.query('SELECT 1'); return ++stable >= 4; } catch { stable = 0; return false; } }, 'disposable MySQL', 60_000);
  const env = { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'db_ops_ai_qualification_w07',
    JWT_SECRET_KEY: 'qualification-jwt-key-at-least-32-bytes', ENCRYPTION_KEY: 'qualification-e2e-key-32-bytes!!',
    AGENT_APPROVAL_HMAC_KEY: 'qualification-approval-key-at-least-32-bytes',
    AGENT_WORKSPACE: join(directory, 'workspace'), PROMPT_VERSIONS_DIR: join(directory, 'prompts'), PROMPT_HOT_RELOAD: 'false',
    ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', METRICS_V2_COLLECTION_ENABLED: 'true', SLIDE_MEMORY_PIPELINE_ENABLED: 'true',
    SLIDE_MEMORY_WORKSPACE_ID: 'qualification-private-workspace', SLIDE_MEMORY_RETRIEVAL_MAX_COUNT: '3', SLIDE_MEMORY_RETRIEVAL_MAX_TOKENS: '512' };
  await exec(process.execPath, ['--import', 'tsx', 'init-db.ts'], { cwd: api, env, maxBuffer: 16 * 1024 * 1024 });
  await exec(process.execPath, [join(root, 'scripts/qualification/bootstrap-admin.mjs')], { cwd: api,
    env: { ...env, QUALIFICATION_DB_NAME: 'db_ops_ai_qualification_w07', QUALIFICATION_ADMIN_PASSWORD: 'qualification-admin-password' } });
  await exec(process.execPath, ['--import', 'tsx', join(root, 'scripts/qualification/configure-cancellable-provider.ts')], { cwd: api, env });
  await pool.query('USE db_ops_ai_qualification_w07');
  // Pool connections must all use the test database (USE affects only one).
  await pool.end(); pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database: 'db_ops_ai_qualification_w07' });
  await pool.query("UPDATE llm_providers SET api_base_url = ? WHERE name = 'deepseek'", [`http://127.0.0.1:${fakeProviderPort}/v1`]);
  lock = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '', database: 'db_ops_ai_qualification_w07' });
  // Delay an actual API dependency, without a production-only delay switch.
  await lock.query('LOCK TABLES agent_security_policies WRITE');
  const leaderPort = await freePort(), standbyPort = await freePort();
  const leader = start({ ...env, PORT: String(leaderPort), AGENT_WS_PORT: String(await freePort()) });
  await waitFor(async () => (await probe(leaderPort, '/api/health')).code === 200, 'leader liveness');
  assert.deepEqual(await probe(leaderPort), { code: 503, body: { ready: false } });
  const [first] = await pool.query<any[]>('SELECT owner_id, expires_at FROM worker_leases');
  assert.equal(first.length, 1); const owner = first[0].owner_id;
  await delay(35_000);
  const [renewed] = await pool.query<any[]>('SELECT owner_id, expires_at > NOW() AS alive FROM worker_leases');
  assert.equal(renewed[0].owner_id, owner); assert.equal(renewed[0].alive, 1);
  const standby = start({ ...env, PORT: String(standbyPort), AGENT_WS_PORT: String(await freePort()) });
  await waitFor(async () => (await probe(standbyPort, '/api/health')).code === 200, 'standby liveness');
  await delay(2_000);
  await lock.query('UNLOCK TABLES');
  await waitFor(async () => (await probe(leaderPort)).code === 200, 'leader role readiness');
  await waitFor(async () => standby.output().includes('API-only standby'), 'standby API initialization');
  assert.deepEqual(await probe(standbyPort), { code: 503, body: { ready: false } });
  assert.equal((leader.output().match(/Agent Engine 已启动/g) ?? []).length, 1);
  assert.equal((standby.output().match(/Agent Engine 已启动/g) ?? []).length, 0);
  assert.equal(leader.output().includes('qualification-private-workspace'), false);
  events.push('slow API dependency >35s: lease renewed; two real API processes: one background engine');

  const login = await fetch(`http://127.0.0.1:${standbyPort}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'qualification-admin-password' }) });
  assert.equal(login.status, 200); const auth = await login.json() as any;
  const token = auth.token ?? auth.accessToken;
  const [jobs] = await pool.query<any[]>('SELECT id FROM cron_jobs LIMIT 1');
  const trigger = await fetch(`http://127.0.0.1:${standbyPort}/api/cron/jobs/${jobs[0].id}/run`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal(trigger.status, 503); assert.deepEqual(await trigger.json(), { error: 'WORKFLOW_RUNTIME_UNAVAILABLE' });
  await stop(leader);
  await delay(2_000);
  assert.deepEqual(await probe(standbyPort), { code: 503, body: { ready: false } });
  assert.equal((await probe(standbyPort, '/api/health')).code, 200);
  const [released] = await pool.query<any[]>('SELECT owner_id FROM worker_leases'); assert.equal(released.length, 0);
  events.push('leader SIGTERM: standby stays API-only, readiness 503, trigger 503, no automatic takeover');

  // Expired global leases may not be resurrected by the old owner.
  const lease = new WorkerLease(pool as any); assert.equal(await lease.acquire(), true);
  await pool.query('UPDATE worker_leases SET expires_at = NOW() - INTERVAL 1 SECOND');
  assert.equal(await lease.renew(), false); await lease.release();
  events.push('expired global owner renewal rejected');

  // Recovery must leave another active workflow owner and unowned legacy logs intact.
  const original = dbConnection.getPool; (dbConnection as any).getPool = () => pool;
  try {
    const store = new CronRunStore();
    const active = await store.enqueue(jobs[0].id, null, 'active-owner', {}, null);
    const expired = await store.enqueue(jobs[0].id, null, 'expired-owner', {}, null);
    await store.start(active.runId); await store.start(expired.runId);
    await pool.query("UPDATE workflow_jobs SET state='running', lease_owner='active-owner', lease_expires_at=NOW()+INTERVAL 30 SECOND WHERE id=?", [active.runId]);
    await pool.query("UPDATE workflow_jobs SET state='running', lease_owner='expired-owner', lease_expires_at=NOW()-INTERVAL 1 SECOND WHERE id=?", [expired.runId]);
    await store.recover(); await store.recover();
    assert.equal((await store.get(active.runId))!.status, 'running');
    assert.equal((await store.get(active.runId))!.runnerFinishedAt, null);
    assert.equal((await store.get(expired.runId))!.status, 'unknown');
    const [legacy] = await pool.query<any>("INSERT INTO cron_job_logs(job_id, status, started_at) VALUES (?, 'running', NOW())", [jobs[0].id]);
    await store.recover(); const [logs] = await pool.query<any[]>('SELECT status FROM cron_job_logs WHERE id=?', [legacy.insertId]);
    assert.equal(logs[0].status, 'running');
  } finally { (dbConnection as any).getPool = original; }
  events.push('real MySQL recovery: active owner preserved, expired owner unknown, legacy running log retained');

  const failed = start({ ...env, PORT: String(await freePort()), AGENT_WS_PORT: String(await freePort()), SLIDE_MEMORY_WORKSPACE_ID: '' });
  await failed.exit; assert.equal(failed.child.exitCode, 1); assert.ok(failed.output().includes('MEMORY_WORKSPACE_ID_REQUIRED'));
  const initFailure = start({ ...env, PORT: String(await freePort()), AGENT_WS_PORT: 'invalid' });
  await initFailure.exit; assert.equal(initFailure.child.exitCode, 1);
  const [afterFailure] = await pool.query<any[]>('SELECT owner_id FROM worker_leases'); assert.equal(afterFailure.length, 0);
  events.push('missing Memory workspace and partial engine initialization fail explicitly; lease released');

  const dbLossPort = await freePort();
  const dbLoss = start({ ...env, PORT: String(dbLossPort), AGENT_WS_PORT: String(await freePort()) });
  await waitFor(async () => (await probe(dbLossPort)).code === 200, 'database-loss candidate ready');
  await exec('docker', ['pause', container]);
  assert.deepEqual(await probe(dbLossPort), { code: 503, body: { ready: false } });
  await Promise.race([dbLoss.exit, delay(18_000).then(() => { throw new Error('blocked lease did not fail closed'); })]);
  assert.ok(dbLoss.output().includes('WORKER_LEASE_TIMEOUT'));
  await exec('docker', ['unpause', container]);
  events.push('database paused: bounded readiness 503, renewal timeout cancels workers and enforces process close deadline');

  // Render only fake configuration, then use Compose itself to launch a probe container.
  const configFile = join(directory, 'compose.env');
  const example = await readFile(join(root, 'deploy/.env.production.example'), 'utf8');
  await writeFile(configFile, example.replace('METRICS_V2_COLLECTION_ENABLED=false', 'METRICS_V2_COLLECTION_ENABLED=true')
    .replace('SLIDE_MEMORY_PIPELINE_ENABLED=false', 'SLIDE_MEMORY_PIPELINE_ENABLED=true')
    .replace('SLIDE_MEMORY_WORKSPACE_ID=', 'SLIDE_MEMORY_WORKSPACE_ID=qualification-private-workspace')
    .replace('SLIDE_MEMORY_RETRIEVAL_MAX_COUNT=5', 'SLIDE_MEMORY_RETRIEVAL_MAX_COUNT=3')
    .replace('SLIDE_MEMORY_RETRIEVAL_MAX_TOKENS=4096', 'SLIDE_MEMORY_RETRIEVAL_MAX_TOKENS=512'));
  const composeArgs = ['compose', '-p', composeProject, '--env-file', configFile, '--project-directory', directory, '-f', join(root, 'compose.production.yaml')];
  const rendered = JSON.parse((await exec('docker', [...composeArgs, 'config', '--format', 'json'], { maxBuffer: 8 * 1024 * 1024 })).stdout);
  const keys = ['METRICS_V2_COLLECTION_ENABLED', 'SLIDE_MEMORY_PIPELINE_ENABLED', 'SLIDE_MEMORY_WORKSPACE_ID', 'SLIDE_MEMORY_RETRIEVAL_MAX_COUNT', 'SLIDE_MEMORY_RETRIEVAL_MAX_TOKENS'];
  const expected = Object.fromEntries(keys.map(key => [key, rendered.services.api.environment[key]]));
  assert.deepEqual(Object.values(expected), ['true', 'true', 'qualification-private-workspace', '3', '512']);
  assert.ok(rendered.services.api.healthcheck.test.at(-1).includes('/api/health/ready'));
  const override = join(directory, 'probe.yaml');
  const command = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]]))))`;
  await writeFile(override, `services:\n  api:\n    image: node:22-alpine\n    build: !reset null\n    entrypoint: !override [node, -e]\n    command: !override ${JSON.stringify([command])}\n    volumes: !reset []\n    networks: !override [control]\n    depends_on: !reset {}\n    healthcheck: !reset null\n`);
  const output = await exec('docker', [...composeArgs, '-f', override, 'run', '--rm', '--no-deps', 'api'], { maxBuffer: 8 * 1024 * 1024 });
  assert.deepEqual(JSON.parse(output.stdout.trim()), expected);
  events.push('fake Compose render + actual Compose test container received all five enabled Memory/metrics settings');
  console.log(JSON.stringify({ result: 'passed', events, processes: children.map(p => p.child.pid), cwd: api,
    head: (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(), productionDataTouched: false }, null, 2));
} finally {
  await exec('docker', ['unpause', container]).catch(() => {});
  await lock?.query('UNLOCK TABLES').catch(() => {}); await lock?.end().catch(() => {});
  await Promise.all(children.map(stop)); await pool?.end().catch(() => {});
  await exec('docker', ['compose', '-p', composeProject, '--env-file', join(directory, 'compose.env'), '--project-directory', directory,
    '-f', join(root, 'compose.production.yaml'), 'down']).catch(() => {});
  await exec('docker', ['rm', '-f', container]).catch(() => {});
  await new Promise<void>(resolve => fakeProvider.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
