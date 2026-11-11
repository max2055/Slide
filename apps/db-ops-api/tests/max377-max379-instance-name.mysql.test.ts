import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signAccessToken, actorContextService, type ActorContext } from '../src/auth/actor-context.js';
import { dbConnection } from '../src/db-connection.js';
import { getPlatformTool } from '../src/adapter/get-agent-engine.js';
import { executeToolWithPolicy, type ToolApprovalAuthorizer, type ToolApprovalRequester } from '../src/tools/policy.js';
import type { AnyAgentTool } from '../src/tools/types.js';
import { instanceDatabaseService } from '../src/instance-database-service.js';

type MysqlEnv = Record<string, string | undefined>;

function acceptanceEnabled(env: MysqlEnv = process.env): boolean {
  return env.MAX377_MYSQL_ACCEPTANCE === '1';
}

function mysqlTestConfig(env: MysqlEnv = process.env): mysql.ConnectionOptions {
  const host = env.MAX377_MYSQL_HOST;
  const portText = env.MAX377_MYSQL_PORT;
  const user = env.MAX377_MYSQL_USER;
  const password = env.MAX377_MYSQL_PASSWORD;
  const port = Number(portText);
  if (host !== '127.0.0.1' || portText !== '3308' || !Number.isInteger(port) || !user || password === undefined) {
    throw new Error(
      'MAX377_MYSQL_ACCEPTANCE=1 requires MAX377_MYSQL_HOST=127.0.0.1, MAX377_MYSQL_PORT=3308, MAX377_MYSQL_USER, and MAX377_MYSQL_PASSWORD',
    );
  }
  return { host, port, user, password };
}

const SCHEMA_NAME = /^[A-Za-z0-9_]+$/;

/** A resolved Ok packet is the only receipt that grants cleanup ownership. */
function isConfirmedCreateDatabaseReceipt(receipt: unknown): boolean {
  const packet = Array.isArray(receipt) ? receipt[0] : receipt;
  if (!packet || typeof packet !== 'object') return false;
  const row = packet as { fieldCount?: unknown; affectedRows?: unknown; serverStatus?: unknown; warningStatus?: unknown };
  return row.fieldCount === 0
    && typeof row.affectedRows === 'number'
    && Number.isFinite(row.affectedRows)
    && typeof row.serverStatus === 'number'
    && typeof row.warningStatus === 'number';
}

type SqlExecutor = { query: (sql: string) => Promise<unknown> };

async function createOwnedDatabase(executor: SqlExecutor, name: string, owned: Set<string>): Promise<void> {
  if (!SCHEMA_NAME.test(name)) throw new Error('INVALID_SCHEMA_NAME');
  const receipt = await executor.query(`CREATE DATABASE \`${name}\``);
  if (!isConfirmedCreateDatabaseReceipt(receipt)) throw new Error('CREATE_DATABASE_RECEIPT_UNKNOWN');
  owned.add(name);
}

async function dropOwnedDatabases(executor: SqlExecutor, owned: Set<string>): Promise<void> {
  const failed: string[] = [];
  for (const name of [...owned]) {
    if (!SCHEMA_NAME.test(name)) {
      failed.push(name);
      continue;
    }
    try {
      await executor.query(`DROP DATABASE \`${name}\``);
      owned.delete(name);
    } catch {
      failed.push(name);
    }
  }
  if (failed.length) throw new Error(`CLEANUP_ERROR ${failed.join(',')}`);
}

/** Cleanup failure stays separate and must not replace an already recorded init failure. */
function cleanupReplacesInit(initError: unknown, cleanupError: unknown): boolean {
  return cleanupError != null && initError == null;
}

describe('MAX-377 injected mysql acceptance config', () => {
  it('stays disabled until this task explicitly enables real acceptance', () => {
    expect(acceptanceEnabled({})).toBe(false);
    expect(acceptanceEnabled({ MAX377_MYSQL_ACCEPTANCE: '0' })).toBe(false);
  });

  it('fails when real acceptance is enabled without the injected 3308 endpoint', () => {
    expect(() => mysqlTestConfig({ MAX377_MYSQL_ACCEPTANCE: '1' })).toThrow(/MAX377_MYSQL_PORT=3308/);
    expect(() => mysqlTestConfig({
      MAX377_MYSQL_ACCEPTANCE: '1',
      MAX377_MYSQL_HOST: '127.0.0.1',
      MAX377_MYSQL_PORT: '3306',
      MAX377_MYSQL_USER: 'root',
      MAX377_MYSQL_PASSWORD: 'injected',
    })).toThrow(/MAX377_MYSQL_PORT=3308/);
  });

  it('grants drop rights only after a confirmed create receipt', async () => {
    const dropped: string[] = [];
    const owned = new Set<string>();
    const executor: SqlExecutor = {
      async query(sql: string) {
        if (sql.includes('`exists`')) throw new Error("Can't create database 'exists'; database exists");
        if (sql.includes('`unknown`')) return { unexpected: true };
        if (sql.startsWith('CREATE')) return [{ fieldCount: 0, affectedRows: 1, serverStatus: 2, warningStatus: 0 }];
        if (sql.startsWith('DROP')) {
          dropped.push(sql);
          return [];
        }
        throw new Error(`unexpected sql ${sql}`);
      },
    };
    await expect(createOwnedDatabase(executor, 'exists', owned)).rejects.toThrow(/database exists/);
    await expect(createOwnedDatabase(executor, 'unknown', owned)).rejects.toThrow(/CREATE_DATABASE_RECEIPT_UNKNOWN/);
    expect(owned.size).toBe(0);
    expect(isConfirmedCreateDatabaseReceipt(undefined)).toBe(false);
    expect(isConfirmedCreateDatabaseReceipt({ affectedRows: 1, serverStatus: 2, warningStatus: 0 })).toBe(false);
    await dropOwnedDatabases(executor, owned);
    expect(dropped).toEqual([]);
    await createOwnedDatabase(executor, 'owned_ok', owned);
    await dropOwnedDatabases(executor, owned);
    expect(dropped).toEqual(['DROP DATABASE `owned_ok`']);
    expect(owned.size).toBe(0);
    expect(cleanupReplacesInit(new Error('init'), new Error('CLEANUP_ERROR'))).toBe(false);
    expect(cleanupReplacesInit(undefined, new Error('CLEANUP_ERROR'))).toBe(true);
  });
});

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
  status ENUM('active', 'inactive', 'error') NOT NULL DEFAULT 'active',
  lifecycle_state ENUM('available', 'deleting', 'deleted') NOT NULL DEFAULT 'available',
  removal_requested_at DATETIME(6) NULL,
  removed_at DATETIME(6) NULL,
  removal_reasons JSON NULL,
  health_score INT DEFAULT 100,
  health_status ENUM('healthy', 'warning', 'critical', 'unknown') DEFAULT 'unknown',
  last_health_check_at DATETIME DEFAULT NULL,
  max_connections INT DEFAULT 100,
  connection_timeout_ms INT DEFAULT 30000,
  tags JSON DEFAULT NULL,
  description TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  physical_database_key VARCHAR(100) AS (IFNULL(database_name, '')) VIRTUAL,
  physical_occupancy_slot TINYINT UNSIGNED AS (IF(lifecycle_state = 'deleted', NULL, 0)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY idx_name_environment (name, environment),
  UNIQUE KEY uk_instance_physical_occupancy (host, port, physical_database_key, physical_occupancy_slot)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE users (
  id INT UNSIGNED NOT NULL PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL,
  password_hash VARCHAR(255) NULL,
  session_version INT NOT NULL
);
CREATE TABLE roles (id INT UNSIGNED NOT NULL PRIMARY KEY, name VARCHAR(100) NOT NULL);
CREATE TABLE permissions (id INT UNSIGNED NOT NULL PRIMARY KEY, code VARCHAR(100) NOT NULL);
CREATE TABLE user_roles (
  user_id INT UNSIGNED NOT NULL,
  role_id INT UNSIGNED NOT NULL,
  grant_expiry DATETIME NULL
);
CREATE TABLE role_permissions (role_id INT UNSIGNED NOT NULL, permission_id INT UNSIGNED NOT NULL);
CREATE TABLE instance_permissions (
  user_id INT UNSIGNED NOT NULL,
  instance_id INT UNSIGNED NOT NULL,
  access_level ENUM('read-only', 'read-write', 'admin') NOT NULL,
  grant_expiry DATETIME NULL
);
CREATE TABLE agent_tool_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  phase ENUM('decision','result') NOT NULL,
  actor_id INT UNSIGNED NOT NULL,
  agent_id VARCHAR(64) NOT NULL DEFAULT 'slide-db-ops',
  request_id VARCHAR(128) NOT NULL,
  tool_name VARCHAR(128) NOT NULL,
  allowed BOOLEAN NOT NULL,
  reason_code VARCHAR(64) NOT NULL,
  resource_json JSON NOT NULL,
  policy_snapshot JSON NOT NULL,
  args_redacted JSON NOT NULL,
  result_redacted JSON NULL,
  approval_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
)`;

describe.skipIf(!acceptanceEnabled())('MAX-377/MAX-379 name identity on isolated mysql3308', () => {
  const suffix = randomBytes(4).toString('hex');
  const schema = `max377_${suffix}`;
  const jwtSecret = randomBytes(32).toString('hex');
  const hiddenMarker = `hidden-${suffix}`;
  let admin: mysql.Connection;
  let pool: mysql.Pool;
  let initError: unknown;
  const ownedSchemas = new Set<string>();
  let addTool: AnyAgentTool;
  let updateTool: AnyAgentTool;
  let writer: ActorContext;
  let limited: ActorContext;
  let noscope: ActorContext;
  let noperm: ActorContext;
  const granted: Array<{ id: string; tool: string; resource: unknown }> = [];
  let approvalSeq = 0;
  const approvalRequester: ToolApprovalRequester = {
    async submit(_actor, tool, _args, resource) {
      const id = String(++approvalSeq);
      granted.push({ id, tool: tool.name, resource });
      return { id, expiresAt: new Date(Date.now() + 60_000) };
    },
  };
  const approvalAuthorizer: ToolApprovalAuthorizer = {
    async authorize(_actor, tool, args, resource, _options, audit) {
      const id = typeof args.approvalId === 'string' ? args.approvalId : '';
      const prior = granted.find((item) => item.id === id && item.tool === tool.name);
      const sameResource = prior ? JSON.stringify(prior.resource) === JSON.stringify(resource) : false;
      const outcome = prior && sameResource
        ? { approved: true as const }
        : { approved: false as const, failure: 'INVALID_APPROVAL' as const };
      await audit(outcome);
      return outcome;
    },
    async consume() {
      return { approved: false, failure: 'INVALID_APPROVAL' };
    },
  };

  async function login(userId: number): Promise<ActorContext> {
    const token = signAccessToken({
      userId,
      username: 'pending',
      roles: [],
      permissions: [],
      sessionVersion: 1,
      instanceScopes: {},
      requestId: 'issue',
    }, jwtSecret);
    return actorContextService.authenticateAccessToken(token, jwtSecret);
  }

  async function instances(): Promise<mysql.RowDataPacket[]> {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT id, name, environment, host, port, database_name, description
       FROM database_instances ORDER BY id`,
    );
    return rows;
  }

  async function run(tool: AnyAgentTool, actor: ActorContext, args: Record<string, unknown>) {
    const blocked = await executeToolWithPolicy(actor, tool, args, undefined, approvalAuthorizer, undefined, undefined, {
      approvalRequester,
    });
    if (blocked.decision.reasonCode !== 'APPROVAL_REQUIRED') return blocked;
    return executeToolWithPolicy(actor, tool, { ...args, approvalId: blocked.decision.approvalId }, undefined, approvalAuthorizer, undefined, undefined, {
      approvalRequester,
    });
  }

  beforeAll(async () => {
    try {
    vi.spyOn(instanceDatabaseService, 'testConnection').mockImplementation(async () => {
      throw new Error('CONNECTION_PROBE_NOT_PART_OF_THIS_ACCEPTANCE');
    });
    admin = await mysql.createConnection(mysqlTestConfig());
    await createOwnedDatabase(admin, schema, ownedSchemas);
    pool = mysql.createPool({ ...mysqlTestConfig(), database: schema, connectionLimit: 8 });
    for (const statement of tableSql.split(';').map((part) => part.trim()).filter(Boolean)) {
      await pool.query(statement);
    }
    await pool.query(
      `INSERT INTO roles (id, name) VALUES (1, 'dba'), (2, 'operator'), (3, 'viewer')`,
    );
    await pool.query(
      `INSERT INTO permissions (id, code) VALUES (1, 'instance:create'), (2, 'instance:update'), (3, 'instance:*'), (4, 'instance:view')`,
    );
    await pool.query(
      `INSERT INTO users (id, username, status, password_hash, session_version) VALUES
       (21, 'max377-writer', 'active', NULL, 1),
       (22, 'max377-limited', 'active', NULL, 1),
       (23, 'max377-noscope', 'active', NULL, 1),
       (24, 'max377-noperm', 'active', NULL, 1)`,
    );
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES (21, 1), (22, 2), (23, 2), (24, 3)`,
    );
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES
       (1, 1), (1, 2), (1, 3),
       (2, 1), (2, 2),
       (3, 4)`,
    );
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as unknown as ReturnType<typeof dbConnection.getPool>);
    addTool = (await getPlatformTool('slide_add_database'))!;
    updateTool = (await getPlatformTool('slide_update_db_config'))!;
    writer = await login(21);
    limited = await login(22);
    noscope = await login(23);
    noperm = await login(24);
    } catch (error) {
      initError = error;
      throw error;
    }
  }, 60_000);

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      vi.restoreAllMocks();
    } catch (error) {
      cleanupError = error;
    }
    if (pool) {
      try {
        await pool.end();
      } catch (error) {
        cleanupError = cleanupError ?? error;
      }
    }
    if (admin) {
      try {
        await dropOwnedDatabases(admin, ownedSchemas);
      } catch (error) {
        cleanupError = cleanupError ?? error;
      }
      try {
        await admin.end();
      } catch (error) {
        cleanupError = cleanupError ?? error;
      }
    }
    if (!cleanupReplacesInit(initError, cleanupError)) {
      if (cleanupError) console.error(JSON.stringify({ phase: 'cleanup', separatedFrom: 'init' }));
      return;
    }
    throw cleanupError;
  });

  it('creates the same trimmed name in two environments and rejects the same environment', async () => {
    const dev = await run(addTool, writer, {
      db_type: 'mysql', name: '  orders  ', host: '192.0.2.40', port: 3306, username: 'slide', database_name: 'app-a', description: 'dev-row',
    });
    expect(dev.result).toMatchObject({ success: true, data: { name: 'orders' } });
    expect(dev.decision.reasonCode).toBe('ALLOW');
    const prod = await run(addTool, writer, {
      db_type: 'mysql', name: 'orders', host: '192.0.2.41', port: 3306, username: 'slide', database_name: 'app-b', environment: 'production', description: hiddenMarker,
    });
    expect(prod.result).toMatchObject({ success: true, data: { name: 'orders' } });
    const duplicate = await run(addTool, writer, {
      db_type: 'mysql', name: 'orders', host: '192.0.2.42', port: 3306, username: 'slide', database_name: 'app-c',
    });
    expect(duplicate.result).toMatchObject({
      success: false,
      errorCode: 'INSTANCE_EXISTS',
      data: { instanceId: Number((await instances())[0].id) },
    });
    expect(duplicate.result.artifacts).toMatchObject({ instanceId: Number((await instances())[0].id) });
    expect(duplicate.result.next_actions?.join(' ')).toContain(`复用已有实例 ID ${(await instances())[0].id}`);
    const blank = await run(addTool, writer, {
      db_type: 'mysql', name: '   ', host: '192.0.2.43', port: 3306, username: 'slide', database_name: 'app-d',
    });
    expect(blank.result).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    const rows = await instances();
    expect(rows.map((row) => [row.name, row.environment, row.host, row.database_name])).toEqual([
      ['orders', 'development', '192.0.2.40', 'app-a'],
      ['orders', 'production', '192.0.2.41', 'app-b'],
    ]);
    expect(rows[0].description).toBe('dev-row');
    expect(rows[1].description).toBe(hiddenMarker);
  });

  it('still rejects a second name for the same physical target', async () => {
    const before = await instances();
    const conflict = await run(addTool, writer, {
      db_type: 'mysql', name: 'orders-other', host: '192.0.2.40', port: 3306, username: 'slide', database_name: 'app-a', environment: 'staging',
    });
    expect(conflict.result).toMatchObject({ success: false, errorCode: 'INSTANCE_EXISTS' });
    expect(await instances()).toEqual(before);
  });

  it('rejects an ambiguous name without changing either environment', async () => {
    const before = await instances();
    const result = await run(updateTool, writer, { instance_name: ' orders ', environment: 'production', description: 'should-not-write' });
    expect(result.decision.reasonCode).toBe('AMBIGUOUS_INSTANCE_NAME');
    expect(result.decision.resource.instanceId).toBeUndefined();
    expect(result.result).toMatchObject({ success: false, errorCode: 'AMBIGUOUS_INSTANCE_NAME' });
    expect(result.result.error).toContain('实例 ID');
    expect(JSON.stringify(result.result)).not.toContain(hiddenMarker);
    expect(JSON.stringify(result.decision.resource)).not.toContain(hiddenMarker);
    expect(await instances()).toEqual(before);
    const [audits] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT reason_code, allowed, result_redacted FROM agent_tool_audit
       WHERE tool_name = 'slide_update_db_config' AND reason_code = 'AMBIGUOUS_INSTANCE_NAME'`,
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(hiddenMarker);
  });

  it('updates only the instance selected by id', async () => {
    const rows = await instances();
    const target = rows.find((row) => row.environment === 'development');
    const other = rows.find((row) => row.environment === 'production');
    expect(target?.id).toBeTruthy();
    const updated = await run(updateTool, writer, { instance_id: Number(target!.id), description: 'id-updated' });
    expect(updated.result).toMatchObject({ success: true, data: { instanceId: Number(target!.id) } });
    const after = await instances();
    expect(after.find((row) => row.id === target!.id)?.description).toBe('id-updated');
    expect(after.find((row) => row.id === other!.id)?.description).toBe(hiddenMarker);
  });

  it('updates a unique padded name and leaves the other environment unchanged', async () => {
    const created = await run(addTool, writer, {
      db_type: 'mysql', name: '  ledger  ', host: '192.0.2.50', port: 3306, username: 'slide', database_name: 'ledger', environment: 'staging',
    });
    expect(created.result).toMatchObject({ success: true, data: { name: 'ledger' } });
    const before = await instances();
    const updated = await run(updateTool, writer, { instance_name: ' ledger ', description: 'ledger-updated' });
    expect(updated.result).toMatchObject({ success: true });
    const after = await instances();
    expect(after.find((row) => row.name === 'ledger')?.description).toBe('ledger-updated');
    expect(after.find((row) => row.environment === 'production')?.description).toBe(hiddenMarker);
    expect(after.find((row) => row.environment === 'development')?.description).toBe(before.find((row) => row.environment === 'development')?.description);
  });

  it('does not reveal or modify an environment the caller cannot write', async () => {
    const rows = await instances();
    const visible = rows.find((row) => row.environment === 'development');
    await pool.query(
      `INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (22, ?, 'read-write')`,
      [visible!.id],
    );
    limited = await login(22);
    const before = await instances();
    const hidden = await run(updateTool, limited, { instance_name: 'orders', description: 'limited-write' });
    expect(hidden.decision.reasonCode).toBe('RESOURCE_NOT_FOUND');
    expect(hidden.decision.resource.instanceId).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toContain(hiddenMarker);
    expect(JSON.stringify(hidden)).not.toContain('production');
    const denied = await run(updateTool, noscope, { instance_id: Number(visible!.id), description: 'noscope' });
    expect(denied.decision.reasonCode).toBe('INSTANCE_SCOPE_DENIED');
    const missingPermission = await run(updateTool, noperm, { instance_id: Number(visible!.id), description: 'noperm' });
    expect(missingPermission.decision.reasonCode).toBe('MISSING_PERMISSION');
    expect(await instances()).toEqual(before);
  });

  function packedDenial(value: unknown): string {
    return JSON.stringify(value);
  }

  function disclosesInstance(packed: string, id: number): boolean {
    return [`"instanceId":${id}`, `"instanceId": ${id}`, `(ID: ${id})`, `ID ${id},`, `ID ${id}，`].some((token) => packed.includes(token));
  }

  it('keeps a preexisting database when create fails or the receipt is unknown', async () => {
    const preexisting = `max377_pre_${suffix}`;
    const created = `max377_owned_${suffix}`;
    const probeOwned = new Set<string>();
    let preexistingCreated = false;
    try {
      await admin.query(`CREATE DATABASE \`${preexisting}\``);
      preexistingCreated = true;
      await admin.query(`CREATE TABLE \`${preexisting}\`.marker (id INT PRIMARY KEY)`);
      await admin.query(`INSERT INTO \`${preexisting}\`.marker VALUES (1)`);
      await expect(createOwnedDatabase(admin, preexisting, probeOwned)).rejects.toThrow(/database exists/);
      expect(probeOwned.has(preexisting)).toBe(false);
      await expect(createOwnedDatabase({
        async query() {
          return { unexpected: true };
        },
      }, created, probeOwned)).rejects.toThrow(/CREATE_DATABASE_RECEIPT_UNKNOWN/);
      expect(probeOwned.has(created)).toBe(false);
      await dropOwnedDatabases(admin, probeOwned);
      const [kept] = await admin.query<mysql.RowDataPacket[]>(`SELECT id FROM \`${preexisting}\`.marker`);
      expect(kept).toEqual([{ id: 1 }]);

      await createOwnedDatabase(admin, created, probeOwned);
      await dropOwnedDatabases(admin, probeOwned);
      const [gone] = await admin.query<mysql.RowDataPacket[]>(
        'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
        [created],
      );
      expect(gone).toHaveLength(0);
      const [still] = await admin.query<mysql.RowDataPacket[]>(`SELECT id FROM \`${preexisting}\`.marker`);
      expect(still).toEqual([{ id: 1 }]);
    } finally {
      if (probeOwned.has(created)) await admin.query(`DROP DATABASE \`${created}\``);
      if (preexistingCreated) await admin.query(`DROP DATABASE \`${preexisting}\``);
    }
  });

  it('does not disclose a hidden same-environment instance through the production tool entry', async () => {
    const rows = await instances();
    const hidden = rows.find((row) => row.name === 'orders' && row.environment === 'development');
    expect(hidden?.id).toBeTruthy();
    const before = await instances();
    const denied = await run(addTool, noscope, {
      db_type: 'mysql', name: 'orders', host: '192.0.2.77', port: 3306, username: 'slide', database_name: 'app-hidden',
    });
    const packed = packedDenial(denied);
    expect(denied.decision.reasonCode).toBe('ALLOW');
    expect(denied.result).toMatchObject({ success: false, errorCode: 'INSTANCE_CREATE_DENIED', error: '无法完成纳管' });
    expect(denied.result.data).toBeUndefined();
    expect(denied.result.artifacts).toEqual({});
    expect(denied.result.details).not.toHaveProperty('instanceId');
    expect(denied.result.next_actions?.join(' ')).not.toContain(`ID ${hidden!.id}`);
    expect(disclosesInstance(packed, Number(hidden!.id))).toBe(false);
    expect(packed).not.toContain('已存在');
    expect(packed).not.toContain('INSTANCE_EXISTS');
    expect(await instances()).toEqual(before);
    const [audits] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT result_redacted, resource_json, reason_code FROM agent_tool_audit
       WHERE tool_name = 'slide_add_database' AND actor_id = 23 AND reason_code = 'ALLOW'
       ORDER BY id DESC LIMIT 2`,
    );
    expect(audits.length).toBeGreaterThan(0);
    const auditText = JSON.stringify(audits);
    expect(disclosesInstance(auditText, Number(hidden!.id))).toBe(false);
    expect(auditText).not.toContain('已存在');
    expect(auditText).not.toContain('hidden-orders');
  });

  it('rejects a hidden physical occupant without disclosing it and still creates another environment', async () => {
    const rows = await instances();
    const hidden = rows.find((row) => row.environment === 'development' && row.name === 'orders');
    const before = rows.length;
    const physical = await run(addTool, noscope, {
      db_type: 'mysql', name: 'orders-shadow', host: '192.0.2.40', port: 3306, username: 'slide', database_name: 'app-a',
    });
    const packed = packedDenial(physical);
    expect(physical.result.errorCode).toBe('INSTANCE_CREATE_DENIED');
    expect(disclosesInstance(packed, Number(hidden!.id))).toBe(false);
    expect(packed).not.toContain('id-updated');
    expect(packed).not.toContain('已被实例');
    expect((await instances()).length).toBe(before);
    const staged = await run(addTool, noscope, {
      db_type: 'mysql', name: 'orders', host: '192.0.2.78', port: 3306, username: 'slide', database_name: 'app-stage', environment: 'staging',
    });
    expect(staged.result).toMatchObject({ success: true, data: { name: 'orders' } });
    const after = await instances();
    expect(after.some((row) => row.environment === 'staging' && row.host === '192.0.2.78')).toBe(true);
    expect(after.find((row) => row.id === hidden!.id)?.description).toBe('id-updated');
  });

  it('does not select a tombstone or the wrong environment when the candidate set changes', async () => {
    const marker = `tomb-${suffix}`;
    await pool.query(
      `INSERT INTO database_instances
        (name, environment, db_type, host, port, username, password_encrypted, database_name, lifecycle_state, description)
       VALUES (?, 'staging', 'mysql', '192.0.2.60', 3306, 'slide', '', 'app-tomb', 'deleted', 'tomb-secret')`,
      [marker],
    );
    const deleted = (await instances()).find((row) => row.name === marker);
    const recreated = await run(addTool, writer, {
      db_type: 'mysql', name: `${marker}-live`, host: '192.0.2.60', port: 3306, username: 'slide', database_name: 'app-tomb', environment: 'staging',
    });
    expect(recreated.result).toMatchObject({ success: true });
    const sameName = await run(addTool, noscope, {
      db_type: 'mysql', name: marker, host: '192.0.2.62', port: 3306, username: 'slide', database_name: 'app-tomb-2', environment: 'staging',
    });
    expect(sameName.result.errorCode).toBe('CREATE_INSTANCE_FAILED');
    expect(disclosesInstance(packedDenial(sameName), Number(deleted!.id))).toBe(false);
    expect(packedDenial(sameName)).not.toContain('tomb-secret');
    expect((await instances()).filter((row) => row.name === marker)).toHaveLength(1);
    const named = await run(updateTool, writer, { instance_name: marker, description: 'should-not-touch-tomb' });
    expect(named.decision.reasonCode).toBe('RESOURCE_NOT_FOUND');
    expect((await instances()).find((row) => row.id === deleted!.id)?.description).toBe('tomb-secret');

    await pool.query(
      `INSERT INTO database_instances
        (name, environment, db_type, host, port, username, password_encrypted, database_name, lifecycle_state)
       VALUES ('orders', 'testing', 'mysql', '192.0.2.63', 3306, 'slide', '', 'app-del', 'deleting')`,
    );
    const deleting = (await instances()).find((row) => row.database_name === 'app-del');
    const blocked = await run(addTool, noscope, {
      db_type: 'mysql', name: 'orders-deleting', host: '192.0.2.63', port: 3306, username: 'slide', database_name: 'app-del',
    });
    expect(blocked.result.errorCode).not.toBe('INSTANCE_EXISTS');
    expect(disclosesInstance(packedDenial(blocked), Number(deleting!.id))).toBe(false);
    expect((await instances()).find((row) => row.id === deleting!.id)?.database_name).toBe('app-del');

    const original = instanceDatabaseService.listAvailableInstancesByNormalizedName.bind(instanceDatabaseService);
    let resolutionCalls = 0;
    const spy = vi.spyOn(instanceDatabaseService, 'listAvailableInstancesByNormalizedName').mockImplementation(async (name) => {
      const rows = await original(name);
      if (name.trim() !== 'orders') return rows;
      resolutionCalls += 1;
      const dev = rows.filter((row) => row.environment === 'development');
      const prod = rows.filter((row) => row.environment === 'production');
      if (resolutionCalls <= 2) return dev;
      return resolutionCalls === 3 ? prod : rows;
    });
    const beforeOrders = await instances();
    try {
      const shifted = await run(updateTool, writer, { instance_name: ' orders ', description: 'wrong-environment' });
      expect(shifted.result).toMatchObject({ success: false, errorCode: 'INSTANCE_NOT_FOUND' });
      expect(shifted.decision.resource.instanceId).toBe(beforeOrders.find((row) => row.environment === 'development')?.id);
      const afterOrders = await instances();
      expect(afterOrders.map((row) => [row.id, row.description])).toEqual(beforeOrders.map((row) => [row.id, row.description]));
    } finally {
      spy.mockRestore();
    }
  });
});
