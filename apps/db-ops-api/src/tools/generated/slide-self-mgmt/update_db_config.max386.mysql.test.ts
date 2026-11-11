/**
 * MAX-386: a null credential retrieval is not a failed connection test.
 *
 * Opt-in. Default collection reads no credentials and opens no database.
 * The runner injects MAX386_MYSQL_* and a non-loopback target. Persistence is
 * real mysql3308. Retrieval null, approval, JWT, and audit are stand-ins.
 * Cleanup drops only objects this run confirmed it created.
 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../../auth/actor-context.js';
import { dbConnection, encryptData } from '../../../db-connection.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';
import { executeToolWithPolicy, type ToolApprovalAuthorizer, type ToolAuditRecorder } from '../../policy.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../../../testing/owned-fixture.js';
import { updateDbConfigTool } from './update_db_config.js';

type MysqlEnv = Record<string, string | undefined>;

export function max386AcceptanceEnabled(env: MysqlEnv = process.env): boolean {
  return env.MAX386_MYSQL_ACCEPTANCE === '1';
}

const acceptance = max386AcceptanceEnabled();

interface AccountRow { user?: string; host?: string }
interface Max386CleanupHandles {
  restoreMocks?: () => void;
  observer?: { end: () => Promise<void> } | null;
  pool?: { end: () => Promise<void> } | null;
  releaseLock?: () => Promise<void>;
  root?: {
    query: (sql: string, values?: unknown[]) => Promise<[AccountRow[], unknown]>;
    end: () => Promise<void>;
  } | null;
  userCreated: boolean;
  loginUser: string;
  owned?: { drop: () => Promise<void> } | null;
}

/** Each step runs after an earlier failure. The root session closes last. */
export async function releaseMax386Acceptance(
  handles: Max386CleanupHandles,
  priorError?: unknown,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  const steps: Array<() => Promise<void>> = [
    async () => { handles.restoreMocks?.(); },
    async () => { await handles.observer?.end(); },
    async () => { await handles.pool?.end(); },
    async () => { await dropOwnedMysqlUser(handles); },
    async () => { await handles.owned?.drop(); },
    async () => { await handles.releaseLock?.(); },
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
      ? 'MAX-386 cleanup failed'
      : 'MAX-386 cleanup failed; the first error is retained',
  );
  if (priorError !== undefined) failure.cause = priorError;
  throw failure;
}

async function dropOwnedMysqlUser(handles: Max386CleanupHandles): Promise<void> {
  if (!handles.userCreated) return;
  if (!handles.root) throw new Error('refusing to drop a MySQL account without the connection that created it');
  const [accounts] = await handles.root.query(
    'SELECT user, host FROM mysql.user WHERE user = ?',
    [handles.loginUser],
  );
  if (accounts.length !== 1 || accounts[0]?.host !== '%' || !/^m386_[a-z0-9]+$/.test(handles.loginUser)) {
    throw new Error('refusing to drop a MySQL account this run does not uniquely own');
  }
  await handles.root.query(`DROP USER '${handles.loginUser}'@'%'`);
}

describe('MAX-386 acceptance stays opt-in', () => {
  it('does not enable a real database when the runner omits the flag', () => {
    expect(max386AcceptanceEnabled({})).toBe(false);
    expect(max386AcceptanceEnabled({ MAX386_MYSQL_ACCEPTANCE: '0', MAX386_MYSQL_PASSWORD: 'unused' })).toBe(false);
  });
});

describe.skipIf(!acceptance)('MAX-386 null retrieval on exclusive mysql3308', () => {
  let root: mysql.Connection | null = null;
  let pool: Pool | null = null;
  let observer: mysql.Connection | null = null;
  let owned: OwnedDatabase | null = null;
  let userCreated = false;
  let lockHeld = false;
  let loginUser = '';
  let secret = '';
  let targetHost = '';
  let targetPort = 0;
  let instanceUpdates = 0;
  const nonce = generateRunNonce();
  const handleDir = join(process.cwd(), '.max386-handles');

  const readRow = async (id: number) => {
    const [rows] = await observer!.query<RowDataPacket[]>(
      'SELECT id, host, port, username, description, database_name FROM database_instances WHERE id = ?',
      [id],
    );
    return rows[0];
  };

  const actorFor = (id: number): ActorContext => ({
    userId: 7,
    username: 'operator',
    roles: ['dba'],
    permissions: ['instance:update'],
    sessionVersion: 1,
    instanceScopes: { [id]: 'read-write' },
    requestId: `max386-${randomBytes(4).toString('hex')}`,
  });

  const run = async (args: Record<string, unknown>, actor: ActorContext) => {
    const audits: unknown[] = [];
    const approval: ToolApprovalAuthorizer = {
      async consume() {
        throw new Error('approval stand-in must stay unused');
      },
    };
    const audit: ToolAuditRecorder = {
      async record(record) { audits.push(JSON.parse(JSON.stringify(record))); },
    };
    const executed = await executeToolWithPolicy(actor, updateDbConfigTool, args, undefined, approval, audit);
    return { ...executed, audits };
  };

  const insert = async (values: Record<string, unknown>) => {
    const [result] = await pool!.query(
      `INSERT INTO database_instances
        (name, environment, db_type, host, port, username, password_encrypted, database_name, status, lifecycle_state, description)
       VALUES (?, 'development', 'mysql', ?, ?, ?, ?, ?, 'active', 'available', ?)`,
      [values.name, values.host, values.port, values.username, values.passwordEncrypted, values.databaseName, values.description ?? 'before'],
    );
    return Number((result as { insertId: number }).insertId);
  };

  beforeAll(async () => {
    const host = process.env.MAX386_MYSQL_HOST;
    const portText = process.env.MAX386_MYSQL_PORT;
    const port = Number(portText);
    const user = process.env.MAX386_MYSQL_USER;
    const password = process.env.MAX386_MYSQL_PASSWORD;
    targetHost = process.env.MAX386_TARGET_HOST ?? '';
    targetPort = Number(process.env.MAX386_TARGET_PORT);
    if (process.env.MAX386_MYSQL_CONTAINER !== 'mysql3308') {
      throw new Error('MAX386 acceptance requires MAX386_MYSQL_CONTAINER=mysql3308');
    }
    if (host !== '127.0.0.1' || portText !== '3308' || !user || password === undefined) {
      throw new Error('MAX386 acceptance requires 127.0.0.1:3308 and an injected user');
    }
    if (!isIP(targetHost) || targetHost.startsWith('127.') || targetHost === '0.0.0.0' || targetHost === '::1') {
      throw new Error('MAX386_TARGET_HOST must be a non-loopback address');
    }
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      throw new Error('MAX386_TARGET_PORT must be the reachable published port');
    }
    secret = randomBytes(18).toString('hex');
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    root = await mysql.createConnection({ host, port, user, password, multipleStatements: false });
    const [lockRows] = await root.query<RowDataPacket[]>(
      "SELECT GET_LOCK('slide_max386_mysql3308', 20) AS locked, @@port AS server_port, @@hostname AS hostname",
    );
    if (Number(lockRows[0]?.locked) !== 1) throw new Error('mysql3308 exclusive lock was not acquired');
    lockHeld = true;
    console.log(`max386 mysql3308 lock=1 client_port=${port} server_port=${lockRows[0]?.server_port} hostname=${lockRows[0]?.hostname}`);
    owned = await createOwnedDatabase(root, { nonce, purpose: 'max386', handleDir });
    loginUser = `m386_${nonce}`;
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
  }, 60_000);

  afterAll(async () => {
    await releaseMax386Acceptance({
      restoreMocks: () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); },
      observer,
      pool,
      releaseLock: async () => {
        if (!lockHeld || !root) return;
        await root.query("SELECT RELEASE_LOCK('slide_max386_mysql3308')");
        lockHeld = false;
      },
      root,
      userCreated,
      loginUser,
      owned,
    });
  }, 60_000);

  it('saves a connection field once, lets another connection see it, and does not call the test when retrieval is null', async () => {
    const id = await insert({
      name: `null-${nonce}`,
      host: '10.31.8.1',
      port: 18001,
      username: 'unused',
      passwordEncrypted: encryptData(secret),
      databaseName: `null-${nonce}`,
      description: 'before',
    });
    const readable = await instanceDatabaseService.getInstanceWithDecryptedPassword(id);
    expect(readable?.password).toBe(secret);
    const retrieval = vi.spyOn(instanceDatabaseService, 'getInstanceWithDecryptedPassword').mockResolvedValue(null);
    const tested = vi.spyOn(instanceDatabaseService, 'testConnection');
    const before = instanceUpdates;
    try {
      const { result, audits } = await run(
        { instance_id: id, host: '10.31.8.2', description: `saved-${nonce}` },
        actorFor(id),
      );
      expect(tested).not.toHaveBeenCalled();
      expect(instanceUpdates - before).toBe(1);
      expect(result).toMatchObject({
        success: true,
        status: 'warning',
        data: {
          configSaved: true,
          connectionTested: false,
          connectionSuccess: false,
          connectionTestOutcome: 'unavailable',
          warning: '配置已保存，但未能执行连接测试',
          instanceId: id,
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.errorCode).toBeUndefined();
      expect(JSON.stringify({ result, audits })).not.toContain('测试失败');
      expect(JSON.stringify({ result, audits })).not.toContain(secret);
      const committed = await readRow(id);
      expect(committed.host).toBe('10.31.8.2');
      expect(committed.description).toBe(`saved-${nonce}`);
      expect(committed.host).not.toBe('10.31.8.1');
    } finally {
      retrieval.mockRestore();
      tested.mockRestore();
    }
  }, 30_000);

  it('reports a real refused login as a failed test and a real login as success', async () => {
    const failedId = await insert({
      name: `fail-${nonce}`,
      host: targetHost,
      port: targetPort,
      username: loginUser,
      passwordEncrypted: encryptData(secret),
      databaseName: `fail-${nonce}`,
    });
    const passedId = await insert({
      name: `pass-${nonce}`,
      host: targetHost,
      port: targetPort,
      username: loginUser,
      passwordEncrypted: encryptData(secret),
      databaseName: owned!.database,
    });
    const before = instanceUpdates;
    const failed = await run({ instance_id: failedId, username: `absent_${nonce}` }, actorFor(failedId));
    expect(failed.result).toMatchObject({
      success: true,
      status: 'warning',
      data: {
        connectionTested: true,
        connectionSuccess: false,
        connectionTestOutcome: 'failed',
        warning: '配置已保存，但新连接测试失败',
      },
    });
    expect(JSON.stringify(failed.result)).not.toContain('未能执行');
    expect(JSON.stringify(failed.result)).not.toContain(secret);
    expect((await readRow(failedId)).username).toBe(`absent_${nonce}`);
    const passed = await run({ instance_id: passedId, port: targetPort }, actorFor(passedId));
    expect(passed.result).toMatchObject({
      success: true,
      status: 'success',
      data: { connectionTested: true, connectionSuccess: true, connectionTestOutcome: 'passed' },
    });
    expect(JSON.stringify(passed.result)).not.toContain('测试失败');
    expect(JSON.stringify(passed.result)).not.toContain(secret);
    expect(Number((await readRow(passedId)).port)).toBe(targetPort);
    expect(instanceUpdates - before).toBe(2);
  }, 30_000);

  it('keeps a thrown connection check and a non-connection edit on their existing results', async () => {
    const thrownId = await insert({
      name: `throw-${nonce}`,
      host: '10.31.8.4',
      port: 18004,
      username: 'unused',
      passwordEncrypted: encryptData(secret),
      databaseName: `throw-${nonce}`,
      description: 'before',
    });
    const noteId = await insert({
      name: `note-${nonce}`,
      host: '10.31.8.5',
      port: 18005,
      username: 'unused',
      passwordEncrypted: encryptData(secret),
      databaseName: `note-${nonce}`,
      description: 'before',
    });
    const tested = vi.spyOn(instanceDatabaseService, 'testConnection').mockRejectedValue(new Error('synthetic-connect-fault'));
    const before = instanceUpdates;
    try {
      const thrown = await run({ instance_id: thrownId, host: '10.31.8.6' }, actorFor(thrownId));
      expect(thrown.result).toMatchObject({
        success: true,
        status: 'warning',
        data: { configSaved: true, connectionTested: true, verification: { stage: 'connect' } },
        details: { configCommitted: true, retryable: false },
      });
      expect(thrown.result.errorCode).toBeUndefined();
      expect(JSON.stringify(thrown)).not.toContain('synthetic-connect-fault');
      expect(JSON.stringify(thrown)).not.toContain(secret);
      expect((await readRow(thrownId)).host).toBe('10.31.8.6');
      const note = await run({ instance_id: noteId, description: `note-${nonce}` }, actorFor(noteId));
      expect(note.result).toMatchObject({
        success: true,
        status: 'success',
        data: { connectionTested: false, connectionSuccess: false, connectionTestOutcome: 'not_required' },
      });
      expect(tested).toHaveBeenCalledTimes(1);
      expect((await readRow(noteId)).description).toBe(`note-${nonce}`);
      expect(instanceUpdates - before).toBe(2);
    } finally {
      tested.mockRestore();
    }
  }, 30_000);
});

const OWNED_LOGIN = 'm386_abcdef01';

function cleanupHarness(failAt: string[] = []) {
  const calls: string[] = [];
  const fail = new Set(failAt);
  const step = async (name: string) => {
    calls.push(name);
    if (fail.has(name)) throw new Error(`injected ${name}`);
  };
  const handles: Max386CleanupHandles = {
    restoreMocks: () => { calls.push('restore-mocks'); if (fail.has('restore-mocks')) throw new Error('injected restore-mocks'); },
    observer: { end: () => step('observer.end') },
    pool: { end: () => step('pool.end') },
    releaseLock: () => step('releaseLock'),
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

describe('MAX-386 cleanup failure regression', () => {
  const laterSteps = ['observer.end', 'pool.end', 'dropUser', 'owned.drop', 'releaseLock', 'root.end'];

  it.each(['observer.end', 'pool.end', 'dropUser', 'owned.drop', 'releaseLock'])(
    'still closes the root connection when %s fails',
    async (failure) => {
      const { calls, handles } = cleanupHarness([failure]);
      await expect(releaseMax386Acceptance(handles)).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: `injected ${failure}` })],
      });
      const start = laterSteps.indexOf(failure);
      for (const name of laterSteps.slice(start)) expect(calls).toContain(name);
      expect(calls.at(-1)).toBe('root.end');
    },
  );

  it('does not drop an account this run does not uniquely own', async () => {
    const { calls, handles } = cleanupHarness();
    handles.root = {
      query: async () => {
        calls.push('select-user');
        return [[{ user: OWNED_LOGIN, host: 'localhost' }, { user: OWNED_LOGIN, host: '%' }], undefined];
      },
      end: async () => { calls.push('root.end'); },
    };
    const error = await releaseMax386Acceptance(handles).then(
      () => { throw new Error('cleanup resolved'); },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((item) => item instanceof Error ? item.message : String(item))).toEqual([
      'refusing to drop a MySQL account this run does not uniquely own',
    ]);
    expect(calls).not.toContain('dropUser');
    expect(calls).toContain('owned.drop');
    expect(calls).toContain('releaseLock');
    expect(calls.at(-1)).toBe('root.end');
  });

  it('retains the first error and still releases the remaining handles', async () => {
    const prior = new Error('business failed');
    const failures = ['observer.end', 'pool.end', 'dropUser', 'owned.drop', 'releaseLock', 'root.end'];
    const { calls, handles } = cleanupHarness(failures);
    const error = await releaseMax386Acceptance(handles, prior).then(
      () => { throw new Error('cleanup resolved'); },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.cause).toBe(prior);
    expect(aggregate.errors[0]).toBe(prior);
    expect(calls.at(-1)).toBe('root.end');
    expect(calls).toContain('releaseLock');
  });
});
