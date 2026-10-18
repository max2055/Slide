/** Explicit operator CLI, never imported by production startup. Run from
 * apps/db-ops-api with pnpm exec tsx ../../scripts/qualification/v23-source-package.ts. */
import { readFile, open, mkdir, type FileHandle } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { bytesHash, sourcePackageSchema, sourceDefinitions, sourceFailure } from './config.js';

const outputRoot = '/Users/max/Coding/40-Slide/outputs';
async function protectedBytes(path: string) {
  const { constants } = await import('node:fs');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) sourceFailure('PRIVATE_FILE_REQUIRED');
    const bytes = Buffer.alloc(65537), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) sourceFailure('INPUT_LIMIT');
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}
async function main() {
  if (process.argv[2] === '--definitions' && process.argv.length === 3) {
    const d = sourceDefinitions();
    console.info(JSON.stringify({ policyHash: d.policyHash, policyVersion: `${d.policy.policyVersion}:${d.policyHash}`, verifier: d.verifier }, null, 2)); return;
  }
  if (process.argv[2] !== '--config' || process.argv.length !== 4) sourceFailure('USAGE_CONFIG_REQUIRED');
  const configBytes = await protectedBytes(process.argv[3]);
  const config = sourcePackageSchema.parse(JSON.parse(configBytes.toString()));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const lockBytes = await protectedBytes(process.env.V23_SOURCE_TARGET_LOCK_FILE ?? '');
  const lock = JSON.parse(lockBytes.toString());
  if (lock.issue !== 'MAX-203' || lock.operationId !== config.operationId || lock.configHash !== bytesHash(configBytes)
    || lock.head !== head || lock.target !== '192.168.49.130:22/mysql:3308'
    || !Number.isFinite(Date.parse(lock.expiresAt)) || Date.parse(lock.expiresAt) <= Date.now()
    || Date.parse(lock.expiresAt) < Date.parse(config.deadline)) sourceFailure('PARENT_TARGET_LOCK_REQUIRED');
  if (process.env.DB_HOST !== '127.0.0.1' || !/^\d+$/.test(process.env.DB_PORT ?? '')
    || Number(process.env.DB_PORT) < 1024 || [3306, 3307, 3308].includes(Number(process.env.DB_PORT))
    || process.env.DB_NAME !== config.database) sourceFailure('LOCAL_SCHEMA_REQUIRED');
  if (process.env.OPERATIONS_ACTION_DISPATCH_ENABLED !== 'false' || process.env.OPERATIONS_STOP_NEW_DISPATCH !== 'true'
    || process.env.INVESTIGATION_OPS_AUTO_ENABLED !== 'false' || process.env.METRICS_COLLECTION_ENABLED !== 'false')
    sourceFailure('DISPATCH_MUST_BE_DISABLED');
  const { sourceAuditPublicKeyPath } = await import('./audit.js');
  // Fixed parent-provisioned trust anchor, no operator-supplied key override.
  // Load before initializing DB so malformed authorization cannot leak a pool.
  const auditInput = process.env.V23_SOURCE_PARENT_AUDIT_FILE ? {
    envelope: await protectedBytes(process.env.V23_SOURCE_PARENT_AUDIT_FILE),
    publicKey: await protectedBytes(sourceAuditPublicKeyPath),
    binding: { head, configHash: bytesHash(configBytes), lockHash: bytesHash(lockBytes), databasePort: Number(process.env.DB_PORT) },
  } : undefined;
  const { dbConnection } = await import('../../db-connection.js');
  const { SourceControl } = await import('./control.js');
  const runtime = await import('./runtime.js');
  if (!await dbConnection.initialize()) sourceFailure('DATABASE_UNAVAILABLE');
  const pool = dbConnection.getPool()!;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('V23_SOURCE_CANCELLED'));
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  const control = new SourceControl(pool, config, controller.signal, auditInput);
  let success = false, api: ChildProcess | undefined;
  const output = join(outputRoot, '2026-10-18-v23-source', config.operationId);
  let audit: FileHandle;
  try {
    await mkdir(output, { recursive: true, mode: 0o700 });
    audit = await open(join(output, 'result.jsonl'), 'wx', 0o600);
  } catch (error) {
    await dbConnection.close(); throw error;
  }
  const record = async (value: unknown) => { await audit.write(JSON.stringify(value) + '\n'); await audit.sync(); };
  try {
    await control.open();
    await runtime.assertSourceInventory(pool, control);
    await record({ operationId: config.operationId, head, phase: config.phase, configHash: bytesHash(configBytes), at: new Date().toISOString() });
    await runtime.sourceHostClock();
    const { databaseService } = await import('../../database-service.js');
    const { instanceDatabaseService } = await import('../../instance-database-service.js');
    if (['collect', 'investigate'].includes(config.phase)) {
      const instance = await instanceDatabaseService.getInstanceById(config.instanceId);
      const password = await instanceDatabaseService.getInstancePassword(config.instanceId);
      if (!instance || password === null || !await databaseService.addConnection(instance.id, instance.name, {
        host: instance.host, port: instance.port, user: instance.username, password,
        database: instance.database_name || 'mysql', db_type: 'mysql',
      })) sourceFailure('INSTANCE_CONNECTION');
    }
    let result: unknown;
    if (config.phase === 'collect') result = await runtime.collectSource(control);
    else if (config.phase === 'evaluate') result = await runtime.evaluateSource(control);
    else if (config.phase === 'investigate') result = await runtime.investigateSource(control);
    else {
      // External worker lease above makes this exact API child standby. All
      // production HTTP middleware and environment validation remain installed.
      // A pre-existing listener must never be mistaken for this child. The
      // child's own durable standby log is also required before HTTP readiness.
      const portProbe = createServer();
      await new Promise<void>((done, reject) => {
        portProbe.once('error', reject);
        portProbe.listen(Number(new URL(config.api).port), '127.0.0.1', () => portProbe.close(error => error ? reject(error) : done()));
      });
      const log = await open(join(output, 'api.log'), 'wx', 0o600);
      api = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: resolve('.'),
        env: { ...process.env, PORT: new URL(config.api).port }, stdio: ['ignore', log.fd, log.fd] });
      let childError = false;
      api.once('error', () => { childError = true; });
      await record({ api: { pid: api.pid, port: new URL(config.api).port, cwd: resolve('.'), command: 'node --import tsx server.ts', head, log: 'api.log' } });
      const readyUntil = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < readyUntil && api.exitCode === null && !childError && !ready) {
        await control.assertActive();
        const standby = (await readFile(join(output, 'api.log'), 'utf8')).includes('WORKER_LEASE_UNAVAILABLE: API-only standby');
        // Worker readiness is deliberately false on an API-only standby.
        // Our live external lease + this child's standby receipt gate the API;
        // actual create/submit below supplies the business acceptance.
        try { ready = standby && (await fetch(config.api + '/api/health', {
          redirect: 'error', signal: AbortSignal.any([control.signal, AbortSignal.timeout(1000)]) })).ok; } catch { /* bounded own child readiness */ }
        if (!ready) await new Promise(done => setTimeout(done, 100));
      }
      await log.close();
      if (!ready) sourceFailure('API_NOT_READY');
      const token = (await protectedBytes(process.env.V23_SOURCE_JWT_FILE ?? '')).toString().trim();
      result = config.phase === 'continue' ? await runtime.continueSource(control, token) : await runtime.proposeSource(control, token, record);
    }
    await control.assertActive(); await record({ result, at: new Date().toISOString() });
    success = true;
  } catch (error) {
    await record({ status: 'requires_audit_no_replay', code: error instanceof Error && /^V23_SOURCE_[A-Z_]+$/.test(error.message)
      ? error.message : 'V23_SOURCE_FAILED_CLOSED', at: new Date().toISOString() });
    throw error;
  } finally {
    if (api?.pid && api.exitCode === null && api.signalCode === null) {
      const exit = once(api, 'exit'); api.kill('SIGTERM');
      const timer = setTimeout(() => api?.kill('SIGKILL'), 10_000);
      await exit; clearTimeout(timer);
    }
    try { await control.close(success); }
    finally {
      const { databaseService } = await import('../../database-service.js');
      const { default: ssh } = await import('../../ssh-session-pool.js');
      await databaseService.removeConnection(config.instanceId); ssh.closeAll();
      await audit.close(); await dbConnection.close();
      process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
    }
  }
  console.info(JSON.stringify({ code: 'V23_SOURCE_PHASE_COMPLETED', operationId: config.operationId, phase: config.phase }));
}
main().catch(() => { console.error('V23_SOURCE_FAILED_CLOSED; inspect durable operation audit; do not replay'); process.exitCode = 1; });
