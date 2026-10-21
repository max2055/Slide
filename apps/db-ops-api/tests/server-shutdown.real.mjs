/** Opt-in, disposable MySQL + local SSH transport + complete API process.
 * Exercises final shutdown after a diagnostic-style idle SSH session without
 * external targets, commands, notifications, model calls or a database outage. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;

if (process.env.RUN_SERVER_SHUTDOWN_TEST !== 'true') throw Error('Set RUN_SERVER_SHUTDOWN_TEST=true');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = process.env.RELEASE_OUTPUT_DIR;
if (!out?.startsWith('/Users/max/Coding/40-Slide/outputs/')) throw Error('Set RELEASE_OUTPUT_DIR under project outputs');
mkdirSync(out, { recursive: true });
const host = Object.values(networkInterfaces()).flat().find(i => i?.family === 'IPv4' && !i.internal
  && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address))?.address;
assert.ok(host, 'A private local interface is required; do not bypass the loopback target policy');
const ports = { db: 33210, api: 31210, ws: 28210, ssh: 32210 };
const container = `slide-max209-shutdown-${process.pid}`, password = randomBytes(32).toString('hex');
const env = { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: String(ports.db), DB_USER: 'root', DB_PASSWORD: password,
  DB_NAME: 'max209_shutdown', JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  PORT: String(ports.api), AGENT_WS_PORT: String(ports.ws), NODE_ENV: 'development', PROMPT_HOT_RELOAD: 'false',
  METRICS_COLLECTION_ENABLED: 'false', INVESTIGATION_SYSTEM_EVENTS_ENABLED: 'false', INVESTIGATION_SYSTEM_AUTO_ENABLED: 'false',
  ANALYSIS_DISPATCH_ENABLED: 'false', SLIDE_MEMORY_PIPELINE_ENABLED: 'false', AGENT_WORKSPACE: `${out}/private-agent-workspace`,
  SHUTDOWN_TEST_ROOT: root, SHUTDOWN_SSH_HOST: host, SHUTDOWN_SSH_PORT: String(ports.ssh), SHUTDOWN_SSH_PASSWORD: password };
const receipt = { root, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), ports,
  productModelCalls: 0, sshCommands: 0, events: [] };
const record = (event, data = {}) => { receipt.events.push({ event, at: new Date().toISOString(), ...data });
  writeFileSync(`${out}/receipt.json`, JSON.stringify(receipt, null, 2)); console.info(event, JSON.stringify(data)); };
const peers = new Set(); let api, init, ssh, pool, created = false;
function docker(args) { return execFileSync('docker', args, { encoding: 'utf8', timeout: 60000,
  env: { ...process.env, MYSQL_ROOT_PASSWORD: password } }); }
async function until(fn) { const end = Date.now() + 90000; while (Date.now() < end) {
  if (await fn().catch(() => false)) return; await new Promise(r => setTimeout(r, 300)); } throw Error('READINESS_TIMEOUT'); }
function start(args, name) { const c = spawn(process.execPath, args, { cwd: `${root}/apps/db-ops-api`, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(`${out}/${name}.log`); c.stdout.pipe(log); c.stderr.pipe(log); return c; }
async function exited(c, ms) { if (c.exitCode !== null || c.signalCode !== null) return true; let timer;
  return Promise.race([new Promise(r => c.once('exit', () => { clearTimeout(timer); r(true); })),
    new Promise(r => { timer = setTimeout(() => r(false), ms); })]); }
try {
  try { const listeners = execFileSync('lsof', ['-nP', '-iTCP:33210', '-iTCP:31210', '-iTCP:28210', '-iTCP:32210', '-sTCP:LISTEN'], { encoding: 'utf8' });
    assert.equal(listeners.trim(), '', 'isolated test ports must be free'); } catch (e) { if (e.status !== 1) throw e; }
  ssh = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, c => {
    peers.add(c); c.on('close', () => peers.delete(c));
    c.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'shutdown-test' && ctx.password === password ? ctx.accept() : ctx.reject());
    c.on('session', accept => { receipt.sshCommands++; accept().close(); });
  });
  await new Promise((resolve, reject) => { ssh.once('error', reject); ssh.listen(ports.ssh, host, resolve); });
  docker(['run', '-d', '--name', container, '--label', 'slide.task=MAX-209-shutdown', '--memory', '768m', '-e', 'MYSQL_ROOT_PASSWORD',
    '-e', 'MYSQL_ROOT_HOST=%', '-p', `127.0.0.1:${ports.db}:3306`, 'mysql:latest', '--innodb-buffer-pool-size=64M', '--performance-schema=OFF']); created = true;
  await until(async () => { const c = await mysql.createConnection({ host: '127.0.0.1', port: ports.db, user: 'root', password, connectTimeout: 1000 }); await c.end(); return true; });
  init = start(['--import', 'tsx', 'init-db.ts'], 'init'); assert.equal(await exited(init, 90000), true); assert.equal(init.exitCode, 0);
  pool = await mysql.createConnection({ host: '127.0.0.1', port: ports.db, user: 'root', password, database: env.DB_NAME, timezone: 'Z' });
  for (const table of ['llm_providers', 'notification_channels', 'cron_jobs']) await pool.query('UPDATE ?? SET enabled=0', [table]);
  api = start(['--import', 'tsx', '--import', fileURLToPath(new URL('./fixtures/idle-ssh-client.mjs', import.meta.url)), 'server.ts'], 'api');
  await until(async () => api.exitCode === null && (await fetch(`http://127.0.0.1:${ports.api}/api/health/ready`, { signal: AbortSignal.timeout(4000) })).status === 200);
  record('ready', { pid: api.pid, cwd: `${root}/apps/db-ops-api`, command: execFileSync('ps', ['-p', String(api.pid), '-o', 'pid,ppid,command'], { encoding: 'utf8' }).trim(),
    listeners: execFileSync('lsof', ['-nP', '-a', '-p', String(api.pid), '-iTCP'], { encoding: 'utf8' }).trim(),
    leases: (await pool.query('SELECT lease_name,owner_id,fencing_token FROM worker_leases'))[0] });
  const started = Date.now(); api.kill('SIGTERM'); const stopped = await exited(api, 13000);
  record('shutdown', { stopped, elapsedMs: Date.now() - started, exitCode: api.exitCode, signal: api.signalCode });
  assert.equal(stopped, true, 'API must exit naturally after SIGTERM with a released SSH session');
  assert.equal(api.exitCode, 0); assert.equal(api.signalCode, null); assert.equal(receipt.sshCommands, 0);
  record('passed');
} finally {
  for (const c of [api, init]) if (c && c.exitCode === null && c.signalCode === null) {
    c.kill('SIGTERM'); if (!await exited(c, 1000)) { c.kill('SIGKILL'); await exited(c, 3000); record('forced-cleanup', { pid: c.pid }); }
  }
  for (const peer of peers) peer.end(); if (ssh) await new Promise(r => ssh.close(r));
  await pool?.end(); if (created) docker(['rm', '-fv', container]); record('cleanup', { containerRemoved: created, sshCommands: receipt.sshCommands });
}
