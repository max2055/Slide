/**
 * MAX-376 real custom-collection gate.
 *
 * The default suite collects this file. The ownership regressions always run.
 * Database cases stay off unless MAX376_PG_ACCEPTANCE, MAX376_MYSQL_ACCEPTANCE,
 * MAX376_ORACLE_ACCEPTANCE, or MAX376_DAMENG_ACCEPTANCE is 1 and the matching
 * endpoint is injected. A set flag with a missing value fails that case.
 * This file does not read a developer credential path.
 *
 * Cleanup drops only names this run created. A failed or unknown CREATE is not
 * ownership. Exclusive names reduce collisions; they do not authorize a drop.
 * The connection is closed after cleanup. The first business error and any
 * cleanup error are both retained.
 *
 * The database, schema and rows are real when those flags are set. The
 * DatabaseConnection passed to CustomSQLProvider is constructed here and is
 * not a platform instance, a stored credential, or an authorization decision.
 */
import { randomBytes } from 'node:crypto';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { DatabaseConnection } from './database-service.js';
import type { MetricDefinition } from './metric-registry.js';
import { CustomSQLProvider } from './collectors/custom-sql.provider.js';

const provider = new CustomSQLProvider();
const pgOn = process.env.MAX376_PG_ACCEPTANCE === '1';
const mysqlOn = process.env.MAX376_MYSQL_ACCEPTANCE === '1';
const oracleOn = process.env.MAX376_ORACLE_ACCEPTANCE === '1';
const damengOn = process.env.MAX376_DAMENG_ACCEPTANCE === '1';

interface Endpoint {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  service?: string;
}

function endpoint(prefix: string, port: number, database = false, service = false): Endpoint {
  const host = process.env[`${prefix}_HOST`] ?? '';
  const parsedPort = Number(process.env[`${prefix}_PORT`]);
  const user = process.env[`${prefix}_USER`] ?? '';
  const password = process.env[`${prefix}_PASSWORD`] ?? '';
  const databaseName = process.env[`${prefix}_DATABASE`] ?? '';
  const serviceName = process.env[`${prefix}_SERVICE`] ?? '';
  if (!host || parsedPort !== port || !user || !password || (database && !databaseName) || (service && !serviceName)) {
    throw new Error(`${prefix}_ACCEPTANCE=1 requires ${prefix}_HOST, ${prefix}_PORT=${port}, ${prefix}_USER, ${prefix}_PASSWORD${database ? `, ${prefix}_DATABASE` : ''}${service ? `, ${prefix}_SERVICE` : ''}`);
  }
  return { host, port: parsedPort, user, password, database: databaseName || undefined, service: serviceName || undefined };
}

if (pgOn) endpoint('MAX376_PG', 5432, true);
if (mysqlOn) endpoint('MAX376_MYSQL', 3308);
if (oracleOn) endpoint('MAX376_ORACLE', 1521, false, true);
if (damengOn) endpoint('MAX376_DAMENG', 5236);

const OWNED_NAME = {
  pg: /^slide_max376_[a-f0-9]{32}$/,
  mysql: /^slide_max376_[a-f0-9]{32}$/,
  oracle: /^M376_[A-F0-9]{24}$/,
  dameng: /^M376_[A-F0-9]{24}$/,
} as const;

type OwnedDialect = keyof typeof OWNED_NAME;

interface OwnedSession {
  create(dialect: OwnedDialect, name: string, create: () => Promise<unknown>): Promise<void>;
}

interface OwnedCleanup {
  drop: (name: string) => Promise<void>;
  close: () => Promise<void>;
}

function exclusiveOwnedName(dialect: OwnedDialect): string {
  const name = dialect === 'oracle' || dialect === 'dameng'
    ? `M376_${randomBytes(12).toString('hex').toUpperCase()}`
    : `slide_max376_${randomBytes(16).toString('hex')}`;
  assertOwnedName(dialect, name);
  return name;
}

function assertOwnedName(dialect: OwnedDialect, name: string): void {
  if (!OWNED_NAME[dialect].test(name)) throw new Error(`refusing unsafe ${dialect} identifier`);
}

function ownedIdent(dialect: OwnedDialect, name: string): string {
  assertOwnedName(dialect, name);
  return dialect === 'mysql' ? `\`${name}\`` : name;
}

function assertRecordedName(name: string): void {
  const allowed = (Object.keys(OWNED_NAME) as OwnedDialect[]).some((dialect) => OWNED_NAME[dialect].test(name));
  if (!allowed) throw new Error('refusing unsafe identifier');
}

async function releaseOwned(
  state: { owned: readonly string[]; businessError?: unknown },
  actions: OwnedCleanup,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  try {
    for (const name of [...state.owned].reverse()) {
      try {
        assertRecordedName(name);
        await actions.drop(name);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  } finally {
    try {
      await actions.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (state.businessError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([state.businessError, ...cleanupErrors], 'business failed and cleanup failed');
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'cleanup failed');
  if (state.businessError !== undefined) throw state.businessError;
}

async function runOwnedSession(
  actions: OwnedCleanup & { body: (session: OwnedSession) => Promise<void> },
): Promise<void> {
  const owned: string[] = [];
  let businessError: unknown;
  try {
    await actions.body({
      async create(dialect, name, create) {
        assertOwnedName(dialect, name);
        await create();
        owned.push(name);
      },
    });
  } catch (error) {
    businessError = error;
  }
  await releaseOwned({ owned, businessError }, actions);
}

/**
 * Oracle's known provider result for `SELECT 1 FROM DUAL` is ORA-00923 from the
 * existing scalar wrapper. A real 1 is also accepted. Any other ORA is not.
 */
function oracleCollectionReadAccepted(outcome: string): boolean {
  if (outcome === 'value:1') return true;
  if (!outcome.startsWith('error:') || !outcome.includes('ORA-00923')) return false;
  return !/ORA-(?!00923)\d+/.test(outcome);
}

function damengCollectionReadAccepted(outcome: string): boolean {
  return outcome === 'value:1';
}

function definition(sql: string, dbType: string): MetricDefinition {
  return {
    id: 'max376.custom',
    name: 'max376',
    description: '',
    unit: 'count',
    db_types: [dbType],
    aggregation: 'last',
    default_interval: 60,
    is_collected: true,
    is_builtin: false,
    collection_sqls: { [dbType]: sql },
  };
}

function instance(dbType: string, fields: Partial<DatabaseConnection>): DatabaseConnection {
  return {
    id: 376,
    name: 'max376-acceptance',
    config: { host: 'injected', port: 1, user: 'injected', password: 'injected', db_type: dbType },
    pool: null,
    pgClient: null,
    oracleConnection: null,
    oraclePool: null,
    dmConnection: null,
    connected: true,
    db_type: dbType,
    ...fields,
  };
}

function messages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.map((item) => item instanceof Error ? item.message : String(item));
  return [error instanceof Error ? error.message : String(error)];
}

describe('MAX-376 owned cleanup', () => {
  it('keeps a pre-existing sentinel when CREATE fails and still closes', async () => {
    const sentinel = 'sentinel_existing';
    const dropped: string[] = [];
    const events: string[] = [];
    const failure = new Error(`schema "${sentinel}" already exists`);
    let caught: unknown;
    try {
      await runOwnedSession({
        async drop(name) { dropped.push(name); },
        async close() { events.push('close'); },
        async body(session) {
          events.push('open');
          await session.create('pg', exclusiveOwnedName('pg'), async () => { throw failure; });
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(dropped).toEqual([]);
    expect(events).toEqual(['open', 'close']);
  });

  it('refuses a sentinel or pid-only name before CREATE or DROP', async () => {
    const dropped: string[] = [];
    let createCalled = false;
    let caught: unknown;
    try {
      await runOwnedSession({
        async drop(name) { dropped.push(name); },
        async close() {},
        async body(session) {
          await session.create('pg', 'sentinel_existing', async () => { createCalled = true; });
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(messages(caught)).toEqual(['refusing unsafe pg identifier']);
    expect(createCalled).toBe(false);
    expect(dropped).toEqual([]);

    let released: unknown;
    try {
      await releaseOwned({ owned: ['SENTINEL_EXISTING', `slide_max376_${process.pid}`] }, {
        async drop(name) { dropped.push(name); },
        async close() {},
      });
    } catch (error) {
      released = error;
    }
    expect(messages(released)[0]).toBe('refusing unsafe identifier');
    expect(dropped).toEqual([]);
  });

  it('drops a created object after a later failure and skips an unknown CREATE', async () => {
    const created = exclusiveOwnedName('mysql');
    const unknown = exclusiveOwnedName('mysql');
    const dropped: string[] = [];
    const later = new Error('insert failed');
    let caught: unknown;
    try {
      await runOwnedSession({
        async drop(name) { dropped.push(name); },
        async close() {},
        async body(session) {
          await session.create('mysql', created, async () => {});
          throw later;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(later);
    expect(dropped).toEqual([created]);

    dropped.length = 0;
    const unknownResult = new Error('CREATE result unknown');
    try {
      await runOwnedSession({
        async drop(name) { dropped.push(name); },
        async close() {},
        async body(session) {
          await session.create('mysql', created, async () => {});
          await session.create('mysql', unknown, async () => { throw unknownResult; });
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(unknownResult);
    expect(dropped).toEqual([created]);
    expect(dropped).not.toContain(unknown);
  });

  it('reports a DROP failure after closing the connection', async () => {
    const name = exclusiveOwnedName('oracle');
    const events: string[] = [];
    let caught: unknown;
    try {
      await runOwnedSession({
        async drop() {
          events.push('drop');
          throw new Error('drop denied');
        },
        async close() { events.push('close'); },
        async body(session) {
          await session.create('oracle', name, async () => {});
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(messages(caught)).toEqual(['drop denied']);
    expect(events).toEqual(['drop', 'close']);
  });

  it('retains the first business error and the cleanup errors', async () => {
    const name = exclusiveOwnedName('dameng');
    const events: string[] = [];
    let caught: unknown;
    try {
      await runOwnedSession({
        async drop() {
          events.push('drop');
          throw new Error('drop denied');
        },
        async close() {
          events.push('close');
          throw new Error('close denied');
        },
        async body(session) {
          await session.create('dameng', name, async () => {});
          throw new Error('later failure');
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).message).toBe('business failed and cleanup failed');
    expect(messages(caught)).toEqual(['later failure', 'drop denied', 'close denied']);
    expect(events).toEqual(['drop', 'close']);
  });

  it('accepts only Oracle ORA-00923 or a real 1, and requires Dameng to return 1', () => {
    expect(oracleCollectionReadAccepted('value:1')).toBe(true);
    expect(oracleCollectionReadAccepted('error:ORA-00923: FROM keyword not found where expected')).toBe(true);
    expect(oracleCollectionReadAccepted('error:ORA-00942: table or view does not exist')).toBe(false);
    expect(oracleCollectionReadAccepted('error:ORA-00923 followed by ORA-01756')).toBe(false);
    expect(oracleCollectionReadAccepted('error:LIMIT syntax')).toBe(false);
    expect(oracleCollectionReadAccepted('value:2')).toBe(false);
    expect(damengCollectionReadAccepted('value:1')).toBe(true);
    expect(damengCollectionReadAccepted('error:语法分析出错')).toBe(false);
    expect(damengCollectionReadAccepted('error:LIMIT syntax')).toBe(false);
    expect(damengCollectionReadAccepted('value:0')).toBe(false);
  });
});

describe.skipIf(!pgOn)('MAX-376 real PostgreSQL custom collection', () => {
  it('returns ILIKE, cast and DISTINCT ON data and does not run a write', async () => {
    const profile = endpoint('MAX376_PG', 5432, true);
    const schema = exclusiveOwnedName('pg');
    const client = new PgClient({
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password: profile.password,
      database: profile.database,
      connectionTimeoutMillis: 10_000,
    });
    await runOwnedSession({
      async drop(name) {
        await client.query(`DROP SCHEMA ${ownedIdent('pg', name)} CASCADE`);
        const found = await client.query(
          'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1',
          [name],
        );
        if ((found.rowCount ?? 0) > 0) throw new Error(`owned schema ${name} remained after DROP`);
      },
      close: () => client.end(),
      async body(session) {
        await client.connect();
        await session.create('pg', schema, async () => {
          await client.query(`CREATE SCHEMA ${ownedIdent('pg', schema)}`);
        });
        await client.query(`CREATE TABLE ${ownedIdent('pg', schema)}.samples (id integer PRIMARY KEY, name text NOT NULL, score integer NOT NULL)`);
        await client.query(`INSERT INTO ${ownedIdent('pg', schema)}.samples (id, name, score) VALUES (1, 'alpha', 7), (2, 'beta', 8)`);
        const connection = instance('postgresql', { pgClient: client });

        const ilike = await provider.collect(connection, definition(
          `SELECT score FROM ${ownedIdent('pg', schema)}.samples WHERE name ILIKE 'a%'`,
          'postgresql',
        ));
        const cast = await provider.collect(connection, definition("SELECT '42'::int", 'postgresql'));
        const distinct = await provider.collect(connection, definition(
          `SELECT COUNT(*) FROM (SELECT DISTINCT ON (id) id FROM ${ownedIdent('pg', schema)}.samples) distinct_ids`,
          'postgresql',
        ));
        const write = await provider.collect(connection, definition(
          `WITH written AS (INSERT INTO ${ownedIdent('pg', schema)}.samples (id, name, score) VALUES (9, 'gone', 0) RETURNING id) SELECT id FROM written`,
          'postgresql',
        ));
        const count = await client.query<{ rows: string }>(`SELECT COUNT(*)::int AS rows FROM ${ownedIdent('pg', schema)}.samples`);

        expect(ilike).toBe(7);
        expect(cast).toBe(42);
        expect(distinct).toBe(2);
        expect(write).toBeNull();
        expect(Number(count.rows[0]?.rows)).toBe(2);
      },
    });
  }, 60_000);
});

describe.skipIf(!mysqlOn)('MAX-376 real MySQL custom collection gate', () => {
  it('returns a read and leaves the table unchanged for a write and an escape bypass', async () => {
    const profile = endpoint('MAX376_MYSQL', 3308);
    const databaseName = exclusiveOwnedName('mysql');
    const pool = mysql.createPool({
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password: profile.password,
      connectionLimit: 2,
    });
    await runOwnedSession({
      async drop(name) {
        const ident = ownedIdent('mysql', name);
        await pool.query(`DROP DATABASE ${ident}`);
        const [rows] = await pool.query<RowDataPacket[]>(
          'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
          [name],
        );
        if (rows.length > 0) throw new Error(`owned database ${name} remained after DROP`);
      },
      close: () => pool.end(),
      async body(session) {
        const ident = ownedIdent('mysql', databaseName);
        await session.create('mysql', databaseName, async () => {
          await pool.query(`CREATE DATABASE ${ident}`);
        });
        await pool.query(`CREATE TABLE ${ident}.samples (id INT PRIMARY KEY, name VARCHAR(32))`);
        await pool.query(`INSERT INTO ${ident}.samples (id, name) VALUES (1, 'alpha')`);
        const connection = instance('mysql', { pool });

        const read = await provider.collect(connection, definition(
          `SELECT COUNT(*) FROM ${ident}.samples`,
          'mysql',
        ));
        const write = await provider.collect(connection, definition(
          `INSERT INTO ${ident}.samples (id, name) VALUES (9, 'gone')`,
          'mysql',
        ));
        const bypass = await provider.collect(connection, definition(
          "SELECT 'a\\' , SLEEP(0) AS executed -- '",
          'mysql',
        ));
        const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS sample_count FROM ${ident}.samples`);

        expect(read).toBe(1);
        expect(write).toBeNull();
        expect(bypass).toBeNull();
        expect(Number(rows[0]?.sample_count)).toBe(1);
      },
    });
  }, 60_000);
});

interface VendorConnection {
  execute: (sql: string, binds?: unknown, options?: { autoCommit?: boolean; maxRows?: number }) => Promise<{ rows?: unknown[][] }>;
  close: () => Promise<void>;
}

async function assertVendorTableGone(connection: VendorConnection, dialect: 'oracle' | 'dameng', name: string): Promise<void> {
  const ident = ownedIdent(dialect, name);
  try {
    await connection.execute(`SELECT COUNT(*) FROM ${ident}`, [], { autoCommit: true, maxRows: 1 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ORA-00942|不存在|无效的表或视图|无效的表名/.test(message)) return;
    throw error;
  }
  throw new Error(`owned table ${name} remained after DROP`);
}

describe.skipIf(!oracleOn)('MAX-376 real Oracle custom collection gate', () => {
  it('keeps Dual readable and does not execute PostgreSQL syntax or a write', async () => {
    const oracledb = await import('oracledb');
    const oracleDriver = oracledb.default ?? oracledb;
    const profile = endpoint('MAX376_ORACLE', 1521, false, true);
    const table = exclusiveOwnedName('oracle');
    const connectString = `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${profile.host})(PORT=${profile.port}))(CONNECT_DATA=(SERVICE_NAME=${profile.service})))`;
    let connection: VendorConnection | undefined;
    await runOwnedSession({
      async drop(name) {
        if (!connection) throw new Error('DROP without an Oracle connection');
        await connection.execute(`DROP TABLE ${ownedIdent('oracle', name)}`, [], { autoCommit: true });
        await assertVendorTableGone(connection, 'oracle', name);
      },
      async close() { if (connection) await connection.close(); },
      async body(session) {
        connection = await oracleDriver.getConnection({
          user: profile.user,
          password: profile.password,
          connectString,
        });
        await session.create('oracle', table, async () => {
          await connection!.execute(`CREATE TABLE ${ownedIdent('oracle', table)} (id NUMBER PRIMARY KEY)`, [], { autoCommit: true });
        });
        await connection.execute(`INSERT INTO ${ownedIdent('oracle', table)} (id) VALUES (1)`, [], { autoCommit: true });
        const target = instance('oracle', { oracleConnection: connection as DatabaseConnection['oracleConnection'] });

        const readOutcome = await provider.collect(target, definition('SELECT 1 FROM DUAL', 'oracle')).then(
          (value) => `value:${value}`,
          (error: { message?: string }) => `error:${error.message ?? 'oracle-read-failed'}`,
        );
        const ilike = await provider.collect(target, definition("SELECT * FROM t WHERE name ILIKE 'a%'", 'oracle'));
        const write = await provider.collect(target, definition(`INSERT INTO ${ownedIdent('oracle', table)} (id) VALUES (9)`, 'oracle'));
        const check = await connection.execute(`SELECT COUNT(*) FROM ${ownedIdent('oracle', table)}`);
        const direct = await connection.execute('SELECT 1 FROM DUAL');

        expect(ilike).toBeNull();
        expect(write).toBeNull();
        expect(Number(check.rows?.[0]?.[0])).toBe(1);
        expect(Number(direct.rows?.[0]?.[0])).toBe(1);
        expect(oracleCollectionReadAccepted(readOutcome), readOutcome).toBe(true);
      },
    });
  }, 60_000);
});

describe.skipIf(!damengOn)('MAX-376 real Dameng custom collection gate', () => {
  it('keeps Dual readable and does not execute PostgreSQL syntax or a write', async () => {
    const dmdb = await import('dmdb');
    const damengDriver = dmdb.default ?? dmdb;
    const profile = endpoint('MAX376_DAMENG', 5236);
    const table = exclusiveOwnedName('dameng');
    let connection: VendorConnection | undefined;
    await runOwnedSession({
      async drop(name) {
        if (!connection) throw new Error('DROP without a Dameng connection');
        await connection.execute(`DROP TABLE ${ownedIdent('dameng', name)}`, [], { autoCommit: true });
        await assertVendorTableGone(connection, 'dameng', name);
      },
      async close() { if (connection) await connection.close(); },
      async body(session) {
        connection = await damengDriver.getConnection({
          user: profile.user,
          password: profile.password,
          connectString: `${profile.host}:${profile.port}`,
          connectTimeout: 5000,
          loginEncrypt: false,
          socketTimeout: 30_000,
        });
        await session.create('dameng', table, async () => {
          await connection!.execute(`CREATE TABLE ${ownedIdent('dameng', table)} (id INT PRIMARY KEY)`, [], { autoCommit: true });
        });
        await connection.execute(`INSERT INTO ${ownedIdent('dameng', table)} (id) VALUES (1)`, [], { autoCommit: true });
        const target = instance('dameng', { dmConnection: connection as DatabaseConnection['dmConnection'] });

        const readOutcome = await provider.collect(target, definition('SELECT 1 FROM DUAL', 'dameng')).then(
          (value) => `value:${value}`,
          (error: { message?: string }) => `error:${error.message ?? 'dameng-read-failed'}`,
        );
        const distinct = await provider.collect(target, definition('SELECT DISTINCT ON (id) id FROM t', 'dameng'));
        const write = await provider.collect(target, definition(`INSERT INTO ${ownedIdent('dameng', table)} (id) VALUES (9)`, 'dameng'));
        const check = await connection.execute(`SELECT COUNT(*) FROM ${ownedIdent('dameng', table)}`, [], { maxRows: 1, autoCommit: true });
        const direct = await connection.execute('SELECT 1 FROM DUAL', [], { maxRows: 1, autoCommit: true });

        expect(distinct).toBeNull();
        expect(write).toBeNull();
        expect(Number(check.rows?.[0]?.[0])).toBe(1);
        expect(Number(direct.rows?.[0]?.[0])).toBe(1);
        expect(damengCollectionReadAccepted(readOutcome), readOutcome).toBe(true);
        expect(readOutcome).toBe('value:1');
      },
    });
  }, 60_000);
});
