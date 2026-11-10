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
    vi.spyOn(instanceDatabaseService, 'testConnection').mockImplementation(async () => {
      throw new Error('CONNECTION_PROBE_NOT_PART_OF_THIS_ACCEPTANCE');
    });
    admin = await mysql.createConnection(mysqlTestConfig());
    await admin.query(`CREATE DATABASE \`${schema}\``);
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
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
      await admin.end();
    }
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
    expect(duplicate.result).toMatchObject({ success: false, errorCode: 'INSTANCE_EXISTS' });
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
});
