/**
 * MAX-362 real MySQL read-only execution gate.
 *
 * The full suite collects this file without a local credential path. Set
 * MAX362_READONLY_GATE=1 and MAX362_MYSQL_HOST, MAX362_MYSQL_PORT,
 * MAX362_MYSQL_USER, MAX362_MYSQL_PASSWORD to run it. With the gate enabled,
 * missing configuration fails the file instead of skipping. Optional
 * MAX362_MYSQL_CONTAINER selects the server container used to confirm the
 * refused outfile was not created (default mysql3308).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseService } from './database-service.js';
import { sqlExecutor } from './sql-executor.js';

const execFileAsync = promisify(execFile);
const SCHEMA = `slide_max362_${process.pid}`;
const INSTANCE_ID = 3_620_000_000 + (process.pid % 100_000);
const OUTFILE_NAME = `max362-${process.pid}-${Date.now()}-not-written.txt`;
const OUTFILE = `/var/lib/mysql-files/${OUTFILE_NAME}`;
const acceptance = process.env.MAX362_READONLY_GATE === '1';

interface MysqlTestProfile {
  host: string;
  port: number;
  user: string;
  password: string;
}

function loadGateProfile(): MysqlTestProfile {
  const host = process.env.MAX362_MYSQL_HOST ?? '';
  const port = Number(process.env.MAX362_MYSQL_PORT);
  const user = process.env.MAX362_MYSQL_USER ?? '';
  const password = process.env.MAX362_MYSQL_PASSWORD ?? '';
  if (!host || !Number.isSafeInteger(port) || port <= 0 || !user || !password) {
    throw new Error('MAX362_READONLY_GATE=1 requires MAX362_MYSQL_HOST, MAX362_MYSQL_PORT, MAX362_MYSQL_USER and MAX362_MYSQL_PASSWORD');
  }
  return { host, port, user, password };
}

if (acceptance) loadGateProfile();

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

describe.skipIf(!acceptance)('MAX-362 MySQL read-only execution gate', () => {
  let admin: Pool;

  beforeAll(async () => {
    const profile = loadGateProfile();
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
    ["SELECT 'a\\' , SLEEP(0) AS executed -- max362nobackslash '", 'DANGEROUS_FUNCTION', 'max362nobackslash'],
    ["SELECT 'a\\' FROM gate_rows FOR UPDATE -- max362nobacklock '", 'LOCKING_READ', 'max362nobacklock'],
    ["SELECT 'a\\' FROM gate_rows /*!50110 FOR UPDATE */ -- max362nobackcmt '", 'LOCKING_READ', 'max362nobackcmt'],
  ] as const)('refuses %s before MySQL sees it', async (sql, reasonCode, marker) => {
    const before = await statementHits(admin, marker);
    const result = await sqlExecutor.executeSql(INSTANCE_ID, sql);
    expect(result).toMatchObject({ success: false, error: `SQL_APPROVAL_REQUIRED_${reasonCode}` });
    expect(await statementHits(admin, marker)).toBe(before);
  }, 30_000);

  it('executes a literal whose escaped quote stays inside the string', async () => {
    const result = await sqlExecutor.executeSql(
      INSTANCE_ID,
      "SELECT 'it\\'s for update now' AS msg /* max362literal */",
    );
    expect(result.success).toBe(true);
    expect(result.rows?.[0]?.msg).toBe("it's for update now");
    expect(await statementHits(admin, 'max362literal')).toBeGreaterThan(0);
  }, 30_000);

  it('does not create the outfile named by the refused statement', async () => {
    const container = process.env.MAX362_MYSQL_CONTAINER ?? 'mysql3308';
    const listing = await execFileAsync('docker', ['exec', container, 'ls', '/var/lib/mysql-files']);
    expect(listing.stdout.split('\n')).not.toContain(OUTFILE_NAME);
  });
});
