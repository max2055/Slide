/** Opt-in #372/#566 acceptance. Inject DB_HOST/PORT/USER/PASSWORD explicitly.
 * pnpm --filter slide-api exec tsx tests/tool-recovery.integration.ts
 * Creates and drops one random database. Kills only its own recorded Node children.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { AgentToolIdempotencyService, stableArgumentsHash } from '../src/security/agent-tool-idempotency-service.js';
import { loadMigrations, MigrationRunner } from '../src/migrations/runner.js';

for (const name of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD']) assert.notEqual(process.env[name], undefined, `${name} must be explicitly injected`);
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';
const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectTimeout: 5000 };
const database = `max458_${randomUUID().replaceAll('-', '')}`;
const admin = await mysql.createConnection(config);
const directory = await mkdtemp(join(tmpdir(), 'max458-migrations-'));
let created = false;
let primaryError: unknown;
let pool: mysql.Pool | undefined;
const children: ChildProcess[] = [];
const workerPath = fileURLToPath(new URL('./tool-recovery.worker.ts', import.meta.url));

function worker(mode: string, key = mode, locale = 'en_US.UTF-8') {
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath], { env: { ...process.env, DB_NAME: database, RECOVERY_MODE: mode, RECOVERY_KEY: key, LC_ALL: locale, LANG: locale }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  const messages: any[] = [];
  const waiters = new Set<() => void>();
  let errors = '';
  child.stderr?.on('data', data => { errors += String(data).slice(0, 2000); });
  child.on('message', message => { messages.push(message); for (const wake of waiters) wake(); });
  child.on('exit', () => { for (const wake of waiters) wake(); });
  child.on('error', error => { errors += error.message; for (const wake of waiters) wake(); });
  return { child, wait(event: string) {
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Worker ${mode} timed out at ${event}: ${errors}`)); }, 25_000);
      function check() {
        const index = messages.findIndex(message => message.event === event);
        if (index >= 0) { clearTimeout(timer); waiters.delete(check); resolve(messages.splice(index, 1)[0]); }
        else if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); waiters.delete(check); reject(new Error(`Worker ${mode} exited at ${event}: ${errors}`)); }
      }
      waiters.add(check); check();
    });
  } };
}
async function reap(child: ChildProcess, kill = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child exit timeout')), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (kill) {
    if (process.env.MULTICA_CLI_PATH) {
      const status = spawnSync(process.env.MULTICA_CLI_PATH, ['daemon', 'status', '--output', 'json'], { encoding: 'utf8' });
      assert.equal(status.status, 0);
      assert.notEqual(child.pid, JSON.parse(status.stdout).pid, 'never terminate daemon');
    }
    child.kill('SIGKILL');
  }
  await exited;
}
const argsFor = (key: string) => ({ concurrency: 1, databases: [0, 1].map(index => ({ db_type: 'mysql', name: `${key}_${index}`, host: '10.77.0.1', port: 3308, username: 'fixture', database_name: `${key}_${index}` })) });
try {
  await admin.query(`CREATE DATABASE ${mysql.escapeId(database)}`);
  created = true;
  pool = mysql.createPool({ ...config, database, connectionLimit: 4 });
  console.log(JSON.stringify({ database, endpoint: `${config.host}:${config.port}`, version: (await pool.query<any[]>('SELECT VERSION() version'))[0][0].version }));
  // Real full-schema empty install, then a populated old-schema forward upgrade.
  const migrations = await loadMigrations();
  const recovery = migrations.find(m => m.id === '156_agent_tool_recovery.sql')!;
  for (const migration of migrations.filter(m => m !== recovery)) await writeFile(join(directory, migration.id), migration.sql);
  const runner = new MigrationRunner(pool as any, directory);
  await runner.run();
  const english = worker('hash');
  const danish = worker('hash', 'hash', 'da_DK.UTF-8');
  const [en, da] = await Promise.all([english.wait('hash'), danish.wait('hash')]);
  await Promise.all([reap(english.child), reap(danish.child)]);
  assert.equal(en.stable, da.stable);
  assert.notEqual(en.legacy, da.legacy);
  for (const [key, digest] of [['legacy-en', en.legacy], ['legacy-da', da.legacy]]) {
    await pool.query(`INSERT INTO agent_tool_idempotency (actor_id, session_id, session_hash, tool_name, idempotency_key, arguments_hash, state, result_json)
      VALUES (7, 'legacy', ?, 'tool', ?, ?, 'completed', '{"success":true,"instanceId":777}')`, [stableArgumentsHash('legacy'), key, digest]);
  }
  await writeFile(join(directory, recovery.id), recovery.sql);
  await runner.run();
  await runner.run();
  const service = new AgentToolIdempotencyService(() => pool as any);
  for (const key of ['legacy-en', 'legacy-da']) {
    const replay = await service.claim(7, 'legacy', 'tool', key, { z: 'y', aa: 'x' });
    assert.equal(replay.kind, 'completed');
    if (replay.kind === 'completed') assert.deepEqual(replay.result, { success: true, instanceId: 777 });
    assert.equal((await service.claim(7, 'legacy', 'tool', key, { aa: 'x', z: 'changed' })).kind, 'conflict');
  }
  console.log(JSON.stringify({ emptyInstall: 'pass', populatedUpgrade: 'pass', repeatMigration: 'pass', crossLocale: 'pass', legacyReplay: 'pass', changedArguments: 'pass' }));
  // Use real batch -> add_database -> instance service -> MySQL writes.
  for (const [mode, expectedCount] of [['claim', 0], ['partial', 1], ['uncheckpointed', 1], ['before-finish', 2], ['live', 1]] as const) {
    const child = worker(mode);
    await child.wait('cutpoint');
    assert.equal((await service.claim(7, 'recovery-session', 'slide_add_database_batch', mode, argsFor(mode))).kind, 'in_progress');
    if (mode === 'live') {
      const [initial] = await pool.query<any[]>('SELECT lease_until FROM agent_tool_idempotency WHERE idempotency_key = ?', [mode]);
      await child.wait('heartbeat');
      const [later] = await pool.query<any[]>('SELECT lease_until FROM agent_tool_idempotency WHERE idempotency_key = ?', [mode]);
      assert.ok(later[0].lease_until > initial[0].lease_until);
      assert.equal((await service.claim(7, 'recovery-session', 'slide_add_database_batch', mode, argsFor(mode))).kind, 'in_progress');
    }
    await reap(child.child, true);
    // Advance only this task's persisted deadline; no shared clock changes or 60s sleep.
    await pool.query('UPDATE agent_tool_idempotency SET lease_until = NOW(3) - INTERVAL 1 SECOND WHERE idempotency_key = ?', [mode]);
    const recovered = await service.claim(7, 'recovery-session', 'slide_add_database_batch', mode, argsFor(mode));
    assert.equal(recovered.kind, 'unknown');
    const cp = recovered.kind === 'unknown' ? recovered.checkpoint as any : null;
    if (mode === 'partial' || mode === 'before-finish') assert.equal(cp.items['0'].result.status, 'pending_credentials');
    if (mode === 'uncheckpointed' || mode === 'live') assert.equal(cp.items['0'].state, 'started');
    if (mode === 'before-finish') assert.equal(cp.items['1'].result.status, 'pending_credentials');
    const retry = worker('normal', mode);
    const result = (await retry.wait('result')).result;
    await reap(retry.child);
    assert.equal(result.errorCode, 'IDEMPOTENCY_OUTCOME_UNKNOWN');
    assert.equal(result.details.retryable, false);
    const [effects] = await pool.query<any[]>('SELECT COUNT(*) n FROM database_instances WHERE name IN (?, ?)', [`${mode}_0`, `${mode}_1`]);
    assert.equal(effects[0].n, expectedCount);
    console.log(JSON.stringify({ mode, pid: child.child.pid, crash: 'SIGKILL', state: 'unknown', expectedCount, actualCount: effects[0].n, replayPrevented: true, checkpoint: cp }));
  }
  for (const mode of ['finish-failure', 'finish-lost-ack', 'checkpoint-lost-ack', 'normal']) {
    const child = worker(mode);
    const result = (await child.wait('result')).result;
    await reap(child.child);
    const expectedCount = mode === 'checkpoint-lost-ack' ? 1 : 2;
    assert.equal(result.data.succeeded, expectedCount);
    const [effects] = await pool.query<any[]>('SELECT COUNT(*) n FROM database_instances WHERE name IN (?, ?)', [`${mode}_0`, `${mode}_1`]);
    assert.equal(effects[0].n, expectedCount);
    if (mode !== 'normal') {
      assert.equal(result.errorCode, 'IDEMPOTENCY_RESULT_UNCONFIRMED');
      assert.equal(result.details.retryable, false);
    }
    if (mode === 'normal' || mode === 'finish-lost-ack') {
      const replay = await service.claim(7, 'recovery-session', 'slide_add_database_batch', mode, argsFor(mode));
      assert.equal(replay.kind, 'completed');
      if (replay.kind === 'completed') assert.equal((replay.result as any).data.succeeded, 2);
    }
    console.log(JSON.stringify({ mode, itemResultsPreserved: result.data.results.length, errorCode: result.errorCode ?? null, success: true }));
  }
  const [columns] = await pool.query<any[]>('SHOW FULL COLUMNS FROM agent_tool_idempotency');
  assert.equal(columns.find(c => c.Field === 'hash_version').Default, '1');
  assert.ok(columns.every(c => c.Comment));
  assert.ok(columns.find(c => c.Field === 'state').Type.includes('unknown'));
  console.log(JSON.stringify({ schemaInvariant: 'pass', columns: columns.map(c => ({ name: c.Field, type: c.Type, default: c.Default, comment: c.Comment })) }));
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  const cleanupErrors: unknown[] = [];
  for (const child of children) try { await reap(child, true); } catch (error) { cleanupErrors.push(error); }
  try { await pool?.end(); } catch (error) { cleanupErrors.push(error); }
  try {
    if (created) {
      await admin.query(`DROP DATABASE ${mysql.escapeId(database)}`);
      const [rows] = await admin.query<any[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]);
      assert.equal(rows.length, 0);
    }
    console.log(JSON.stringify({ cleanup: 'pass', database }));
  } catch (error) { cleanupErrors.push(error); }
  try { await admin.end(); } catch (error) { cleanupErrors.push(error); }
  try { await rm(directory, { recursive: true }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors], 'acceptance cleanup failed; primary error retained');
}
