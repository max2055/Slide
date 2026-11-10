/**
 * MAX-362 real MySQL read-only execution gate.
 *
 * Classification unit tests cannot prove the product refuses a statement
 * before SqlExecutor sends it. This file connects to the shared mysql3308
 * test instance, runs the allowed statements through the real executor, and
 * checks that locking reads and executable-comment writes never arrive.
 */
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseService } from './database-service.js';
import { sqlExecutor } from './sql-executor.js';

const execFileAsync = promisify(execFile);
const SCHEMA = `slide_max362_${process.pid}`;
const INSTANCE_ID = 3_620_000_000 + (process.pid % 100_000);
const OUTFILE = '/var/lib/mysql-files/max362-not-written.txt';

interface MysqlTestProfile {
  host: string;
  port: number;
  user: string;
  password: string;
}

function loadMysqlTestProfile(): MysqlTestProfile {
  const profiles = JSON.parse(readFileSync('/Users/max/.config/slide-test-access/connection-profiles.json', 'utf8')) as {
    'mysql-test'?: MysqlTestProfile;
  };
  const profile = profiles['mysql-test'];
  if (!profile?.host || !profile.port || !profile.user || !profile.password) {
    throw new Error('mysql-test profile is incomplete');
  }
  return profile;
}

async function statementHits(pool: Pool, marker: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS hits
     FROM performance_schema.events_statements_history
     WHERE SQL_TEXT LIKE ?
       AND SQL_TEXT NOT LIKE '%events_statements_history%'`,
    [`%${marker}%`],
  );
  return Number(rows[0]?.hits ?? 0);
}

describe('MAX-362 MySQL read-only execution gate', () => {
  const profile = loadMysqlTestProfile();
  let admin: Pool;

  beforeAll(async () => {
    admin = mysql.createPool({
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password: profile.password,
      connectionLimit: 2,
    });
    await admin.query(`CREATE DATABASE \`${SCHEMA}\``);
    await admin.query(`CREATE TABLE \`${SCHEMA}\`.gate_rows (id INT PRIMARY KEY, msg VARCHAR(255))`);
    await admin.query(
      `INSERT INTO \`${SCHEMA}\`.gate_rows (id, msg) VALUES (1, 'please for update now'), (2, '%into%'), (3, 'sleep(')`,
    );
    const connected = await databaseService.addConnection(INSTANCE_ID, 'max362-readonly-gate', {
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password: profile.password,
      database: SCHEMA,
      db_type: 'mysql',
    });
    expect(connected).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await databaseService.removeConnection(INSTANCE_ID).catch(() => undefined);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${SCHEMA}\``).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
    await execFileAsync('docker', ['exec', 'mysql3308', 'rm', '-f', OUTFILE]).catch(() => undefined);
  }, 30_000);

  it('executes a real read whose strings only look dangerous', async () => {
    const result = await sqlExecutor.executeSql(
      INSTANCE_ID,
      "SELECT id, msg FROM gate_rows WHERE msg = 'please for update now' /* max362allow */",
    );
    expect(result.success).toBe(true);
    expect(result.rows).toEqual([expect.objectContaining({ id: 1, msg: 'please for update now' })]);
    expect(await statementHits(admin, 'max362allow')).toBeGreaterThan(0);
  }, 30_000);

  it('runs an inlined MySQL executable comment on the server', async () => {
    const result = await sqlExecutor.executeSql(INSTANCE_ID, 'SELECT 1 /*! + 1 */ AS modeled /* max362model */');
    expect(result.success).toBe(true);
    expect(result.rows?.[0]?.modeled).toBe(2);
    expect(await statementHits(admin, 'max362model')).toBeGreaterThan(0);
  }, 30_000);

  it.each([
    ["SELECT id FROM gate_rows LOCK IN SHARE MODE /* max362lock */", 'LOCKING_READ', 'max362lock'],
    ["SELECT id FROM gate_rows FOR/**/UPDATE /* max362forupdate */", 'LOCKING_READ', 'max362forupdate'],
    [`SELECT id FROM gate_rows /*! INTO OUTFILE '${OUTFILE}' */ /* max362outfile */`, 'SELECT_INTO', 'max362outfile'],
    ["SELECT id FROM gate_rows WHERE msg = 'sleep(' AND SLEEP(1) /* max362sleep */", 'DANGEROUS_FUNCTION', 'max362sleep'],
    ["SELECT id FROM gate_rows /*!50110 LOCK IN SHARE MODE */ /* max362version */", 'LOCKING_READ', 'max362version'],
  ] as const)('refuses %s before MySQL sees it', async (sql, reasonCode, marker) => {
    const before = await statementHits(admin, marker);
    const result = await sqlExecutor.executeSql(INSTANCE_ID, sql);
    expect(result).toMatchObject({ success: false, error: `SQL_APPROVAL_REQUIRED_${reasonCode}` });
    expect(await statementHits(admin, marker)).toBe(before);
  }, 30_000);

  it('does not create the outfile named by the refused statement', async () => {
    const listing = await execFileAsync('docker', ['exec', 'mysql3308', 'ls', '/var/lib/mysql-files']);
    expect(listing.stdout).not.toContain('max362-not-written.txt');
  });
});
