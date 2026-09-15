// Integration qualification: uses DB_* credentials but creates its own disposable schema.
// Run: pnpm exec tsx tests/config-backup-schedule-mysql.ts
import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { splitSqlStatements } from '../src/migrations/runner.js';
import { MysqlBackupScheduleStore, ConfigBackupScheduler } from '../src/network-devices/config-backup-scheduler.js';

const schema = `slide_backup_test_${process.pid}`;
const config = { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' };
const admin = await mysql.createConnection(config);
let pool: mysql.Pool | undefined;
let created = false;
try {
  await admin.query(`CREATE DATABASE \`${schema}\``); created = true;
  pool = mysql.createPool({ ...config, database: schema, connectionLimit: 4 });
  await pool.query('CREATE TABLE network_devices (id BIGINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB');
  await pool.query('CREATE TABLE network_device_credentials (device_id BIGINT UNSIGNED NOT NULL, protocol VARCHAR(16) NOT NULL) ENGINE=InnoDB');
  const sql = await readFile(new URL('../sql/migrations/091_network_config_backup_schedule.sql', import.meta.url), 'utf8');
  for (let i = 0; i < 2; i++) for (const statement of splitSqlStatements(sql)) await pool.query(statement);
  await pool.query('INSERT INTO network_devices VALUES (7), (8), (9)');
  await pool.query("INSERT INTO network_device_credentials VALUES (7, 'ssh'), (8, 'ssh'), (9, 'snmpv3')");
  const store = new MysqlBackupScheduleStore(() => pool as any);
  assert.deepEqual(await store.get(7), { enabled: true, dailyTime: '00:00', timeZone: 'Asia/Shanghai', lastRun: null });
  await store.save(8, { enabled: false, dailyTime: '03:45' });
  assert.deepEqual((await store.targets()).map(t => t.deviceId), [7]);
  let captures = 0;
  const make = () => new ConfigBackupScheduler(store, async () => { captures++; }, () => new Date('2026-09-14T16:00:00Z'));
  await Promise.all([make().tick(), make().tick()]); await make().tick();
  assert.equal(captures, 1);
  assert.deepEqual((await store.get(7)).lastRun, { date: '2026-09-15', status: 'success', errorCode: null });
  const stale = { deviceId: 8, enabled: true, dailyTime: '03:45' };
  assert.equal(await store.claim(stale, '2026-09-15'), false);
  await store.save(8, { enabled: true, dailyTime: '04:00' });
  assert.equal(await store.claim(stale, '2026-09-15'), false);
  assert.equal(await store.claim({ ...stale, dailyTime: '04:00' }, '2026-09-15'), true);
  await pool.query("UPDATE network_config_backup_runs SET started_at = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 11 MINUTE) WHERE device_id = 8");
  await store.expire();
  assert.equal((await store.get(8)).lastRun?.errorCode, 'CONFIG_BACKUP_INTERRUPTED');
  await pool.query('DELETE FROM network_devices WHERE id = 8');
  const [rows] = await pool.query<any[]>('SELECT * FROM network_config_backup_runs WHERE device_id = 8');
  assert.equal(rows.length, 0);
  console.log('PASS: repeat migration, defaults, disabled/no-SSH filtering, concurrent/restart deduplication, stale-setting rejection, interrupted outcome, FK cleanup');
} finally {
  await pool?.end();
  if (created) await admin.query(`DROP DATABASE \`${schema}\``);
  await admin.end();
}
