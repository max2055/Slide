// Integration qualification: uses DB_* credentials but creates its own disposable schema.
// Run: pnpm --filter slide-api exec tsx tests/config-backup-schedule-mysql.ts
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { splitSqlStatements } from '../src/migrations/runner.js';
import { MysqlBackupScheduleStore, ConfigBackupScheduler } from '../src/network-devices/config-backup-scheduler.js';

for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD']) {
  assert.notEqual(process.env[key], undefined, `${key} must be explicitly injected`);
}
const schema = `slide_backup_test_${process.pid}_${randomBytes(4).toString('hex')}`;
const config = { host: process.env.DB_HOST!, port: Number(process.env.DB_PORT), user: process.env.DB_USER!, password: process.env.DB_PASSWORD!, connectTimeout: 5000 };
const admin = await mysql.createConnection(config);
let pool: mysql.Pool | undefined;
let created = false;
try {
  await admin.query(`CREATE DATABASE \`${schema}\``); created = true;
  pool = mysql.createPool({ ...config, database: schema, connectionLimit: 4 });
  await pool.query('CREATE TABLE network_devices (id BIGINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB');
  await pool.query('CREATE TABLE network_device_credentials (device_id BIGINT UNSIGNED NOT NULL, protocol VARCHAR(16) NOT NULL) ENGINE=InnoDB');
  const migrate = async (file: string) => {
    const sql = await readFile(new URL(`../sql/migrations/${file}`, import.meta.url), 'utf8');
    for (const statement of splitSqlStatements(sql)) await pool!.query(statement);
  };
  await migrate('065_persistent_audit_log.sql');
  await migrate('091_network_config_backup_schedule.sql');
  await pool.query('INSERT INTO network_devices VALUES (7), (8), (9)');
  await pool.query("INSERT INTO network_device_credentials VALUES (7, 'ssh'), (8, 'ssh'), (9, 'snmpv3')");
  await pool.query(`INSERT INTO network_config_backup_runs (device_id, scheduled_date, status, error_code, finished_at)
    VALUES (9, '2026-09-14', 'running', 'SSH_COMMAND_FAILED', CURRENT_TIMESTAMP)`);
  for (let i = 0; i < 2; i++) await migrate('166_network_config_backup_run_receipts.sql');
  const store = new MysqlBackupScheduleStore(() => pool as any);
  assert.deepEqual(await store.get(7), { enabled: true, dailyTime: '00:00', timeZone: 'Asia/Shanghai', lastRun: null });
  await store.save(8, { enabled: false, dailyTime: '03:45' });
  assert.deepEqual((await store.targets()).map(t => t.deviceId), [7]);
  let captures = 0;
  const make = () => new ConfigBackupScheduler(store, async () => { captures++; }, () => new Date('2026-09-14T16:00:00Z'));
  await Promise.all([make().tick(), make().tick()]); await make().tick();
  assert.equal(captures, 1);
  assert.deepEqual((await store.get(7)).lastRun, { date: '2026-09-15', status: 'success', errorCode: null });
  assert.deepEqual((await store.get(9)).lastRun, { date: '2026-09-14', status: 'failed', errorCode: 'SSH_COMMAND_FAILED' });
  const stale = { deviceId: 8, enabled: true, dailyTime: '03:45' };
  assert.equal(await store.claim(stale, '2026-09-15'), false);
  await store.save(8, { enabled: true, dailyTime: '04:00' });
  assert.equal(await store.claim(stale, '2026-09-15'), false);
  assert.equal(await store.claim({ ...stale, dailyTime: '04:00' }, '2026-09-15'), true);
  await pool.query("UPDATE network_config_backup_runs SET started_at = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 11 MINUTE) WHERE device_id = 8");
  await store.expire();
  assert.equal((await store.get(8)).lastRun?.errorCode, 'CONFIG_BACKUP_RESULT_UNCONFIRMED');
  await pool.query('DELETE FROM network_devices WHERE id = 8');
  const [rows] = await pool.query<any[]>('SELECT * FROM network_config_backup_runs WHERE device_id = 8');
  assert.equal(rows.length, 0);
  console.log('PASS: repeat upgrade, legacy checkpoint, defaults, disabled/no-SSH filtering, concurrent/restart deduplication, stale-setting rejection, unconfirmed outcome, FK cleanup');
} finally {
  await pool?.end();
  if (created) await admin.query(`DROP DATABASE \`${schema}\``);
  await admin.end();
}
