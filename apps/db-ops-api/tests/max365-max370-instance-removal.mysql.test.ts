import { randomBytes } from 'node:crypto';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/migrations/runner.js';
import type { MigrationPool } from '../src/migrations/types.js';
import { dbConnection } from '../src/db-connection.js';
import { databaseService } from '../src/database-service.js';
import { instanceDatabaseService } from '../src/instance-database-service.js';
import { instanceAccessLifecycle } from '../src/resources/instance-access-lifecycle.js';
import {
  InstanceRemovalService,
  MysqlInstanceRemovalStore,
  RemovalIntentUnknownError,
  instanceRemovalService,
  instanceRemovalStore,
} from '../src/resources/instance-removal-service.js';

vi.mock('../src/security/database-target-policy.js', () => ({
  authorizeDatabaseTarget: async (target: { host: string; port: number }) => ({
    hostname: target.host,
    address: target.host,
    port: target.port,
  }),
}));

type MysqlEnv = Record<string, string | undefined>;

function acceptanceEnabled(env: MysqlEnv = process.env): boolean {
  return env.MAX365_MYSQL_ACCEPTANCE === '1';
}

function mysqlTestConfig(env: MysqlEnv = process.env): mysql.ConnectionOptions {
  const host = env.MAX365_MYSQL_HOST;
  const portText = env.MAX365_MYSQL_PORT;
  const user = env.MAX365_MYSQL_USER;
  const password = env.MAX365_MYSQL_PASSWORD;
  const port = Number(portText);
  if (host !== '127.0.0.1' || portText !== '3308' || !Number.isInteger(port) || !user || password === undefined) {
    throw new Error(
      'MAX365_MYSQL_ACCEPTANCE=1 requires MAX365_MYSQL_HOST=127.0.0.1, MAX365_MYSQL_PORT=3308, MAX365_MYSQL_USER, and MAX365_MYSQL_PASSWORD',
    );
  }
  return { host, port, user, password, connectTimeout: 5_000 };
}

describe('MAX-365 injected mysql acceptance config', () => {
  it('stays disabled until this task explicitly enables real acceptance', () => {
    expect(acceptanceEnabled({})).toBe(false);
    expect(acceptanceEnabled({ MAX365_MYSQL_ACCEPTANCE: '0' })).toBe(false);
  });

  it('fails when real acceptance is enabled without the injected 3308 endpoint', () => {
    expect(() => mysqlTestConfig({ MAX365_MYSQL_ACCEPTANCE: '1' })).toThrow(/MAX365_MYSQL_PORT=3308/);
    expect(() => mysqlTestConfig({
      MAX365_MYSQL_ACCEPTANCE: '1',
      MAX365_MYSQL_HOST: '127.0.0.1',
      MAX365_MYSQL_PORT: '3306',
      MAX365_MYSQL_USER: 'root',
      MAX365_MYSQL_PASSWORD: 'injected',
    })).toThrow(/MAX365_MYSQL_PORT=3308/);
  });
});

function withLostCommit(base: Pool, mode: 'before' | 'after'): Pool {
  // Only the removal intent commit is injected. Later cleanup commits stay real.
  // Before the server COMMIT, roll the session back inside this wrapper: pool
  // release does not roll back, and the next START TRANSACTION would commit it.
  let intentCommitPending = true;
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== 'getConnection') return Reflect.get(target, prop, receiver);
      return async () => {
        const connection = await target.getConnection();
        const commit = connection.commit.bind(connection);
        const rollback = connection.rollback.bind(connection);
        connection.commit = async () => {
          if (!intentCommitPending) return commit();
          intentCommitPending = false;
          if (mode === 'before') {
            await rollback();
            throw new Error('COMMIT_RECEIPT_LOST');
          }
          await commit();
          throw new Error('COMMIT_RECEIPT_LOST');
        };
        return connection;
      };
    },
  });
}

function withHeldTransaction(base: Pool, mode: 'commit' | 'rollback'): { pool: Pool; sessions: number[] } {
  // The server has applied the deleting update and this wrapper never confirms
  // COMMIT or ROLLBACK. Returning that session to the pool would let the next
  // START TRANSACTION commit the unknown write.
  const sessions: number[] = [];
  let armed = true;
  const pool = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== 'getConnection') return Reflect.get(target, prop, receiver);
      return async () => {
        const connection = await target.getConnection();
        if (!armed) return connection;
        const [ident] = await connection.query<RowDataPacket[]>('SELECT CONNECTION_ID() AS id');
        sessions.push(Number(ident[0].id));
        const execute = connection.execute.bind(connection);
        const commit = connection.commit.bind(connection);
        const rollback = connection.rollback.bind(connection);
        let updated = false;
        connection.execute = (async (...args: unknown[]) => {
          const result = await execute(...(args as [string]));
          if (armed && mode === 'rollback' && String(args[0]).includes("lifecycle_state = 'deleting'")) {
            updated = true;
            armed = false;
            throw new Error('UPDATE_APPLIED_RECEIPT_LOST');
          }
          return result;
        }) as typeof connection.execute;
        connection.commit = (async () => {
          if (!(armed && mode === 'commit')) return commit();
          armed = false;
          throw new Error('COMMIT_RECEIPT_LOST_OPEN');
        }) as typeof connection.commit;
        connection.rollback = (async () => {
          if (mode === 'rollback' && updated) throw new Error('ROLLBACK_FAILED');
          return rollback();
        }) as typeof connection.rollback;
        return connection;
      };
    },
  });
  return { pool, sessions };
}

function asReasons(value: unknown): string[] | null {
  if (value == null) return null;
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return value as string[];
}

describe.skipIf(!acceptanceEnabled())('MAX-365/MAX-370 instance removal on isolated mysql3308', () => {
  const suffix = randomBytes(4).toString('hex');
  const schema = `max365_${suffix}`;
  const sentinelSchema = `max365_sentinel_${suffix}`;
  const owned = new Set<string>();
  let admin: mysql.Connection;
  let pool: Pool;
  let schemasBefore: Set<string>;
  let instanceId = 0;
  let sentinelId = 0;
  let userId = 0;
  let sequence = 0;
  let stopTasks: ReturnType<typeof vi.fn>;
  const runtime = () => ({
    stopTasks: (id: number) => stopTasks(id),
    stopCollection: async () => {},
    closeConnections: (id: number) => databaseService.removeConnection(id),
  });

  async function createOwned(name: string): Promise<void> {
    await admin.query(`CREATE DATABASE \`${name}\``);
    owned.add(name);
  }

  async function snapshot(id = instanceId): Promise<RowDataPacket> {
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT * FROM database_instances WHERE id = ?', [id]);
    return rows[0];
  }

  beforeAll(async () => {
    const config = mysqlTestConfig();
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('NODE_ENV', 'test');
    admin = await mysql.createConnection(config);
    const [schemas] = await admin.query<RowDataPacket[]>('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA');
    schemasBefore = new Set(schemas.map(row => String(row.name)));
    await createOwned(sentinelSchema);
    await admin.query(`CREATE TABLE \`${sentinelSchema}\`.marker (id INT PRIMARY KEY)`);
    await admin.query(`INSERT INTO \`${sentinelSchema}\`.marker (id) VALUES (1)`);
    await createOwned(schema);
    pool = mysql.createPool({ ...config, database: schema, connectionLimit: 12 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    instanceAccessLifecycle.configure(id => instanceRemovalStore.available(id));
    const [user] = await pool.execute<mysql.ResultSetHeader>(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [`max365-${suffix}`, 'not-a-login-secret'],
    );
    userId = user.insertId;
    const [sentinel] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO database_instances
        (name, environment, db_type, host, port, username, password_encrypted, database_name, connection_string)
       VALUES (?, 'testing', 'mysql', '192.0.2.81', 33062, 'reader', 'sentinel-secret', 'sentinel', 'sentinel-dsn')`,
      [`max365-sentinel-${suffix}`],
    );
    sentinelId = sentinel.insertId;
  }, 180_000);

  beforeEach(async () => {
    stopTasks = vi.fn(async () => {});
    instanceRemovalService.configure(runtime());
    const [instance] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO database_instances
        (name, environment, db_type, host, port, username, password_encrypted, database_name, connection_string)
       VALUES (?, 'testing', 'mysql', '192.0.2.80', ?, 'reader', 'fixture-secret', ?, 'fixture-dsn')`,
      [`fixture-${suffix}-${++sequence}`, 33060 + sequence, `app-${sequence}`],
    );
    instanceId = instance.insertId;
  });

  afterAll(async () => {
    const failures: string[] = [];
    try {
      if (pool && sentinelId) {
        const [rows] = await pool.execute<RowDataPacket[]>(
          'SELECT lifecycle_state, password_encrypted, connection_string FROM database_instances WHERE id = ?',
          [sentinelId],
        );
        if (rows.length !== 1 || rows[0].lifecycle_state !== 'available' || rows[0].password_encrypted !== 'sentinel-secret') {
          failures.push('sentinel instance changed');
        }
      }
      if (admin && sentinelSchema) {
        const [marker] = await admin.query<RowDataPacket[]>(`SELECT id FROM \`${sentinelSchema}\`.marker`);
        if (marker.length !== 1) failures.push('sentinel schema changed');
      }
      if (admin && schemasBefore) {
        const [schemas] = await admin.query<RowDataPacket[]>('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA');
        const after = new Set(schemas.map(row => String(row.name)));
        for (const name of schemasBefore) {
          if (!after.has(name)) failures.push(`schema disappeared: ${name}`);
        }
      }
    } finally {
      vi.restoreAllMocks();
      await pool?.end().catch(() => undefined);
      if (admin) {
        for (const name of owned) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
        await admin.end();
      }
    }
    if (failures.length) throw new Error(failures.join('; '));
  }, 60_000);

  it('rolls back a rejected intent and restores access without a restart', async () => {
    const signal = instanceAccessLifecycle.signal(instanceId);
    let release!: () => void;
    const inflight = instanceAccessLifecycle.track(instanceId, () => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await pool.query(`CREATE TRIGGER max365_reject_intent BEFORE UPDATE ON database_instances
      FOR EACH ROW BEGIN
        IF NEW.lifecycle_state = 'deleting' AND OLD.lifecycle_state = 'available' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'max365 rollback';
        END IF;
      END`);
    try {
      const failed = await instanceDatabaseService.deleteInstance(instanceId);
      expect(failed).toMatchObject({ success: false, statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
      expect(instanceAccessLifecycle.isRevoked(instanceId)).toBe(false);
      expect(signal.aborted).toBe(false);
      expect(await snapshot()).toMatchObject({ lifecycle_state: 'available', removal_requested_at: null, password_encrypted: 'fixture-secret' });
      await expect(instanceAccessLifecycle.assertAvailable(instanceId)).resolves.toBeUndefined();
    } finally {
      release();
      await inflight;
      await pool.query('DROP TRIGGER IF EXISTS max365_reject_intent');
    }
    expect(await instanceDatabaseService.deleteInstance(instanceId)).toEqual({ success: true, state: 'deleted' });
    expect(await snapshot()).toMatchObject({ lifecycle_state: 'deleted', password_encrypted: '', connection_string: null });
    await expect(instanceAccessLifecycle.assertAvailable(instanceId)).rejects.toThrow('INSTANCE_REMOVED');
  });

  it('a refused connection leaves the real row available and clears only this fence', async () => {
    const dead = mysql.createPool({ host: '127.0.0.1', port: 1, user: 'none', password: 'none', connectTimeout: 400 });
    try {
      const service = new InstanceRemovalService(new MysqlInstanceRemovalStore(() => dead), instanceAccessLifecycle, runtime());
      await expect(service.remove(instanceId)).resolves.toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
      expect(await snapshot()).toMatchObject({ lifecycle_state: 'available', removal_requested_at: null });
      await expect(instanceAccessLifecycle.assertAvailable(instanceId)).resolves.toBeUndefined();
      expect(stopTasks).not.toHaveBeenCalled();
    } finally {
      await dead.end();
    }
  });

  it('an injected lost commit receipt is reconciled against the real row', async () => {
    const lostBefore = withLostCommit(pool, 'before');
    const before = new InstanceRemovalService(
      new MysqlInstanceRemovalStore(() => lostBefore),
      instanceAccessLifecycle,
      runtime(),
    );
    await expect(before.remove(instanceId)).resolves.toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(await snapshot()).toMatchObject({ lifecycle_state: 'available', removal_requested_at: null });
    await expect(instanceAccessLifecycle.assertAvailable(instanceId)).resolves.toBeUndefined();

    const lostAfter = withLostCommit(pool, 'after');
    const after = new InstanceRemovalService(
      new MysqlInstanceRemovalStore(() => lostAfter),
      instanceAccessLifecycle,
      runtime(),
    );
    await expect(after.remove(instanceId)).resolves.toEqual({ success: true, state: 'deleted' });
    expect(await snapshot()).toMatchObject({ lifecycle_state: 'deleted', password_encrypted: '', removal_reasons: null });
    await expect(instanceAccessLifecycle.assertAvailable(instanceId)).rejects.toThrow('INSTANCE_REMOVED');
  });

  it('a one-connection pool destroys an open removal transaction instead of reusing or replaying it', async () => {
    const small = mysql.createPool({ ...mysqlTestConfig(), database: schema, connectionLimit: 1, maxIdle: 1 });
    try {
      for (const mode of ['commit', 'rollback'] as const) {
        const held = withHeldTransaction(small, mode);
        const service = new InstanceRemovalService(new MysqlInstanceRemovalStore(() => held.pool), instanceAccessLifecycle, runtime());
        await expect(service.remove(instanceId)).resolves.toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
        expect(stopTasks).not.toHaveBeenCalled();
        const doomed = held.sessions[0];
        expect(doomed).toBeGreaterThan(0);
        let gone = false;
        for (let attempt = 0; attempt < 20 && !gone; attempt++) {
          const [alive] = await admin.query<RowDataPacket[]>('SELECT ID FROM information_schema.PROCESSLIST WHERE ID = ?', [doomed]);
          gone = alive.length === 0;
          if (!gone) await new Promise(resolve => setTimeout(resolve, 25));
        }
        expect(gone).toBe(true);
        const [committed] = await admin.query<RowDataPacket[]>(
          `SELECT lifecycle_state, removal_requested_at, password_encrypted FROM \`${schema}\`.database_instances WHERE id = ?`,
          [instanceId],
        );
        expect(committed[0]).toMatchObject({ lifecycle_state: 'available', removal_requested_at: null, password_encrypted: 'fixture-secret' });
        const probe = await small.getConnection();
        try {
          const [session] = await probe.query<RowDataPacket[]>(`SELECT CONNECTION_ID() AS id,
            (SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id = CONNECTION_ID()) AS innodb_pending,
            (SELECT c.state FROM performance_schema.events_transactions_current c
               JOIN performance_schema.threads t ON t.thread_id = c.thread_id
               WHERE t.processlist_id = CONNECTION_ID() LIMIT 1) AS tx_state`);
          expect(Number(session[0].innodb_pending)).toBe(0);
          expect(session[0].tx_state).not.toBe('ACTIVE');
          expect(Number(session[0].id)).not.toBe(doomed);
          await probe.beginTransaction();
          const [afterStart] = await probe.query<RowDataPacket[]>('SELECT lifecycle_state FROM database_instances WHERE id = ?', [instanceId]);
          expect(afterStart[0].lifecycle_state).toBe('available');
          await probe.rollback();
        } finally {
          probe.release();
        }
        await expect(instanceAccessLifecycle.assertAvailable(instanceId)).resolves.toBeUndefined();
      }
      expect(await instanceDatabaseService.deleteInstance(instanceId)).toEqual({ success: true, state: 'deleted' });
      expect(await snapshot()).toMatchObject({ lifecycle_state: 'deleted', password_encrypted: '', connection_string: null });
    } finally {
      await small.end();
    }
  });

  it('an injected verification failure keeps the fence while the real row stays available', async () => {
    const store = new MysqlInstanceRemovalStore(() => pool);
    store.begin = async () => { throw new RemovalIntentUnknownError(new Error('injected receipt')); };
    store.observe = async () => { throw new Error('verify down'); };
    const service = new InstanceRemovalService(store, instanceAccessLifecycle, runtime());
    await expect(service.remove(instanceId)).resolves.toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(await snapshot()).toMatchObject({ lifecycle_state: 'available', password_encrypted: 'fixture-secret' });
    await expect(instanceAccessLifecycle.assertAvailable(instanceId)).rejects.toThrow('INSTANCE_REMOVED');
    expect(stopTasks).not.toHaveBeenCalled();
  });

  it('concurrent deletion converges once, and a failed cleanup retries without rewriting a later tombstone', async () => {
    const [job] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO cron_jobs
        (name, task_description, cron_expr, enabled, task_type, target_instance_id, principal_type, identity_status, resource_scope)
       VALUES (?, 'fixture', '0 0 1 1 *', 1, 'agent', ?, 'user', 'bound', ?)`,
      [`cron-${suffix}-${instanceId}`, instanceId, JSON.stringify({ version: 1, targetInstanceId: instanceId, instanceIds: [instanceId], serverIds: [], networkDeviceIds: [] })],
    );
    await pool.execute(
      `INSERT INTO sql_execution_history (instance_id, instance_name, db_type, sql_text, status) VALUES (?, 'fixture', 'mysql', 'SELECT 7', 'success')`,
      [instanceId],
    );
    await pool.execute('INSERT INTO instance_permissions (user_id, instance_id) VALUES (?, ?)', [userId, instanceId]);
    expect(await databaseService.addConnection(instanceId, 'fixture', {
      host: '127.0.0.1', port: Number(mysqlTestConfig().port), user: String(mysqlTestConfig().user),
      password: String(mysqlTestConfig().password), database: schema, db_type: 'mysql',
    })).toBe(true);

    stopTasks.mockRejectedValueOnce(new Error('cleanup down'));
    const pending = await instanceDatabaseService.deleteInstance(instanceId);
    expect(pending).toMatchObject({ success: false, state: 'deleting', statusCode: 409, reasons: ['TASK_CLEANUP_PENDING'] });
    expect(asReasons((await snapshot()).removal_reasons)).toEqual(['TASK_CLEANUP_PENDING']);
    expect((await snapshot()).lifecycle_state).toBe('deleting');
    expect((await snapshot()).password_encrypted).toBe('fixture-secret');
    await expect(instanceAccessLifecycle.assertAvailable(instanceId)).rejects.toThrow('INSTANCE_REMOVED');

    const first = instanceRemovalService.remove(instanceId);
    const second = instanceRemovalService.remove(instanceId);
    expect(second).toBe(first);
    const entry = instanceDatabaseService.deleteInstance(instanceId);
    expect(entry).not.toBe(first);
    expect(await Promise.all([first, entry])).toEqual([
      { success: true, state: 'deleted' },
      { success: true, state: 'deleted' },
    ]);
    const tombstone = await snapshot();
    expect(tombstone).toMatchObject({ lifecycle_state: 'deleted', status: 'inactive', password_encrypted: '', connection_string: null, removal_reasons: null });
    expect(tombstone.removed_at).toBeTruthy();
    const [jobs] = await pool.execute<RowDataPacket[]>('SELECT enabled, target_instance_id FROM cron_jobs WHERE id = ?', [job.insertId]);
    expect(jobs[0]).toMatchObject({ enabled: 0, target_instance_id: instanceId });
    const [history] = await pool.execute<RowDataPacket[]>('SELECT sql_text FROM sql_execution_history WHERE instance_id = ?', [instanceId]);
    expect(history.map(row => row.sql_text)).toEqual(['SELECT 7']);
    const [grants] = await pool.execute<RowDataPacket[]>('SELECT id FROM instance_permissions WHERE instance_id = ?', [instanceId]);
    expect(grants).toHaveLength(1);
    expect(databaseService.getConnection(instanceId)).toBeNull();

    const callsBeforeRepeat = stopTasks.mock.calls.length;
    stopTasks.mockRejectedValue(new Error('cleanup down again'));
    expect(await instanceDatabaseService.deleteInstance(instanceId)).toEqual({ success: true, state: 'deleted' });
    expect(stopTasks.mock.calls.length).toBe(callsBeforeRepeat);
    expect(await snapshot()).toMatchObject({ lifecycle_state: 'deleted', removal_reasons: null, password_encrypted: '' });
    const [grantsAfter] = await pool.execute<RowDataPacket[]>('SELECT id FROM instance_permissions WHERE instance_id = ?', [instanceId]);
    expect(grantsAfter).toHaveLength(1);
  });

  it('keeps a deleting target occupied and allows a new resource after the tombstone', async () => {
    const host = '192.0.2.82';
    const port = 33071;
    const databaseName = `phys-${suffix}`;
    await pool.execute('UPDATE database_instances SET host = ?, port = ?, database_name = ? WHERE id = ?', [host, port, databaseName, instanceId]);
    await pool.execute(
      `INSERT INTO sql_execution_history (instance_id, instance_name, db_type, sql_text, status) VALUES (?, 'fixture', 'mysql', 'SELECT 8', 'success')`,
      [instanceId],
    );
    await pool.execute('INSERT INTO instance_permissions (user_id, instance_id) VALUES (?, ?)', [userId, instanceId]);
    stopTasks.mockRejectedValueOnce(new Error('cleanup down'));
    expect(await instanceDatabaseService.deleteInstance(instanceId)).toMatchObject({ state: 'deleting', statusCode: 409 });

    const blocked = await instanceDatabaseService.createInstance({
      name: `new-${suffix}`, environment: 'testing', db_type: 'mysql', host, port, username: 'reader',
      password: 'new-secret', database_name: databaseName,
    });
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('正在删除');
    expect(blocked.instanceId).toBeUndefined();

    expect(await instanceDatabaseService.deleteInstance(instanceId)).toEqual({ success: true, state: 'deleted' });
    const created = await instanceDatabaseService.createInstance({
      name: `new-${suffix}`, environment: 'testing', db_type: 'mysql', host, port, username: 'reader',
      password: 'new-secret', database_name: databaseName,
    });
    expect(created.success).toBe(true);
    expect(created.instanceId).not.toBe(instanceId);
    const oldRow = await snapshot();
    expect(oldRow).toMatchObject({ lifecycle_state: 'deleted', password_encrypted: '', connection_string: null, name: `fixture-${suffix}-${sequence}` });
    const fresh = await snapshot(created.instanceId!);
    expect(fresh.lifecycle_state).toBe('available');
    expect(fresh.password_encrypted).not.toBe('');
    expect(fresh.password_encrypted).not.toBe('new-secret');
    const [history] = await pool.execute<RowDataPacket[]>('SELECT sql_text FROM sql_execution_history WHERE instance_id = ?', [instanceId]);
    expect(history).toHaveLength(1);
    const [grants] = await pool.execute<RowDataPacket[]>('SELECT id FROM instance_permissions WHERE instance_id = ?', [instanceId]);
    expect(grants).toHaveLength(1);
    const sentinel = await snapshot(sentinelId);
    expect(sentinel).toMatchObject({ lifecycle_state: 'available', password_encrypted: 'sentinel-secret' });
  });
});
