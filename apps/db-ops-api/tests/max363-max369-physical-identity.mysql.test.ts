import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../src/db-connection.js';
import { instanceDatabaseService } from '../src/instance-database-service.js';
import { MigrationRunner } from '../src/migrations/runner.js';

const migrationFile = fileURLToPath(new URL('../sql/migrations/153_instance_physical_occupancy.sql', import.meta.url));

type MysqlEnv = Record<string, string | undefined>;

function acceptanceEnabled(env: MysqlEnv = process.env): boolean {
  return env.MAX363_MYSQL_ACCEPTANCE === '1';
}

function mysqlTestConfig(env: MysqlEnv = process.env): mysql.ConnectionOptions {
  const host = env.MAX363_MYSQL_HOST;
  const portText = env.MAX363_MYSQL_PORT;
  const user = env.MAX363_MYSQL_USER;
  const password = env.MAX363_MYSQL_PASSWORD;
  const port = Number(portText);
  if (host !== '127.0.0.1' || portText !== '3308' || !Number.isInteger(port) || !user || password === undefined) {
    throw new Error(
      'MAX363_MYSQL_ACCEPTANCE=1 requires MAX363_MYSQL_HOST=127.0.0.1, MAX363_MYSQL_PORT=3308, MAX363_MYSQL_USER, and MAX363_MYSQL_PASSWORD',
    );
  }
  return { host, port, user, password };
}

const tableSql = `
CREATE TABLE database_instances (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  environment ENUM('development', 'staging', 'production', 'testing') NOT NULL DEFAULT 'development',
  db_type ENUM('mysql', 'postgresql', 'oracle', 'dameng', 'mongodb', 'redis', 'elasticsearch') NOT NULL DEFAULT 'mysql',
  host VARCHAR(255) NOT NULL,
  port INT NOT NULL,
  username VARCHAR(100) NOT NULL,
  password_encrypted VARCHAR(255) NOT NULL,
  database_name VARCHAR(100) DEFAULT NULL,
  db_version VARCHAR(50) DEFAULT NULL,
  data_size_gb DECIMAL(10,2) DEFAULT NULL,
  connection_string VARCHAR(500) DEFAULT NULL,
  max_connections INT DEFAULT 100,
  connection_timeout_ms INT DEFAULT 30000,
  status ENUM('active', 'inactive', 'error') NOT NULL DEFAULT 'active',
  lifecycle_state ENUM('available', 'deleting', 'deleted') NOT NULL DEFAULT 'available',
  removal_requested_at DATETIME(6) NULL,
  removed_at DATETIME(6) NULL,
  removal_reasons JSON NULL,
  health_score INT DEFAULT 100,
  health_status ENUM('healthy', 'warning', 'critical', 'unknown') DEFAULT 'unknown',
  last_health_check_at DATETIME DEFAULT NULL,
  tags JSON DEFAULT NULL,
  description TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY idx_name_environment (name, environment)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

describe('MAX-363 injected mysql acceptance config', () => {
  it('stays disabled until this task explicitly enables real acceptance', () => {
    expect(acceptanceEnabled({})).toBe(false);
    expect(acceptanceEnabled({ MAX363_MYSQL_ACCEPTANCE: '0' })).toBe(false);
  });

  it('fails when real acceptance is enabled without the injected 3308 endpoint', () => {
    expect(() => mysqlTestConfig({ MAX363_MYSQL_ACCEPTANCE: '1' })).toThrow(/MAX363_MYSQL_PORT=3308/);
    expect(() => mysqlTestConfig({
      MAX363_MYSQL_ACCEPTANCE: '1',
      MAX363_MYSQL_HOST: '127.0.0.1',
      MAX363_MYSQL_PORT: '3306',
      MAX363_MYSQL_USER: 'root',
      MAX363_MYSQL_PASSWORD: 'injected',
    })).toThrow(/MAX363_MYSQL_PORT=3308/);
  });
});

describe.skipIf(!acceptanceEnabled())('MAX-363/MAX-369 physical identity on isolated mysql3308', () => {
  let config: mysql.ConnectionOptions;
  const suffix = randomBytes(4).toString('hex');
  const failureSchema = `max363_fail_${suffix}`;
  const schema = `max363_ok_${suffix}`;
  let admin: mysql.Connection;
  let pool: mysql.Pool;
  let migrationDir: string;

  const createInput = (overrides: Record<string, unknown> = {}) => ({
    name: `inst-${randomBytes(3).toString('hex')}`,
    environment: 'development',
    db_type: 'mysql',
    host: '192.0.2.20',
    port: 33061,
    username: 'reader',
    password: `pw-${randomBytes(4).toString('hex')}`,
    database_name: 'app',
    ...overrides,
  });

  async function indexNames(): Promise<string[]> {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT INDEX_NAME AS name FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'database_instances' GROUP BY INDEX_NAME`,
    );
    return rows.map((row) => String(row.name));
  }

  async function rowOf(id: number): Promise<mysql.RowDataPacket> {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT id, name, host, port, database_name, lifecycle_state, password_encrypted, description FROM database_instances WHERE id = ?',
      [id],
    );
    return rows[0];
  }

  const ownedSchemas = new Set<string>();

  async function createOwnedDatabase(name: string, owned: Set<string> = ownedSchemas): Promise<void> {
    await admin.query(`CREATE DATABASE \`${name}\``);
    owned.add(name);
  }

  async function dropOwnedDatabases(owned: Set<string> = ownedSchemas): Promise<void> {
    for (const name of [...owned]) {
      await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      owned.delete(name);
    }
  }

  beforeAll(async () => {
    config = mysqlTestConfig();
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('NODE_ENV', 'test');
    admin = await mysql.createConnection(config);
    await createOwnedDatabase(failureSchema);
    await createOwnedDatabase(schema);
    pool = mysql.createPool({ ...config, database: schema, connectionLimit: 12 });
    await pool.query(tableSql);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (pool) await pool.end();
    if (admin) {
      await dropOwnedDatabases();
      await admin.end();
    }
    if (migrationDir) await rm(migrationDir, { recursive: true, force: true });
  });

  it('drops only databases this run created successfully', async () => {
    const preexisting = `max363_pre_${suffix}`;
    const created = `max363_owned_${suffix}`;
    const probeOwned = new Set<string>();
    await admin.query(`CREATE DATABASE \`${preexisting}\``);
    try {
      await admin.query(`CREATE TABLE \`${preexisting}\`.marker (id INT PRIMARY KEY)`);
      await admin.query(`INSERT INTO \`${preexisting}\`.marker VALUES (1)`);
      await expect(createOwnedDatabase(preexisting, probeOwned)).rejects.toThrow(/database exists/);
      expect(probeOwned.has(preexisting)).toBe(false);
      expect(ownedSchemas.has(preexisting)).toBe(false);
      await dropOwnedDatabases(probeOwned);
      const [kept] = await admin.query<mysql.RowDataPacket[]>(`SELECT id FROM \`${preexisting}\`.marker`);
      expect(kept).toEqual([{ id: 1 }]);

      await createOwnedDatabase(created, probeOwned);
      await dropOwnedDatabases(probeOwned);
      const [gone] = await admin.query<mysql.RowDataPacket[]>(
        'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
        [created],
      );
      expect(gone).toHaveLength(0);
      const [still] = await admin.query<mysql.RowDataPacket[]>(`SELECT id FROM \`${preexisting}\`.marker`);
      expect(still).toEqual([{ id: 1 }]);
    } finally {
      await dropOwnedDatabases(probeOwned);
      await admin.query(`DROP DATABASE IF EXISTS \`${preexisting}\``);
    }
  });

  it('fails the occupancy migration without rewriting duplicate history and does not replay it', async () => {
    const failurePool = mysql.createPool({ ...config, database: failureSchema, connectionLimit: 1 });
    migrationDir = await mkdtemp(join(tmpdir(), 'max363-migration-'));
    try {
      await failurePool.query(tableSql);
      await failurePool.query(
        `INSERT INTO database_instances (name, environment, host, port, username, password_encrypted, database_name, lifecycle_state)
         VALUES ('dup-a','development','192.0.2.40',33061,'u','cipher-a','sales','available'),
                ('dup-b','testing','192.0.2.40',33061,'u','cipher-b','sales','available')`,
      );
      const sql = await readFile(migrationFile, 'utf8');
      await writeFile(join(migrationDir, '153_instance_physical_occupancy.sql'), sql);
      const runner = new MigrationRunner(failurePool, migrationDir);
      await expect(runner.run()).rejects.toThrow(/153_instance_physical_occupancy.sql failed/);
      const [rows] = await failurePool.query<mysql.RowDataPacket[]>(
        'SELECT name, password_encrypted, lifecycle_state FROM database_instances ORDER BY name',
      );
      expect(rows.map((row) => row.password_encrypted)).toEqual(['cipher-a', 'cipher-b']);
      const [columns] = await failurePool.query<mysql.RowDataPacket[]>(
        `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'database_instances' AND COLUMN_NAME = 'physical_occupancy_slot'`,
      );
      expect(columns).toHaveLength(0);
      const [ledger] = await failurePool.query<mysql.RowDataPacket[]>(
        `SELECT status, statement_index FROM app_schema_migrations WHERE migration_id = '153_instance_physical_occupancy.sql'`,
      );
      expect(ledger[0]).toMatchObject({ status: 'failed', statement_index: 0 });
      await expect(runner.run()).rejects.toThrow(/requires explicit repair/);
      const [retryRows] = await failurePool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM database_instances');
      expect(Number(retryRows[0].n)).toBe(2);
    } finally {
      await failurePool.end();
    }
  });

  it('installs the occupancy index once duplicates are absent', async () => {
    const sql = await readFile(migrationFile, 'utf8');
    await pool.query(sql);
    expect(await indexNames()).toContain('uk_instance_physical_occupancy');
    const [columns] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME AS name, EXTRA AS extra FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'database_instances'
         AND COLUMN_NAME IN ('physical_database_key', 'physical_occupancy_slot')`,
    );
    expect(columns).toHaveLength(2);
    for (const column of columns) expect(String(column.extra).toUpperCase()).toContain('INVISIBLE');
  });

  it('re-registers a deleted address under a new id and keeps the tombstone credentials', async () => {
    const host = '192.0.2.21';
    const first = await instanceDatabaseService.createInstance(createInput({ name: 'tomb-name', host, password: 'old-secret' }));
    expect(first.success).toBe(true);
    const original = await rowOf(first.instanceId!);
    await pool.query("UPDATE database_instances SET lifecycle_state = 'deleted', removed_at = NOW(6) WHERE id = ?", [first.instanceId]);
    const sameName = await instanceDatabaseService.createInstance(createInput({ name: 'tomb-name', host, password: 'new-secret' }));
    expect(sameName).toMatchObject({ success: false, error: '该环境下实例名称已存在' });
    const again = await instanceDatabaseService.createInstance(createInput({ name: 'reborn', host, password: 'new-secret' }));
    expect(again.success).toBe(true);
    expect(again.instanceId).not.toBe(first.instanceId);
    const tombstone = await rowOf(first.instanceId!);
    const revived = await rowOf(again.instanceId!);
    expect(tombstone.lifecycle_state).toBe('deleted');
    expect(tombstone.password_encrypted).toBe(original.password_encrypted);
    expect(revived.password_encrypted).not.toBe(original.password_encrypted);
    expect(revived.id).not.toBe(tombstone.id);
  });

  it('blocks available and deleting occupants and treats null and empty database names as one address', async () => {
    const host = '192.0.2.22';
    const live = await instanceDatabaseService.createInstance(createInput({ name: 'live-addr', host, database_name: 'sales' }));
    expect(live.success).toBe(true);
    const duplicate = await instanceDatabaseService.createInstance(createInput({ name: 'other-addr', environment: 'testing', host, database_name: 'Sales' }));
    expect(duplicate.success).toBe(false);
    expect(duplicate.instanceId).toBe(live.instanceId);
    expect(duplicate.error).toContain('纳管');
    expect(duplicate.error).not.toMatch(/Duplicate entry|ER_DUP_ENTRY/);
    const deleting = await instanceDatabaseService.createInstance(createInput({ name: 'soon-gone', host: '192.0.2.23', database_name: 'gone' }));
    await pool.query("UPDATE database_instances SET lifecycle_state = 'deleting' WHERE id = ?", [deleting.instanceId]);
    const blocked = await instanceDatabaseService.createInstance(createInput({ name: 'while-deleting', environment: 'testing', host: '192.0.2.23', database_name: 'gone' }));
    expect(blocked.success).toBe(false);
    expect(blocked.instanceId).toBeUndefined();
    expect(blocked.error).toContain('正在删除');
    const [count] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM database_instances WHERE host = '192.0.2.23'",
    );
    expect(Number(count[0].n)).toBe(1);

    const blank = await instanceDatabaseService.createInstance(createInput({ name: 'blank-db', host: '192.0.2.24', database_name: '' }));
    expect(blank.success).toBe(true);
    const nullName = await instanceDatabaseService.createInstance(createInput({ name: 'null-db', environment: 'staging', host: '192.0.2.24', database_name: undefined }));
    expect(nullName.success).toBe(false);
    expect(nullName.error).toContain('纳管');
    const spaced = await instanceDatabaseService.createInstance(createInput({ name: 'spaced-db', environment: 'production', host: '192.0.2.24', database_name: 'sales ' }));
    expect(spaced.success).toBe(true);
  });

  it('treats a trailing space as the same address and still stores the original characters', async () => {
    const host = '192.0.2.70';
    const first = await instanceDatabaseService.createInstance(createInput({ name: 'space-a', host, database_name: 'sales' }));
    expect(first.success).toBe(true);
    const spaced = await instanceDatabaseService.createInstance(createInput({
      name: 'space-b',
      environment: 'testing',
      host,
      database_name: 'sales ',
    }));
    expect(spaced.success).toBe(false);
    expect(spaced.instanceId).toBe(first.instanceId);
    expect(spaced.error).toContain('纳管');
    expect(spaced.error).not.toMatch(/Duplicate entry|ER_DUP_ENTRY/);
    expect((await rowOf(first.instanceId!)).database_name).toBe('sales');

    const mover = await instanceDatabaseService.createInstance(createInput({
      name: 'space-mover',
      host: '192.0.2.72',
      database_name: 'other',
      description: 'stay',
    }));
    const moved = await instanceDatabaseService.updateInstance(mover.instanceId!, {
      host,
      database_name: 'sales ',
      description: 'changed',
    });
    expect(moved.success).toBe(false);
    expect(moved.error).toContain('纳管');
    expect(moved.error).not.toMatch(/Duplicate entry|ER_DUP_ENTRY/);
    const unchanged = await rowOf(mover.instanceId!);
    expect(unchanged.host).toBe('192.0.2.72');
    expect(unchanged.database_name).toBe('other');
    expect(unchanged.description).toBe('stay');

    const otherHost = await instanceDatabaseService.createInstance(createInput({
      name: 'space-c',
      environment: 'staging',
      host: '192.0.2.71',
      database_name: 'sales ',
    }));
    expect(otherHost.success).toBe(true);
    expect((await rowOf(otherHost.instanceId!)).database_name).toBe('sales ');
  });

  it('rejects a denied target before insert and keeps an ordinary update', async () => {
    const created = await instanceDatabaseService.createInstance(createInput({ name: 'stable', host: '192.0.2.25', password: 'keep-me', description: 'before' }));
    expect(created.success).toBe(true);
    const before = await rowOf(created.instanceId!);
    const denied = await instanceDatabaseService.createInstance(createInput({ name: 'loop', host: '127.0.0.1', port: 33061 }));
    expect(denied).toMatchObject({ success: false, error: 'DB_TARGET_ADDRESS_DENIED' });
    const [deniedRows] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM database_instances WHERE host = '127.0.0.1'");
    expect(Number(deniedRows[0].n)).toBe(0);
    const updated = await instanceDatabaseService.updateInstance(created.instanceId!, { description: 'after', max_connections: 7 });
    expect(updated).toEqual({ success: true });
    const after = await rowOf(created.instanceId!);
    expect(after.password_encrypted).toBe(before.password_encrypted);
    expect(after.host).toBe(before.host);
    expect(after.database_name).toBe(before.database_name);
    expect(after.description).toBe('after');
  });

  it('rejects an update onto an occupied or deleting address and does not save it', async () => {
    const holder = await instanceDatabaseService.createInstance(createInput({ name: 'holder', host: '192.0.2.26', database_name: 'held' }));
    const mover = await instanceDatabaseService.createInstance(createInput({ name: 'mover', host: '192.0.2.27', database_name: 'mine', password: 'mover-secret', description: 'stay' }));
    const before = await rowOf(mover.instanceId!);
    const conflict = await instanceDatabaseService.updateInstance(mover.instanceId!, { host: '192.0.2.26', database_name: 'HELD', description: 'changed' });
    expect(conflict.success).toBe(false);
    expect(conflict.error).toContain(`ID: ${holder.instanceId}`);
    expect(conflict.error).not.toMatch(/Duplicate entry|ER_DUP_ENTRY/);
    const after = await rowOf(mover.instanceId!);
    expect(after.host).toBe('192.0.2.27');
    expect(after.description).toBe('stay');
    expect(after.password_encrypted).toBe(before.password_encrypted);
    const deleting = await instanceDatabaseService.createInstance(createInput({ name: 'deleting-target', host: '192.0.2.28', database_name: 'busy' }));
    await pool.query("UPDATE database_instances SET lifecycle_state = 'deleting' WHERE id = ?", [deleting.instanceId]);
    const blocked = await instanceDatabaseService.updateInstance(mover.instanceId!, { host: '192.0.2.28', database_name: 'busy' });
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('正在删除');
    expect((await rowOf(mover.instanceId!)).host).toBe('192.0.2.27');
    const moved = await instanceDatabaseService.updateInstance(mover.instanceId!, { host: '192.0.2.29', description: 'moved' });
    expect(moved).toEqual({ success: true });
    expect((await rowOf(mover.instanceId!)).host).toBe('192.0.2.29');
    const reused = await instanceDatabaseService.createInstance(createInput({ name: 'old-home', environment: 'testing', host: '192.0.2.27', database_name: 'mine' }));
    expect(reused.success).toBe(true);
  });

  it('lets the unique index settle concurrent creates, updates, and create-versus-update', async () => {
    const host = '192.0.2.30';
    const created = await Promise.all(Array.from({ length: 6 }, (_, index) => instanceDatabaseService.createInstance(createInput({
      name: `race-${index}`,
      environment: index % 2 === 0 ? 'development' : 'testing',
      host,
      database_name: 'raced',
    }))));
    const winners = created.filter((result) => result.success);
    expect(winners).toHaveLength(1);
    for (const result of created.filter((item) => !item.success)) {
      expect(result.error).not.toMatch(/Duplicate entry|ER_DUP_ENTRY|SQL/);
    }
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT id FROM database_instances WHERE host = ? AND database_name = 'raced' AND lifecycle_state <> 'deleted'",
      [host],
    );
    expect(rows).toHaveLength(1);

    const left = await instanceDatabaseService.createInstance(createInput({ name: 'left', host: '192.0.2.31', database_name: 'one' }));
    const right = await instanceDatabaseService.createInstance(createInput({ name: 'right', host: '192.0.2.32', database_name: 'two' }));
    const updates = await Promise.all([
      instanceDatabaseService.updateInstance(left.instanceId!, { host: '192.0.2.33', database_name: 'shared' }),
      instanceDatabaseService.updateInstance(right.instanceId!, { host: '192.0.2.33', database_name: 'shared' }),
    ]);
    expect(updates.filter((result) => result.success)).toHaveLength(1);
    expect(updates.filter((result) => !result.success)[0].error).not.toMatch(/Duplicate entry/);
    const [shared] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT id, host FROM database_instances WHERE host = '192.0.2.33' AND lifecycle_state = 'available'",
    );
    expect(shared).toHaveLength(1);
    const loserId = [left.instanceId, right.instanceId].find((id) => id !== shared[0].id)!;
    const loser = await rowOf(loserId);
    expect(['192.0.2.31', '192.0.2.32']).toContain(loser.host);

    const resident = await instanceDatabaseService.createInstance(createInput({ name: 'resident', host: '192.0.2.34', database_name: 'home' }));
    const incomingHost = '192.0.2.35';
    const [insertOutcome, updateOutcome] = await Promise.allSettled([
      pool.query(
        `INSERT INTO database_instances (name, environment, db_type, host, port, username, password_encrypted, database_name)
         VALUES ('incoming','staging','mysql',? ,33061,'u','cipher-incoming','contended')`,
        [incomingHost],
      ),
      pool.query(
        "UPDATE database_instances SET host = ?, database_name = 'contended', description = 'should-win-or-rollback' WHERE id = ?",
        [incomingHost, resident.instanceId],
      ),
    ]);
    const failures = [insertOutcome, updateOutcome].filter((outcome) => outcome.status === 'rejected');
    expect(failures.length).toBeGreaterThanOrEqual(1);
    const [contended] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT id, description, password_encrypted FROM database_instances WHERE host = ? AND IFNULL(database_name,'') = 'contended'",
      [incomingHost],
    );
    expect(contended).toHaveLength(1);
    if (contended[0].id === resident.instanceId) {
      expect(contended[0].password_encrypted).not.toBe('cipher-incoming');
    } else {
      expect((await rowOf(resident.instanceId!)).host).toBe('192.0.2.34');
      expect((await rowOf(resident.instanceId!)).description).not.toBe('should-win-or-rollback');
    }
  });
});
