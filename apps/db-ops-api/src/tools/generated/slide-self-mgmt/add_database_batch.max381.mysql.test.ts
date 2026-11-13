/**
 * MAX-381 / GitHub #604: unexecuted batch cancellation on isolated mysql3308.
 *
 * Default collection reads no credentials and opens no database. The runner
 * injects MAX381_MYSQL_* plus a non-loopback target. Persistence and the
 * successful connection test are real mysql3308. Approval, JWT login, and
 * audit are not on this path. Cleanup drops only schemas and the account this
 * run confirmed it created.
 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../../../db-connection.js';
import { credentialReferenceService } from '../../../security/credential-reference-service.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../../../testing/owned-fixture.js';
import { addDatabaseTool } from './add_database.js';
import { addDatabaseBatchTool } from './add_database_batch.js';

type MysqlEnv = Record<string, string | undefined>;

export function max381AcceptanceEnabled(env: MysqlEnv = process.env): boolean {
  return env.MAX381_MYSQL_ACCEPTANCE === '1';
}

const acceptance = max381AcceptanceEnabled();

interface AccountRow { user?: string; host?: string }

interface Max381CleanupHandles {
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
  platform?: { drop: () => Promise<void> } | null;
  targets: Array<{ drop: () => Promise<void> } | null | undefined>;
}

/** Each step runs after an earlier failure. The root session closes last. */
export async function releaseMax381Acceptance(
  handles: Max381CleanupHandles,
  priorError?: unknown,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  const steps: Array<() => Promise<void>> = [
    async () => { handles.restoreMocks?.(); },
    async () => { await handles.observer?.end(); },
    async () => { await handles.pool?.end(); },
    async () => { await dropOwnedMysqlUser(handles); },
    async () => { await handles.platform?.drop(); },
    ...handles.targets.map((target) => async () => { await target?.drop(); }),
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
      ? 'MAX-381 cleanup failed'
      : 'MAX-381 cleanup failed; the first error is retained',
  );
  if (priorError !== undefined) failure.cause = priorError;
  throw failure;
}

async function dropOwnedMysqlUser(handles: Max381CleanupHandles): Promise<void> {
  if (!handles.userCreated) return;
  if (!handles.root) throw new Error('refusing to drop a MySQL account without the connection that created it');
  const [accounts] = await handles.root.query(
    'SELECT user, host FROM mysql.user WHERE user = ?',
    [handles.loginUser],
  );
  if (accounts.length !== 1 || accounts[0]?.host !== '%' || !/^m381_[a-z0-9]+$/.test(handles.loginUser)) {
    throw new Error('refusing to drop a MySQL account this run does not uniquely own');
  }
  await handles.root.query(`DROP USER '${handles.loginUser}'@'%'`);
}

describe('MAX-381 acceptance stays opt-in', () => {
  it('does not enable a real database when the runner omits the flag', () => {
    expect(max381AcceptanceEnabled({})).toBe(false);
    expect(max381AcceptanceEnabled({ MAX381_MYSQL_ACCEPTANCE: '0', MAX381_MYSQL_PASSWORD: 'unused' })).toBe(false);
  });
});

describe.skipIf(!acceptance)('MAX-381 cancelled batch items on exclusive mysql3308', () => {
  let root: mysql.Connection | null = null;
  let pool: Pool | null = null;
  let observer: mysql.Connection | null = null;
  let platform: OwnedDatabase | null = null;
  const targets: OwnedDatabase[] = [];
  let userCreated = false;
  let lockHeld = false;
  let loginUser = '';
  let secret = '';
  let targetHost = '';
  let targetPort = 0;
  const nonce = generateRunNonce();
  const handleDir = join(fileURLToPath(new URL('../../../../.max238-handles/', import.meta.url)));
  const absentSchema = `m381_absent_${nonce}`;

  const rowsFor = async (name: string) => {
    const [rows] = await observer!.query<RowDataPacket[]>(
      'SELECT id, name, database_name, password_encrypted FROM database_instances WHERE name = ?',
      [name],
    );
    return rows;
  };
  const refStatus = async (ref: string) => {
    const [rows] = await observer!.query<RowDataPacket[]>(
      'SELECT status FROM agent_credential_references WHERE ref_id = ?',
      [ref],
    );
    return rows[0]?.status;
  };
  const schemaCount = async (name: string) => {
    const [rows] = await root!.query<RowDataPacket[]>(
      'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [name],
    );
    return rows.length;
  };

  beforeAll(async () => {
    const host = process.env.MAX381_MYSQL_HOST;
    const portText = process.env.MAX381_MYSQL_PORT;
    const port = Number(portText);
    const user = process.env.MAX381_MYSQL_USER;
    const password = process.env.MAX381_MYSQL_PASSWORD;
    targetHost = process.env.MAX381_TARGET_HOST ?? '';
    targetPort = Number(process.env.MAX381_TARGET_PORT);
    if (process.env.MAX381_MYSQL_CONTAINER !== 'mysql3308') {
      throw new Error('MAX381 acceptance requires MAX381_MYSQL_CONTAINER=mysql3308');
    }
    if (host !== '127.0.0.1' || portText !== '3308' || !user || password === undefined) {
      throw new Error('MAX381 acceptance requires 127.0.0.1:3308 and an injected user');
    }
    if (!isIP(targetHost) || targetHost.startsWith('127.') || targetHost === '0.0.0.0' || targetHost === '::1') {
      throw new Error('MAX381_TARGET_HOST must be a non-loopback address');
    }
    if (!Number.isInteger(targetPort) || targetPort !== 3308) {
      throw new Error('MAX381_TARGET_PORT must be 3308');
    }
    secret = randomBytes(18).toString('hex');
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    root = await mysql.createConnection({ host, port, user, password, multipleStatements: false });
    const [lockRows] = await root.query<RowDataPacket[]>(
      "SELECT GET_LOCK('slide_max381_mysql3308', 20) AS locked, @@port AS server_port, @@hostname AS hostname, @@version AS version",
    );
    if (Number(lockRows[0]?.locked) !== 1) throw new Error('mysql3308 exclusive lock was not acquired');
    lockHeld = true;
    console.log(`max381 mysql3308 lock=1 server_port=${lockRows[0]?.server_port} hostname=${lockRows[0]?.hostname} version=${lockRows[0]?.version}`);
    platform = await createOwnedDatabase(root, { nonce, purpose: 'max381', handleDir });
    targets.push(await createOwnedDatabase(root, { nonce, purpose: 'max381a', handleDir }));
    targets.push(await createOwnedDatabase(root, { nonce, purpose: 'max381b', handleDir }));
    loginUser = `m381_${nonce}`;
    await root.query("CREATE USER ?@'%' IDENTIFIED BY ?", [loginUser, secret]);
    userCreated = true;
    for (const target of targets) {
      await root.query(`GRANT SELECT ON \`${target.database}\`.* TO ?@'%'`, [loginUser]);
    }
    pool = mysql.createPool({ host, port, user, password, database: platform.database, connectionLimit: 4 });
    observer = await mysql.createConnection({ host, port, user, password, database: platform.database });
    await pool.query(`
      CREATE TABLE users (
        id INT UNSIGNED NOT NULL PRIMARY KEY
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query('INSERT INTO users (id) VALUES (7)');
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
        PRIMARY KEY (id),
        UNIQUE KEY idx_name_environment (name, environment)
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
        PRIMARY KEY (ref_id),
        CONSTRAINT fk_agent_credential_owner FOREIGN KEY (owner_id) REFERENCES users(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as never);
  }, 60_000);

  afterAll(async () => {
    await releaseMax381Acceptance({
      restoreMocks: () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); },
      observer,
      pool,
      releaseLock: async () => {
        if (!lockHeld || !root) return;
        await root.query("SELECT RELEASE_LOCK('slide_max381_mysql3308')");
        lockHeld = false;
      },
      root,
      userCreated,
      loginUser,
      platform,
      targets,
    });
  }, 60_000);

  it('keeps real created instances and does not create cancelled items', async () => {
    expect(await schemaCount(absentSchema)).toBe(0);
    const issue = () => credentialReferenceService.create(7, addDatabaseTool.name, secret);
    const keptRef = await issue();
    const secondRef = await issue();
    const absentRef = await issue();
    const earlyRef = await issue();
    const names = {
      kept: `max381a_${nonce}`,
      second: `max381b_${nonce}`,
      absent: `max381c_${nonce}`,
      early: `max381d_${nonce}`,
    };
    const item = (name: string, databaseName: string, ref: string) => ({
      db_type: 'mysql',
      name,
      host: targetHost,
      port: targetPort,
      username: loginUser,
      database_name: databaseName,
      credential_ref: ref,
      environment: 'development',
    });
    const calls = vi.spyOn(addDatabaseTool, 'handler');
    const controller = new AbortController();
    const result = await addDatabaseBatchTool.handler({
      concurrency: 2,
      databases: [
        item(names.kept, targets[0]!.database, keptRef.ref),
        item(names.second, targets[1]!.database, secondRef.ref),
        item(names.absent, absentSchema, absentRef.ref),
      ],
    }, {
      actor: { userId: 7 } as never,
      signal: controller.signal,
      progressCallback: () => {
        controller.abort();
        controller.abort();
      },
    });

    expect(calls).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: true,
      status: 'warning',
      data: { total: 3, succeeded: 2, failed: 0, cancelled: 1 },
      details: { terminal: true, retryable: false, failed: 0, cancelled: 1 },
    });
    const results = (result.data as { results: Array<Record<string, unknown>> }).results;
    expect(results.map((entry) => entry.status)).toEqual(['created', 'created', 'cancelled']);
    expect(results[2]).toMatchObject({
      status: 'cancelled', errorCode: 'BATCH_CANCELLED', retryable: false, name: names.absent,
    });
    const keptRows = await rowsFor(names.kept);
    const secondRows = await rowsFor(names.second);
    const absentRows = await rowsFor(names.absent);
    expect(keptRows).toHaveLength(1);
    expect(secondRows).toHaveLength(1);
    expect(absentRows).toHaveLength(0);
    expect(keptRows[0]?.id).toBe(results[0]?.instanceId);
    expect(secondRows[0]?.id).toBe(results[1]?.instanceId);
    expect(String(keptRows[0]?.password_encrypted)).not.toContain(secret);
    expect(String(secondRows[0]?.password_encrypted)).not.toContain(secret);
    expect(await refStatus(keptRef.ref)).toBe('consumed');
    expect(await refStatus(secondRef.ref)).toBe('consumed');
    expect(await refStatus(absentRef.ref)).toBe('active');
    expect(await schemaCount(absentSchema)).toBe(0);
    expect(await schemaCount(targets[0]!.database)).toBe(1);
    expect(await schemaCount(targets[1]!.database)).toBe(1);
    expect(JSON.stringify(result)).not.toContain(secret);

    const blocked = new AbortController();
    blocked.abort();
    const before = calls.mock.calls.length;
    const untouched = await addDatabaseBatchTool.handler({
      concurrency: 2,
      databases: [item(names.early, absentSchema, earlyRef.ref)],
    }, { actor: { userId: 7 } as never, signal: blocked.signal });
    expect(calls).toHaveBeenCalledTimes(before);
    expect(untouched).toMatchObject({
      data: { succeeded: 0, failed: 0, cancelled: 1 },
      details: { retryable: false },
    });
    expect(await rowsFor(names.early)).toHaveLength(0);
    expect(await refStatus(earlyRef.ref)).toBe('active');
    expect(await schemaCount(absentSchema)).toBe(0);
    console.log(JSON.stringify({
      boundary: {
        cancel: 'real AbortSignal on slide_add_database_batch handler',
        approval: 'not invoked',
        user: 'injected actor userId 7, no JWT login',
        connection: 'real mysql3308 for the two started items; cancelled items opened no connection',
      },
      calls: calls.mock.calls.length,
      succeeded: 2,
      cancelled: 1,
      absentSchemaCreated: false,
      targetHost,
      targetPort,
    }));
  }, 60_000);
});

const OWNED_LOGIN = 'm381_abcdef01';

function cleanupHarness(failAt: string[] = []) {
  const calls: string[] = [];
  const fail = new Set(failAt);
  const step = async (name: string) => {
    calls.push(name);
    if (fail.has(name)) throw new Error(`injected ${name}`);
  };
  const handles: Max381CleanupHandles = {
    restoreMocks: () => { calls.push('restore-mocks'); if (fail.has('restore-mocks')) throw new Error('injected restore-mocks'); },
    observer: { end: () => step('observer.end') },
    pool: { end: () => step('pool.end') },
    releaseLock: () => step('releaseLock'),
    root: {
      query: async (sql: string) => {
        if (sql.includes('DROP DATABASE')) throw new Error('refusing an unconfirmed DROP DATABASE');
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
    platform: { drop: () => step('platform.drop') },
    targets: [{ drop: () => step('target.drop') }],
  };
  return { calls, handles };
}

describe('MAX-381 cleanup failure regression', () => {
  const laterSteps = ['observer.end', 'pool.end', 'dropUser', 'platform.drop', 'target.drop', 'releaseLock', 'root.end'];

  it.each(['observer.end', 'pool.end', 'dropUser', 'platform.drop', 'target.drop', 'releaseLock'])(
    'still closes the root connection when %s fails',
    async (failure) => {
      const { calls, handles } = cleanupHarness([failure]);
      await expect(releaseMax381Acceptance(handles)).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: `injected ${failure}` })],
      });
      const start = laterSteps.indexOf(failure);
      for (const name of laterSteps.slice(start)) expect(calls).toContain(name);
      expect(calls.at(-1)).toBe('root.end');
    },
  );

  it('does not drop an account or schema this run does not uniquely own', async () => {
    const { calls, handles } = cleanupHarness();
    handles.userCreated = true;
    handles.platform = null;
    handles.targets = [];
    handles.root = {
      query: async (sql: string) => {
        if (sql.includes('DROP DATABASE') || sql.includes('DROP USER')) {
          calls.push('unexpected-drop');
          throw new Error('unexpected drop');
        }
        calls.push('select-user');
        return [[{ user: OWNED_LOGIN, host: 'localhost' }, { user: OWNED_LOGIN, host: '%' }], undefined];
      },
      end: async () => { calls.push('root.end'); },
    };
    const error = await releaseMax381Acceptance(handles).then(
      () => { throw new Error('cleanup resolved'); },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((item) => item instanceof Error ? item.message : String(item))).toEqual([
      'refusing to drop a MySQL account this run does not uniquely own',
    ]);
    expect(calls).not.toContain('unexpected-drop');
    expect(calls.at(-1)).toBe('root.end');
  });

  it('drops the next owned schema when an earlier schema drop fails', async () => {
    const { calls, handles } = cleanupHarness();
    handles.targets = [
      { drop: async () => { calls.push('target.a'); throw new Error('injected target.a'); } },
      { drop: async () => { calls.push('target.b'); } },
    ];
    await expect(releaseMax381Acceptance(handles)).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toContain('target.a');
    expect(calls).toContain('target.b');
    expect(calls.at(-1)).toBe('root.end');
  });

  it('retains the first error and still releases the remaining handles', async () => {
    const prior = new Error('business failed');
    const failures = ['observer.end', 'pool.end', 'dropUser', 'platform.drop', 'target.drop', 'releaseLock', 'root.end'];
    const { calls, handles } = cleanupHarness(failures);
    const error = await releaseMax381Acceptance(handles, prior).then(
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
