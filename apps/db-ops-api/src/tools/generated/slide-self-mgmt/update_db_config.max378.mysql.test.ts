/**
 * MAX-378: persisted config stays saved when a later connection check throws.
 *
 * Opt-in only. Default collection does not read credentials. The runner injects
 * MAX378_MYSQL_ACCEPTANCE and connection settings. Cleanup drops only the schema
 * and account this run created.
 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../../auth/actor-context.js';
import { dbConnection, encryptData } from '../../../db-connection.js';
import { credentialReferenceService } from '../../../security/credential-reference-service.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';
import { executeToolWithPolicy, type ToolApprovalAuthorizer, type ToolAuditRecorder } from '../../policy.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../../../testing/owned-fixture.js';
import { updateDbConfigTool } from './update_db_config.js';

const acceptance = process.env.MAX378_MYSQL_ACCEPTANCE === '1';

interface Max378QueryRow { user?: string; host?: string }
interface Max378CleanupHandles {
  restoreMocks?: () => void;
  observer?: { end: () => Promise<void> } | null;
  pool?: { end: () => Promise<void> } | null;
  root?: {
    query: (sql: string, values?: unknown[]) => Promise<[Max378QueryRow[], unknown]>;
    end: () => Promise<void>;
  } | null;
  userCreated: boolean;
  loginUser: string;
  owned?: { drop: () => Promise<void> } | null;
}

/**
 * Each cleanup runs even when an earlier one throws. The root connection is
 * closed last. A prior test or setup error stays first and is not replaced.
 */
export async function releaseMax378Acceptance(
  handles: Max378CleanupHandles,
  priorError?: unknown,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  const steps: Array<() => Promise<void>> = [
    async () => { handles.restoreMocks?.(); },
    async () => { await handles.observer?.end(); },
    async () => { await handles.pool?.end(); },
    async () => { await dropOwnedMysqlUser(handles); },
    async () => { await handles.owned?.drop(); },
    async () => { await handles.root?.end(); },
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 0) {
    if (priorError !== undefined) throw priorError;
    return;
  }
  const retained = priorError === undefined ? cleanupErrors : [priorError, ...cleanupErrors];
  const failure = new AggregateError(
    retained,
    priorError === undefined
      ? 'MAX-378 cleanup failed'
      : 'MAX-378 cleanup failed; the first error is retained',
  );
  if (priorError !== undefined) failure.cause = priorError;
  throw failure;
}

async function dropOwnedMysqlUser(handles: Max378CleanupHandles): Promise<void> {
  if (!handles.userCreated) return;
  if (!handles.root) throw new Error('refusing to drop a MySQL account without the connection that created it');
  const [accounts] = await handles.root.query(
    'SELECT user, host FROM mysql.user WHERE user = ?',
    [handles.loginUser],
  );
  if (accounts.length !== 1 || accounts[0]?.host !== '%' || !/^m378_[a-z0-9]+$/.test(handles.loginUser)) {
    throw new Error('refusing to drop a MySQL account this run does not uniquely own');
  }
  await handles.root.query(`DROP USER '${handles.loginUser}'@'%'`);
}

describe.skipIf(!acceptance)('MAX-378 saved config versus later connection checks', () => {
  let root: mysql.Connection;
  let pool: Pool;
  let observer: mysql.Connection;
  let owned: OwnedDatabase;
  let userCreated = false;
  let loginUser = '';
  let secret = '';
  let targetHost = '';
  let targetPort = 0;
  let instanceUpdates = 0;
  const nonce = generateRunNonce();
  const handleDir = join(process.cwd(), '.max378-handles');

  const readRow = async (id: number) => {
    const [rows] = await observer.query<RowDataPacket[]>(
      'SELECT id, name, environment, host, port, username, description, lifecycle_state FROM database_instances WHERE id = ?',
      [id],
    );
    return rows[0];
  };

  const actorFor = (scopes: Record<number, 'read-write'>, permissions: string[] = ['instance:update']): ActorContext => ({
    userId: 7,
    username: 'operator',
    roles: ['dba'],
    permissions,
    sessionVersion: 1,
    instanceScopes: scopes,
    requestId: `max378-${randomBytes(4).toString('hex')}`,
  });

  const run = async (args: Record<string, unknown>, actor: ActorContext) => {
    const audits: unknown[] = [];
    const approval: ToolApprovalAuthorizer = {
      async consume() {
        throw new Error('approval stand-in must stay unused while approval is disabled');
      },
    };
    const audit: ToolAuditRecorder = {
      async record(record) { audits.push(JSON.parse(JSON.stringify(record))); },
    };
    const executed = await executeToolWithPolicy(actor, updateDbConfigTool, args, undefined, approval, audit);
    return { ...executed, audits };
  };

  beforeAll(async () => {
    const host = process.env.MAX378_MYSQL_HOST;
    const port = Number(process.env.MAX378_MYSQL_PORT);
    const user = process.env.MAX378_MYSQL_USER;
    const password = process.env.MAX378_MYSQL_PASSWORD;
    targetHost = process.env.MAX378_TARGET_HOST ?? '';
    if (!host || !Number.isSafeInteger(port) || port === 3306 || !user || !password || !isIP(targetHost)) {
      throw new Error('MAX378 acceptance requires an explicit non-3306 MySQL and a target host');
    }
    if (targetHost.startsWith('127.') || targetHost === '0.0.0.0' || targetHost === '::1') {
      throw new Error('connection target must not be loopback; production policy denies it');
    }
    secret = randomBytes(18).toString('hex');
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    root = await mysql.createConnection({ host, port, user, password });
    const [sessions] = await root.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS total, SUM(command <> 'Sleep') AS active FROM information_schema.processlist",
    );
    targetPort = port;
    console.log(`mysql acceptance sessions=${Number(sessions[0]?.total ?? 0)} active=${Number(sessions[0]?.active ?? 0)} port=${port}`);
    owned = await createOwnedDatabase(root, { nonce, purpose: 'max378', handleDir });
    loginUser = `m378_${nonce}`;
    await root.query("CREATE USER ?@'%' IDENTIFIED BY ?", [loginUser, secret]);
    userCreated = true;
    await root.query(`GRANT ALL PRIVILEGES ON \`${owned.database}\`.* TO ?@'%'`, [loginUser]);
    pool = mysql.createPool({ host, port, user, password, database: owned.database, connectionLimit: 4 });
    observer = await mysql.createConnection({ host, port, user, password, database: owned.database });
    await pool.query(`
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
        db_version VARCHAR(50) DEFAULT NULL,
        data_size_gb DECIMAL(10,2) DEFAULT NULL,
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query(`
      CREATE TABLE agent_credential_references (
        ref_id CHAR(36) NOT NULL,
        owner_id INT UNSIGNED NOT NULL,
        tool_name VARCHAR(128) NOT NULL,
        secret_encrypted TEXT NOT NULL,
        status ENUM('active','consumed','expired','revoked') NOT NULL DEFAULT 'active',
        expires_at DATETIME NOT NULL,
        consumed_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ref_id)
      )
    `);
    await pool.query(`
      CREATE TABLE system_config (
        config_key VARCHAR(128) NOT NULL PRIMARY KEY,
        config_value TEXT
      )
    `);
    await pool.query(
      'INSERT INTO system_config (config_key, config_value) VALUES (?, ?), (?, ?)',
      ['agent_tool_approval_enabled', 'false', 'agent_sandbox_network_enabled', 'false'],
    );
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as unknown as ReturnType<typeof dbConnection.getPool>);
    const execute = pool.execute.bind(pool);
    vi.spyOn(pool, 'execute').mockImplementation(async (sql: never, values?: never) => {
      if (typeof sql === 'string' && /UPDATE\s+database_instances\b/i.test(sql)) instanceUpdates += 1;
      return execute(sql, values);
    });
    const getConnection = pool.getConnection.bind(pool);
    vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
      const connection = await getConnection();
      const connectionExecute = connection.execute.bind(connection);
      connection.execute = (async (sql: string, values?: never) => {
        if (typeof sql === 'string' && /UPDATE\s+database_instances\b/i.test(sql)) instanceUpdates += 1;
        return connectionExecute(sql, values);
      }) as typeof connection.execute;
      return connection;
    });
  }, 60000);

  afterAll(async () => {
    await releaseMax378Acceptance({
      restoreMocks: () => { vi.restoreAllMocks(); },
      observer,
      pool,
      root,
      userCreated,
      loginUser,
      owned,
    });
  }, 60000);

  const previousPort = () => (targetPort === 33061 ? 33062 : 33061);

  const insert = async (values: Record<string, unknown>) => {
    const [result] = await pool.query(
      `INSERT INTO database_instances
        (name, environment, db_type, host, port, username, password_encrypted, database_name, status, lifecycle_state, description)
       VALUES (?, ?, 'mysql', ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        values.name, values.environment ?? 'development', values.host, values.port, values.username,
        values.passwordEncrypted, values.databaseName ?? null, values.lifecycle ?? 'available', values.description ?? 'before',
      ],
    );
    return Number((result as { insertId: number }).insertId);
  };

  it('shows a committed description on another connection and does not test the connection', async () => {
    const id = await insert({
      name: `note-${nonce}`, environment: 'development', host: '10.8.0.1', port: 16001,
      username: 'unused', passwordEncrypted: encryptData(secret), databaseName: `note-${nonce}`, description: 'before',
    });
    const before = instanceUpdates;
    const { result, audits } = await run({ instance_id: id, description: `saved-${nonce}` }, actorFor({ [id]: 'read-write' }));
    expect(result).toMatchObject({ success: true, status: 'success', data: { connectionTested: false, instanceId: id } });
    expect(instanceUpdates - before).toBe(1);
    expect((await readRow(id)).description).toBe(`saved-${nonce}`);
    const packed = JSON.stringify(audits);
    expect(packed).not.toContain(secret);
    expect(packed).not.toContain('UPDATE_CONFIG_FAILED');
  });

  it('reports the save and a separate warning when decrypt throws, and writes once', async () => {
    const oldPort = previousPort();
    const marker = `decrypt-${nonce}`;
    const id = await insert({
      name: `decrypt-${nonce}`, environment: 'development', host: targetHost, port: oldPort,
      username: loginUser, passwordEncrypted: encryptData(secret), databaseName: `decrypt-${nonce}`,
      description: `before-${nonce}`,
    });
    const real = instanceDatabaseService.getInstanceWithDecryptedPassword.bind(instanceDatabaseService);
    const spy = vi.spyOn(instanceDatabaseService, 'getInstanceWithDecryptedPassword').mockImplementation(async (instanceId) => {
      if (instanceId === id) throw new Error(`decrypt ${secret}`);
      return real(instanceId);
    });
    const before = instanceUpdates;
    try {
      const { result, audits } = await run(
        { instance_id: id, port: targetPort, description: marker },
        actorFor({ [id]: 'read-write' }),
      );
      expect(result).toMatchObject({
        success: true,
        status: 'warning',
        data: { configSaved: true, connectionTested: false, verification: { stage: 'decrypt' } },
        details: { retryable: false, credentialConsumed: false },
      });
      expect(result.error).toBeUndefined();
      expect(result.errorCode).toBeUndefined();
      expect(String((result.data as { warning?: string }).warning)).toContain('已保存');
      expect(result.next_actions?.join('\n')).toContain('不要再次提交');
      expect(instanceUpdates - before).toBe(1);
      const committed = await readRow(id);
      expect(Number(committed.port)).toBe(targetPort);
      expect(Number(committed.port)).not.toBe(oldPort);
      expect(committed.description).toBe(marker);
      const packed = JSON.stringify({ result, audits });
      expect(packed).not.toContain(secret);
      expect(packed).not.toContain('UPDATE_CONFIG_FAILED');
      expect(packed).not.toMatch(/重试|重新提交/);
    } finally {
      spy.mockRestore();
    }
  });

  it('reports the save and a separate warning when the connection check throws, and writes once', async () => {
    const oldUser = `stale_${nonce}`;
    const marker = `connect-${nonce}`;
    const id = await insert({
      name: `connect-${nonce}`, environment: 'development', host: targetHost, port: targetPort,
      username: oldUser, passwordEncrypted: encryptData(secret), databaseName: `connect-${nonce}`,
      description: `before-${nonce}`,
    });
    const spy = vi.spyOn(instanceDatabaseService, 'testConnection').mockImplementation(async () => {
      throw new Error(`connect ${secret}`);
    });
    const before = instanceUpdates;
    try {
      const { result, audits } = await run(
        { instance_id: id, username: loginUser, description: marker },
        actorFor({ [id]: 'read-write' }),
      );
      expect(result).toMatchObject({
        success: true,
        status: 'warning',
        data: { configSaved: true, connectionTested: true, connectionSuccess: false, verification: { stage: 'connect' } },
      });
      expect(result.error).toBeUndefined();
      expect(result.errorCode).toBeUndefined();
      expect(String((result.data as { warning?: string }).warning)).toContain('已保存');
      expect(instanceUpdates - before).toBe(1);
      const committed = await readRow(id);
      expect(committed.username).toBe(loginUser);
      expect(committed.username).not.toBe(oldUser);
      expect(committed.description).toBe(marker);
      expect(JSON.stringify({ result, audits })).not.toContain(secret);
    } finally {
      spy.mockRestore();
    }
  });

  it('connects successfully after a real connection-field update', async () => {
    const id = await insert({
      name: `live-${nonce}`, environment: 'development', host: targetHost, port: previousPort(),
      username: loginUser, passwordEncrypted: encryptData(secret), databaseName: owned.database,
    });
    const before = instanceUpdates;
    const { result } = await run({ instance_id: id, port: targetPort }, actorFor({ [id]: 'read-write' }));
    expect(result).toMatchObject({
      success: true,
      status: 'success',
      data: { connectionTested: true, connectionSuccess: true, instanceId: id },
    });
    expect(instanceUpdates - before).toBe(1);
    expect(Number((await readRow(id)).port)).toBe(targetPort);
    expect(Number((await readRow(id)).port)).not.toBe(previousPort());
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('keeps a real unique-name failure failed and does not write a second time', async () => {
    const first = await insert({
      name: `taken-${nonce}`, environment: 'development', host: '10.1.2.3', port: 14001,
      username: 'unused', passwordEncrypted: encryptData('not-used'), databaseName: `a-${nonce}`,
    });
    const second = await insert({
      name: `free-${nonce}`, environment: 'development', host: '10.1.2.4', port: 14002,
      username: 'unused', passwordEncrypted: encryptData('not-used'), databaseName: `b-${nonce}`,
    });
    const before = instanceUpdates;
    const { result } = await run({ instance_id: second, name: `taken-${nonce}` }, actorFor({ [first]: 'read-write', [second]: 'read-write' }));
    expect(result).toMatchObject({ success: false, errorCode: 'UPDATE_FAILED', details: { retryable: false } });
    expect(instanceUpdates - before).toBe(0);
    expect((await readRow(second)).name).toBe(`free-${nonce}`);
    expect(JSON.stringify(result)).not.toContain('已保存');
    expect(JSON.stringify(result)).not.toContain('not-used');
  });

  it('does not replay an update whose client acknowledgement was lost', async () => {
    const id = await insert({
      name: `unknown-${nonce}`, environment: 'development', host: '10.1.2.5', port: 14003,
      username: 'unused', passwordEncrypted: encryptData(secret), databaseName: `c-${nonce}`, description: 'before',
    });
    const real = instanceDatabaseService.updateInstance.bind(instanceDatabaseService);
    const spy = vi.spyOn(instanceDatabaseService, 'updateInstance').mockImplementationOnce(async (instanceId, data) => {
      const written = await real(instanceId, data);
      if (!written.success) return written;
      throw new Error(`ack ${secret}`);
    });
    try {
      const { result, audits } = await run({ instance_id: id, description: `held-${nonce}` }, actorFor({ [id]: 'read-write' }));
      expect(result).toMatchObject({ success: false, errorCode: 'UPDATE_OUTCOME_UNKNOWN', details: { retryable: false } });
      expect(result.next_actions?.join('\n')).toContain('不要重放');
      expect(result.next_actions?.join('\n')).not.toMatch(/重试|重新提交/);
      expect((await readRow(id)).description).toBe(`held-${nonce}`);
      expect(JSON.stringify({ result, audits })).not.toContain(secret);
    } finally {
      spy.mockRestore();
    }
  });

  it('consumes a credential once and does not write again when the later connection check throws', async () => {
    const id = await insert({
      name: `cred-${nonce}`, environment: 'development', host: targetHost, port: targetPort,
      username: loginUser, passwordEncrypted: encryptData('old-secret'), databaseName: `cred-${nonce}`, description: 'before',
    });
    const issued = await credentialReferenceService.create(7, updateDbConfigTool.name, secret);
    const spy = vi.spyOn(instanceDatabaseService, 'testConnection').mockRejectedValue(new Error(`connect ${secret}`));
    const before = instanceUpdates;
    try {
      const first = await run(
        { instance_id: id, credential_ref: issued.ref, description: `cred-saved-${nonce}` },
        actorFor({ [id]: 'read-write' }),
      );
      expect(first.result).toMatchObject({
        success: true,
        status: 'warning',
        data: { configSaved: true, verification: { stage: 'connect' } },
        details: { credentialConsumed: true, retryable: false },
      });
      expect(instanceUpdates - before).toBe(1);
      expect((await readRow(id)).description).toBe(`cred-saved-${nonce}`);
      const [refs] = await observer.query<RowDataPacket[]>(
        'SELECT status FROM agent_credential_references WHERE ref_id = ?',
        [issued.ref],
      );
      expect(refs[0]?.status).toBe('consumed');
      const second = await run(
        { instance_id: id, credential_ref: issued.ref, description: `should-not-${nonce}` },
        actorFor({ [id]: 'read-write' }),
      );
      expect(second.result).toMatchObject({ success: false, errorCode: 'INVALID_CREDENTIAL_REF' });
      expect(instanceUpdates - before).toBe(1);
      expect((await readRow(id)).description).toBe(`cred-saved-${nonce}`);
      expect(JSON.stringify({ first: first.result, second: second.result, audits: [...first.audits, ...second.audits] })).not.toContain(secret);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps ambiguous names, hidden matches, explicit ids, and tombstones on the production entry', async () => {
    const visible = await insert({
      name: `orders-${nonce}`, environment: 'development', host: '10.9.1.1', port: 15001,
      username: 'unused', passwordEncrypted: encryptData('hidden'), databaseName: `d-${nonce}`,
    });
    const hidden = await insert({
      name: `orders-${nonce}`, environment: 'staging', host: '10.9.1.2', port: 15002,
      username: 'unused', passwordEncrypted: encryptData('hidden'), databaseName: `e-${nonce}`,
    });
    await insert({
      name: `orders-${nonce}`, environment: 'production', host: '10.9.1.3', port: 15003,
      username: 'unused', passwordEncrypted: encryptData('hidden'), databaseName: `f-${nonce}`,
      lifecycle: 'deleted', description: 'tombstone',
    });
    const both = actorFor({ [visible]: 'read-write', [hidden]: 'read-write' });
    const ambiguous = await run({ instance_name: `  orders-${nonce}  `, description: 'nope' }, both);
    expect(ambiguous.result).toMatchObject({ success: false, errorCode: 'AMBIGUOUS_INSTANCE_NAME' });
    expect((await readRow(visible)).description).toBe('before');
    expect((await readRow(hidden)).description).toBe('before');

    const limited = actorFor({ [visible]: 'read-write' });
    const concealed = await run({ instance_name: `orders-${nonce}`, description: 'nope' }, limited);
    expect(concealed.result.errorCode).not.toBe('AMBIGUOUS_INSTANCE_NAME');
    expect(concealed.result.success).toBe(false);
    expect(JSON.stringify(concealed.result)).not.toContain('staging');
    expect(JSON.stringify(concealed.result)).not.toContain(String(hidden));
    expect((await readRow(visible)).description).toBe('before');

    const denied = await run({ instance_id: visible, description: 'nope' }, actorFor({}, ['config:view']));
    expect(denied.result).toMatchObject({ success: false, errorCode: 'MISSING_PERMISSION' });
    expect((await readRow(visible)).description).toBe('before');

    const direct = await run({ instance_id: visible, description: `id-saved-${nonce}` }, limited);
    expect(direct.result).toMatchObject({ success: true, data: { instanceId: visible, connectionTested: false } });
    expect((await readRow(visible)).description).toBe(`id-saved-${nonce}`);

    const only = await insert({
      name: `solo-${nonce}`, environment: 'development', host: '10.9.1.4', port: 15004,
      username: 'unused', passwordEncrypted: encryptData('hidden'), databaseName: `g-${nonce}`,
    });
    await insert({
      name: `solo-${nonce}`, environment: 'staging', host: '10.9.1.5', port: 15005,
      username: 'unused', passwordEncrypted: encryptData('hidden'), databaseName: `h-${nonce}`,
      lifecycle: 'deleted',
    });
    const named = await run({ instance_name: ` solo-${nonce} `, description: `named-${nonce}` }, actorFor({ [only]: 'read-write' }));
    expect(named.result).toMatchObject({ success: true, data: { instanceId: only } });
    expect((await readRow(only)).description).toBe(`named-${nonce}`);
  });
});

const OWNED_LOGIN = 'm378_abcdef01';

function cleanupHarness(failAt: string[] = []) {
  const calls: string[] = [];
  const fail = new Set(failAt);
  const step = async (name: string) => {
    calls.push(name);
    if (fail.has(name)) throw new Error(`injected ${name}`);
  };
  const handles: Max378CleanupHandles = {
    restoreMocks: () => { calls.push('restore-mocks'); if (fail.has('restore-mocks')) throw new Error('injected restore-mocks'); },
    observer: { end: () => step('observer.end') },
    pool: { end: () => step('pool.end') },
    root: {
      query: async (sql: string) => {
        if (sql.includes('DROP USER')) {
          await step('dropUser');
          return [[], undefined];
        }
        calls.push('select-user');
        return [[{ user: OWNED_LOGIN, host: '%' }], undefined];
      },
      end: () => step('root.end'),
    },
    userCreated: true,
    loginUser: OWNED_LOGIN,
    owned: { drop: () => step('owned.drop') },
  };
  return { calls, handles };
}

describe('MAX-378 cleanup failure regression', () => {
  const laterSteps = ['observer.end', 'pool.end', 'dropUser', 'owned.drop', 'root.end'];

  it.each(['observer.end', 'pool.end', 'dropUser', 'owned.drop'])(
    'still closes the root connection when %s fails',
    async (failure) => {
      const { calls, handles } = cleanupHarness([failure]);
      await expect(releaseMax378Acceptance(handles)).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: `injected ${failure}` })],
      });
      const start = laterSteps.indexOf(failure);
      for (const name of laterSteps.slice(start)) expect(calls).toContain(name);
      expect(calls.at(-1)).toBe('root.end');
    },
  );

  it('keeps the ownership check and still finishes the remaining cleanup', async () => {
    const { calls, handles } = cleanupHarness();
    handles.root = {
      query: async (sql: string) => {
        calls.push(sql.includes('DROP USER') ? 'dropUser' : 'select-user');
        return [[{ user: OWNED_LOGIN, host: 'localhost' }], undefined];
      },
      end: async () => { calls.push('root.end'); },
    };
    const error = await releaseMax378Acceptance(handles).then(
      () => { throw new Error('cleanup resolved'); },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((item) => item instanceof Error ? item.message : String(item))).toEqual([
      'refusing to drop a MySQL account this run does not uniquely own',
    ]);
    expect(calls).not.toContain('dropUser');
    expect(calls).toContain('owned.drop');
    expect(calls.at(-1)).toBe('root.end');
  });

  it('retains the first error together with every later cleanup error', async () => {
    const prior = new Error('business failed');
    const failures = ['observer.end', 'pool.end', 'dropUser', 'owned.drop', 'root.end'];
    const { calls, handles } = cleanupHarness(failures);
    const error = await releaseMax378Acceptance(handles, prior).then(
      () => { throw new Error('cleanup resolved'); },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.cause).toBe(prior);
    expect(aggregate.errors.map((item) => item instanceof Error ? item.message : String(item))).toEqual([
      'business failed',
      ...failures.map((name) => `injected ${name}`),
    ]);
    expect(calls).toEqual(['restore-mocks', 'observer.end', 'pool.end', 'select-user', 'dropUser', 'owned.drop', 'root.end']);
  });

  it('rethrows the original error unchanged when cleanup itself succeeds', async () => {
    const prior = new Error('init failed');
    const { calls, handles } = cleanupHarness();
    await expect(releaseMax378Acceptance(handles, prior)).rejects.toBe(prior);
    expect(calls).toContain('dropUser');
    expect(calls.at(-1)).toBe('root.end');
  });
});
