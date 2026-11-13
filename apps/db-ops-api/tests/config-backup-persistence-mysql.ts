// Explicit qualification only; requires injected DB_HOST/DB_PORT/DB_USER/DB_PASSWORD.
// From repository root: pnpm --filter slide-api exec tsx tests/config-backup-persistence-mysql.ts
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import mysql from 'mysql2/promise';
import ssh2, { type Connection, type Server as SshServer } from 'ssh2';
const { Server, utils } = ssh2;
import { ConfigBackupService, createSqlStore, CONFIG_BACKUP_COMMANDS } from '../src/network-devices/config-backup-service.js';
import { ConfigBackupScheduler, MysqlBackupScheduleStore } from '../src/network-devices/config-backup-scheduler.js';
import { AuditLogManager, DatabaseAuditLogStore } from '../src/audit/audit-log.js';
import { splitSqlStatements } from '../src/migrations/runner.js';

for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD']) {
  assert.notEqual(process.env[key], undefined, `${key} must be explicitly injected`);
}
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
const schema = `slide_max600_${process.pid}_${randomBytes(4).toString('hex')}`;
const config = { host: process.env.DB_HOST!, port: Number(process.env.DB_PORT), user: process.env.DB_USER!, password: process.env.DB_PASSWORD!, connectTimeout: 5000 };
const admin = await mysql.createConnection(config);
let pool: mysql.Pool | undefined;
let created = false;
let ssh: SshServer | undefined;
const clients = new Set<Connection>();
const commands: string[] = [];
let content = 'sysname max600\nsnmp-agent community read cipher synthetic-secret';
let captures = 0;
try {
  await admin.query(`CREATE DATABASE \`${schema}\``); created = true;
  pool = mysql.createPool({ ...config, database: schema, connectionLimit: 2 });
  await pool.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY) ENGINE=InnoDB');
  await pool.query('CREATE TABLE network_devices (id BIGINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB');
  await pool.query('CREATE TABLE network_device_credentials (device_id BIGINT UNSIGNED NOT NULL, protocol VARCHAR(16) NOT NULL) ENGINE=InnoDB');
  const foundation = await readFile(new URL('../sql/migrations/070_network_device_resource_foundation.sql', import.meta.url), 'utf8');
  const backupTable = splitSqlStatements(foundation).find(sql => sql.startsWith('CREATE TABLE IF NOT EXISTS `network_device_config_backups`'));
  assert.ok(backupTable);
  await pool.query(backupTable);
  for (const file of ['065_persistent_audit_log.sql', '091_network_config_backup_schedule.sql']) {
    const sql = await readFile(new URL(`../sql/migrations/${file}`, import.meta.url), 'utf8');
    for (const statement of splitSqlStatements(sql)) await pool.query(statement);
  }
  await pool.query('INSERT INTO network_devices VALUES (7)');
  await pool.query("INSERT INTO network_device_credentials VALUES (7, 'ssh')");

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const parsed = utils.parseKey(privateKey);
  assert.ok(!(parsed instanceof Error));
  const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  ssh = new Server({ hostKeys: [privateKey] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === 'synthetic-password' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => {
      accept().on('exec', (acceptExec, reject, info) => {
        if (!(CONFIG_BACKUP_COMMANDS as readonly string[]).includes(info.command)) { reject(); return; }
        commands.push(info.command);
        const stream = acceptExec();
        if (info.command === CONFIG_BACKUP_COMMANDS[1]) { captures++; stream.write(content); }
        stream.exit(0); stream.end();
      });
    }));
  });
  ssh.listen(0, '127.0.0.1'); await once(ssh, 'listening');
  const address = ssh.address();
  assert.ok(address && typeof address !== 'string');
  const store = createSqlStore(() => pool!);
  // Real SSH with a pinned host key; only destination authorization/device lookup use fixture input.
  const deviceService = {
    getDeviceById: async () => ({ id: 7, host: '127.0.0.1', sshPort: address.port, vendor: 'huawei' }),
    getCredentials: async () => ({ protocol: 'ssh' as const, username: 'fixture', credentialType: 'password' as const, credentialValue: 'synthetic-password', hostKeyFingerprint: fingerprint }),
  };
  const auditManager = new AuditLogManager({ write: async () => {} } as any, new DatabaseAuditLogStore(pool));
  const makeService = () => new ConfigBackupService({ deviceService, store,
    authorizeTarget: async ({ host, port }) => ({ hostname: host, address: host, port }),
    audit: event => auditManager.logConfigBackupAccess({ ...event, userId: undefined }),
  });
  const service = makeService();
  const first = await service.capture(7);
  assert.equal(first.success, true); assert.equal(first.duplicate, false); assert.equal(first.backup.versionNo, 1);
  const same = await service.capture(7);
  assert.equal(same.duplicate, true); assert.equal(same.backup.id, first.backup.id);
  content += '\ninterface GE0/0/1';
  const changed = await service.capture(7);
  assert.equal(changed.duplicate, false); assert.equal(changed.backup.versionNo, 2);
  content += '\n description concurrent';
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => makeService().capture(7)));
  assert.ok(concurrent.every(result => result.success));
  assert.equal(concurrent.filter(result => !result.duplicate).length, 1);
  assert.equal(new Set(concurrent.map(result => result.backup.id)).size, 1);
  assert.equal(concurrent[0].backup.versionNo, 3);
  const [encrypted] = await pool.query<mysql.RowDataPacket[]>('SELECT content_encrypted FROM network_device_config_backups');
  assert.ok(encrypted.every(row => row.content_encrypted.startsWith('v2:') && !row.content_encrypted.includes('synthetic-secret')));
  console.log('PASS #339: first/repeated/changed capture + four concurrent same-hash SSH captures, encrypted SQL storage');

  const base = new MysqlBackupScheduleStore(() => pool!);
  let finalizationFailures = 1;
  let lostCheckpointResponses = 0;
  let lostFinalizationResponses = 0;
  let checkpointWrites = 0;
  let finalizationWrites = 0;
  const faulty = new MysqlBackupScheduleStore(() => ({
    getConnection: async () => {
      const connection = await pool!.getConnection();
      return {
        beginTransaction: () => connection.beginTransaction(),
        rollback: () => connection.rollback(),
        release: () => connection.release(),
        execute: async (sql: string, values?: unknown[]) => {
          const result = await connection.execute(sql, values);
          if (sql.includes("SET status = 'running', error_code")) checkpointWrites++;
          return result;
        },
        commit: async () => {
          await connection.commit();
          if (lostCheckpointResponses > 0) { lostCheckpointResponses--; throw new Error('injected lost checkpoint response'); }
        },
      };
    },
    execute: async (sql: string, values?: unknown[]) => {
      if (sql.includes("SET status = IF(error_code") && values?.length === 2 && finalizationFailures > 0) {
        finalizationFailures--; throw new Error('injected final status write failure');
      }
      const result = await pool!.execute(sql, values);
      if (sql.includes('SET status = IF(error_code') && values?.length === 2) {
        finalizationWrites++;
        if (lostFinalizationResponses > 0) { lostFinalizationResponses--; throw new Error('injected lost finalization response'); }
      }
      return result;
    },
  } as any));
  const run = (store = base) => new ConfigBackupScheduler(store, id => service.collect(id), () => new Date('2026-11-12T16:00:00Z'));
  let before = captures;
  await run(faulty).tick();
  assert.equal(captures, before + 1);
  assert.deepEqual((await base.get(7)).lastRun, { date: '2026-11-13', status: 'success', errorCode: null });
  await run().tick(); assert.equal(captures, before + 1);
  console.log('PASS #536: transient final status failure retries persistence only, same-day exclusion retained');
  for (const stage of ['checkpoint', 'finalization']) {
    await pool.query('DELETE FROM network_config_backup_runs');
    if (stage === 'checkpoint') lostCheckpointResponses = 1;
    else lostFinalizationResponses = 1;
    const priorCheckpointWrites = checkpointWrites;
    const priorFinalizationWrites = finalizationWrites;
    before = captures;
    await run(faulty).tick();
    assert.equal(captures, before + 1);
    assert.equal((await base.get(7)).lastRun?.status, 'success');
    assert.equal(checkpointWrites, priorCheckpointWrites + 1);
    assert.equal(finalizationWrites, priorFinalizationWrites + 1);
  }
  console.log('PASS #536: committed checkpoint/finalization with lost response is read back, never blindly resent');

  await pool.query('DELETE FROM network_config_backup_runs');
  finalizationFailures = 3;
  before = captures;
  await run(faulty).tick();
  const [pending] = await pool.query<mysql.RowDataPacket[]>('SELECT status, error_code, finished_at FROM network_config_backup_runs');
  assert.equal(pending[0].status, 'running'); assert.ok(pending[0].finished_at); assert.equal(pending[0].error_code, null);
  // Discard the old scheduler's memory as if the process terminated. Even overdue results recover.
  await pool.query('UPDATE network_config_backup_runs SET started_at = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 11 MINUTE)');
  await run().tick();
  assert.equal((await base.get(7)).lastRun?.status, 'success'); assert.equal(captures, before + 1);
  console.log('PASS #536: new scheduler recovers durable success after exhausted retries without SSH replay');
  await pool.query('DELETE FROM network_config_backup_runs');
  assert.equal(await base.claim({ deviceId: 7, enabled: true, dailyTime: '00:00' }, '2026-11-13'), true);
  await pool.query('UPDATE network_config_backup_runs SET started_at = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 11 MINUTE)');
  await base.expire();
  assert.equal((await base.get(7)).lastRun?.errorCode, 'CONFIG_BACKUP_INTERRUPTED');
  // Another worker can expire a row before a known result's checkpoint becomes writable.
  await base.finish(7, '2026-11-13', null);
  assert.equal((await base.get(7)).lastRun?.status, 'success');
  await base.finish(7, '2026-11-13', 'CONFIG_BACKUP_FAILED');
  assert.equal((await base.get(7)).lastRun?.status, 'success');
  console.log('PASS #536: late known result corrects inferred interruption; finalized results remain immutable');

  await pool.query('DELETE FROM network_config_backup_runs');
  await pool.query("CREATE TRIGGER max600_audit_fail BEFORE INSERT ON audit_log_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected audit outage'");
  content += '\n description audit-outage';
  before = captures;
  const failed = await service.capture(7);
  assert.equal(failed.error, 'CONFIG_BACKUP_SAVED_AUDIT_FAILED'); assert.equal(failed.success, false);
  assert.equal(failed.backupSaved, true); assert.equal(failed.retryable, false);
  assert.ok((await service.list(7)).some(row => row.id === failed.backup.id));
  assert.equal((await service.get(7, failed.backup.id))?.preview?.includes('synthetic-secret'), false);
  finalizationFailures = 3;
  await run(faulty).tick();
  await pool.query('DROP TRIGGER max600_audit_fail');
  await run().tick();
  assert.deepEqual((await base.get(7)).lastRun, { date: '2026-11-13', status: 'failed', errorCode: 'CONFIG_BACKUP_SAVED_AUDIT_FAILED' });
  assert.equal(captures, before + 2); // Explicit capture + scheduled run, no recovery/retry capture.
  await auditManager.logConfigBackupAccess({ action: 'read_raw', deviceId: 7, backupId: failed.backup.id });
  const [audits] = await pool.query<mysql.RowDataPacket[]>('SELECT event_type, details_json FROM audit_log_entries');
  assert.ok(audits.length >= 8);
  assert.ok(!JSON.stringify(audits).includes('synthetic-secret'));
  assert.ok(commands.every(command => (CONFIG_BACKUP_COMMANDS as readonly string[]).includes(command)));
  console.log('PASS #538: actual audit SQL rejection, saved backup queryable, failure survives scheduler restart, audit recovers, no automatic SSH replay');
  console.log(`PASS: audit rows=${audits.length}; SSH captures=${captures}; pool limit=2; schema=${schema}`);
} finally {
  // Stop protocol clients before closing the endpoint or database.
  const closed = [...clients].map(client => { const promise = once(client, 'close'); client.end(); return promise; });
  await Promise.all(closed);
  if (ssh) await new Promise<void>(resolve => ssh!.close(() => resolve()));
  await pool?.end();
  if (created) await admin.query(`DROP DATABASE \`${schema}\``);
  await admin.end();
  console.log('CLEANUP: SSH endpoint closed; disposable schema removed');
}
