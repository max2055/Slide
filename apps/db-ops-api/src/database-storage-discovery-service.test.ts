import { describe, expect, it, vi } from 'vitest';
import {
  DatabaseStorageDiscoveryService,
  databaseStorageDiscoveryService,
  type DatabaseStorageConnectionProvider,
  type DatabaseStorageMetadataProvider,
} from './database-storage-discovery-service.js';

const MYSQL_DATADIR_SQL = 'SELECT @@GLOBAL.datadir AS path';
const MYSQL_FILES_SQL = "SELECT FILE_NAME, TABLESPACE_NAME, FILE_TYPE FROM INFORMATION_SCHEMA.FILES WHERE FILE_NAME IS NOT NULL AND FILE_TYPE IN ('TABLESPACE', 'DATAFILE', 'UNDO LOG', 'TEMPORARY') ORDER BY TABLESPACE_NAME, FILE_NAME LIMIT 128";
const POSTGRES_METADATA_SQL = "SELECT current_setting('data_directory') AS data_directory, current_setting('server_version_num') AS server_version_num";
const POSTGRES_TABLESPACES_SQL = "SELECT spcname AS tablespace_name, pg_tablespace_location(oid) AS path FROM pg_tablespace WHERE pg_tablespace_location(oid) <> '' ORDER BY spcname LIMIT 128";
const POSTGRES_RELATIONS_SQL = 'SELECT schemaname AS schema_name, relname AS object_name, pg_relation_filepath(relid) AS path, pg_total_relation_size(relid) AS logical_bytes FROM pg_stat_user_tables WHERE pg_relation_filepath(relid) IS NOT NULL ORDER BY pg_total_relation_size(relid) DESC, schemaname, relname LIMIT 32';
const ORACLE_DATA_FILES_SQL = 'SELECT FILE_NAME, TABLESPACE_NAME, BYTES FROM (SELECT FILE_NAME, TABLESPACE_NAME, BYTES FROM DBA_DATA_FILES ORDER BY TABLESPACE_NAME, FILE_NAME) WHERE ROWNUM <= 128';
const ORACLE_TEMP_FILES_SQL = 'SELECT FILE_NAME, TABLESPACE_NAME, BYTES FROM (SELECT FILE_NAME, TABLESPACE_NAME, BYTES FROM DBA_TEMP_FILES ORDER BY TABLESPACE_NAME, FILE_NAME) WHERE ROWNUM <= 128';
const ORACLE_LOG_FILES_SQL = 'SELECT MEMBER FROM (SELECT MEMBER FROM V$LOGFILE ORDER BY MEMBER) WHERE ROWNUM <= 128';
const ORACLE_CONTROL_FILES_SQL = 'SELECT NAME FROM (SELECT NAME FROM V$CONTROLFILE ORDER BY NAME) WHERE ROWNUM <= 128';
const DAMENG_DATA_FILES_SQL = 'SELECT FILE_NAME, TABLESPACE_NAME, BYTES FROM DBA_DATA_FILES ORDER BY FILE_ID FETCH FIRST 128 ROWS ONLY';

function createService(
  connection: Record<string, unknown>,
  alive: boolean | Error = true,
  databaseType: string | null | Error = typeof connection.db_type === 'string'
    ? connection.db_type
    : null,
) {
  const ensureConnectionAlive = vi.fn(async () => {
    if (alive instanceof Error) throw alive;
    return alive;
  });
  const getConnection = vi.fn(() => connection as never);
  const getDatabaseType = vi.fn(async () => {
    if (databaseType instanceof Error) throw databaseType;
    return databaseType;
  });
  const provider: DatabaseStorageConnectionProvider = {
    ensureConnectionAlive,
    getConnection,
  };
  const metadataProvider: DatabaseStorageMetadataProvider = { getDatabaseType };

  return {
    service: new DatabaseStorageDiscoveryService(provider, metadataProvider),
    ensureConnectionAlive,
    getConnection,
    getDatabaseType,
  };
}

function oracleResult(rows: unknown[][], columns: string[]) {
  return {
    rows,
    metaData: columns.map((name) => ({ name })),
  };
}

function repeatRows(row: unknown[], count = 128): unknown[][] {
  return Array.from({ length: count }, () => [...row]);
}

describe('DatabaseStorageDiscoveryService', () => {
  it('exports a production-ready default instance', () => {
    expect(databaseStorageDiscoveryService).toBeInstanceOf(DatabaseStorageDiscoveryService);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid instance id %s before accessing the provider',
    async (instanceId) => {
      const { service, ensureConnectionAlive, getConnection, getDatabaseType } = createService({ db_type: 'mysql' });

      await expect(service.discover(instanceId)).rejects.toMatchObject({
        code: 'STORAGE_DISCOVERY_INVALID_INSTANCE_ID',
      });
      expect(getDatabaseType).not.toHaveBeenCalled();
      expect(ensureConnectionAlive).not.toHaveBeenCalled();
      expect(getConnection).not.toHaveBeenCalled();
    },
  );

  it.each<[string, boolean | Error]>([
    ['health probe returned false', false],
    ['health probe failed', new Error('socket closed')],
  ])('uses a stable error code when the connection is unavailable: %s', async (_label, alive) => {
    const { service, getConnection } = createService({ db_type: 'mysql' }, alive);

    await expect(service.discover(7)).rejects.toMatchObject({
      code: 'STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE',
    });
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('uses a stable error code when the live connection disappears', async () => {
    const provider: DatabaseStorageConnectionProvider = {
      ensureConnectionAlive: vi.fn(async () => true),
      getConnection: vi.fn(() => null),
    };

    const metadataProvider: DatabaseStorageMetadataProvider = {
      getDatabaseType: vi.fn(async () => 'mysql'),
    };

    await expect(new DatabaseStorageDiscoveryService(provider, metadataProvider).discover(8)).rejects.toMatchObject({
      code: 'STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE',
    });
  });

  it('uses a stable error code when reading the live connection fails', async () => {
    const provider: DatabaseStorageConnectionProvider = {
      ensureConnectionAlive: vi.fn(async () => true),
      getConnection: vi.fn(() => {
        throw new Error('connection registry unavailable');
      }),
    };

    const metadataProvider: DatabaseStorageMetadataProvider = {
      getDatabaseType: vi.fn(async () => 'mysql'),
    };

    await expect(new DatabaseStorageDiscoveryService(provider, metadataProvider).discover(9)).rejects.toMatchObject({
      code: 'STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE',
    });
  });

  it('returns an unsupported capability gap without consulting the connection registry', async () => {
    const ensureConnectionAlive = vi.fn(async () => false);
    const getConnection = vi.fn(() => null);
    const getDatabaseType = vi.fn(async () => 'mongodb');
    const service = new DatabaseStorageDiscoveryService(
      { ensureConnectionAlive, getConnection },
      { getDatabaseType },
    );

    await expect(service.discover(11)).resolves.toEqual({
      descriptors: [],
      gaps: [{ code: 'STORAGE_DISCOVERY_UNSUPPORTED', source: 'mongodb' }],
    });
    expect(getDatabaseType).toHaveBeenCalledWith(11);
    expect(ensureConnectionAlive).not.toHaveBeenCalled();
    expect(getConnection).not.toHaveBeenCalled();
  });

  it.each<[string, null | Error]>([
    ['instance metadata is absent', null],
    ['instance metadata lookup fails', new Error('metadata store unavailable')],
  ])('uses a stable error when %s', async (_label, metadataResult) => {
    const { service, ensureConnectionAlive, getConnection } = createService(
      { db_type: 'mysql' },
      true,
      metadataResult,
    );

    await expect(service.discover(12)).rejects.toMatchObject({
      code: 'STORAGE_DISCOVERY_METADATA_UNAVAILABLE',
    });
    expect(ensureConnectionAlive).not.toHaveBeenCalled();
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('discovers the MySQL datadir and resolves relative files without allowing escape', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === MYSQL_DATADIR_SQL) {
        return [[{ path: '/var/lib/mysql/' }], [{ name: 'path' }]];
      }
      if (sql === MYSQL_FILES_SQL) {
        return [[
          { FILE_NAME: 'ibdata1', TABLESPACE_NAME: 'innodb_system', FILE_TYPE: 'DATAFILE' },
          { FILE_NAME: './db_ops_ai/orders.ibd', TABLESPACE_NAME: 'db_ops_ai/orders', FILE_TYPE: 'TABLESPACE' },
          { FILE_NAME: 'undo/undo_001', TABLESPACE_NAME: 'innodb_undo_001', FILE_TYPE: 'UNDO LOG' },
          { FILE_NAME: '#innodb_temp/temp_1.ibt', TABLESPACE_NAME: 'innodb_temporary', FILE_TYPE: 'TEMPORARY' },
          { FILE_NAME: '/mnt/mysql/archive.ibd', TABLESPACE_NAME: 'archive', FILE_TYPE: 'DATAFILE' },
          { FILE_NAME: '../escape.ibd', TABLESPACE_NAME: 'escaped', FILE_TYPE: 'DATAFILE' },
        ], []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const { service } = createService({ db_type: 'mysql', pool: { query } });

    const result = await service.discover(12);

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([MYSQL_DATADIR_SQL, MYSQL_FILES_SQL]);
    expect(result.descriptors).toEqual([
      {
        path: '/mnt/mysql/archive.ibd',
        kind: 'data-file',
        source: 'mysql.information_schema.files',
        hostInspectable: true,
        tablespace: 'archive',
      },
      {
        path: '/var/lib/mysql',
        kind: 'data-directory',
        source: 'mysql.datadir',
        hostInspectable: true,
      },
      {
        path: '/var/lib/mysql/#innodb_temp/temp_1.ibt',
        kind: 'temp-file',
        source: 'mysql.information_schema.files',
        hostInspectable: true,
        tablespace: 'innodb_temporary',
      },
      {
        path: '/var/lib/mysql/db_ops_ai/orders.ibd',
        kind: 'data-file',
        source: 'mysql.information_schema.files',
        hostInspectable: true,
        tablespace: 'db_ops_ai/orders',
      },
      {
        path: '/var/lib/mysql/ibdata1',
        kind: 'data-file',
        source: 'mysql.information_schema.files',
        hostInspectable: true,
        tablespace: 'innodb_system',
      },
      {
        path: '/var/lib/mysql/undo/undo_001',
        kind: 'undo-log',
        source: 'mysql.information_schema.files',
        hostInspectable: true,
        tablespace: 'innodb_undo_001',
      },
    ]);
    expect(result.gaps).toContainEqual({
      code: 'STORAGE_DISCOVERY_INVALID_PATH',
      source: 'mysql.information_schema.files',
    });
    expect(result.descriptors.some(({ path }) => path.includes('escape'))).toBe(false);
  });

  it('discovers PostgreSQL data, tablespace, relation, and WAL paths', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === POSTGRES_METADATA_SQL) {
        return { rows: [{ data_directory: '/var/lib/postgresql/16/main', server_version_num: '160002' }] };
      }
      if (sql === POSTGRES_TABLESPACES_SQL) {
        return { rows: [{ tablespace_name: 'fast', path: '/mnt/postgresql/fast' }] };
      }
      if (sql === POSTGRES_RELATIONS_SQL) {
        return { rows: [{
          schema_name: 'public',
          object_name: 'orders',
          path: 'base/16384/24576',
          logical_bytes: '8192',
        }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const { service } = createService({ db_type: 'postgresql', pgClient: { query } });

    const result = await service.discover(13);

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      POSTGRES_METADATA_SQL,
      POSTGRES_TABLESPACES_SQL,
      POSTGRES_RELATIONS_SQL,
    ]);
    expect(result.descriptors).toEqual(expect.arrayContaining([
      {
        path: '/var/lib/postgresql/16/main',
        kind: 'data-directory',
        source: 'postgresql.data_directory',
        hostInspectable: true,
      },
      {
        path: '/var/lib/postgresql/16/main/pg_wal',
        kind: 'write-ahead-log',
        source: 'postgresql.wal',
        hostInspectable: true,
      },
      {
        path: '/mnt/postgresql/fast',
        kind: 'tablespace',
        source: 'postgresql.pg_tablespace',
        hostInspectable: true,
        tablespace: 'fast',
      },
      {
        path: '/var/lib/postgresql/16/main/base/16384/24576',
        kind: 'relation',
        source: 'postgresql.pg_stat_user_tables',
        hostInspectable: true,
        objectName: 'public.orders',
        logicalBytes: 8192,
      },
    ]));
    expect(result.descriptors.map(({ path }) => path).sort()).toEqual(
      result.descriptors.map(({ path }) => path),
    );
    expect(result.gaps).toEqual([]);
  });

  it('uses pg_xlog for PostgreSQL 9.x', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ path: '/srv/postgresql/9.6', version_num: 90624 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { service } = createService({ db_type: 'postgresql', pgClient: { query } });

    const result = await service.discover(14);

    expect(result.descriptors).toContainEqual({
      path: '/srv/postgresql/9.6/pg_xlog',
      kind: 'write-ahead-log',
      source: 'postgresql.wal',
      hostInspectable: true,
    });
    expect(result.descriptors.some(({ path }) => path.endsWith('/pg_wal'))).toBe(false);
  });

  it('filters null PostgreSQL relation paths before applying the top-32 sample', async () => {
    const validRelations = Array.from({ length: 33 }, (_, index) => ({
      schema_name: 'public',
      object_name: `relation_${index}`,
      path: `base/1/${index}`,
      logical_bytes: 10_000 - index,
    }));
    const query = vi.fn(async (sql: string) => {
      if (sql === POSTGRES_METADATA_SQL) {
        return { rows: [{ data_directory: '/pg', server_version_num: 160000 }] };
      }
      if (sql === POSTGRES_TABLESPACES_SQL) return { rows: [] };
      if (sql.includes('FROM pg_stat_user_tables')) {
        const candidates = [{
          schema_name: 'public',
          object_name: 'null_path',
          path: null,
          logical_bytes: 20_000,
        }, ...validRelations];
        const eligible = sql.includes('WHERE pg_relation_filepath(relid) IS NOT NULL')
          ? candidates.filter(({ path }) => path !== null)
          : candidates;
        return { rows: eligible.slice(0, 32) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const { service } = createService({ db_type: 'postgresql', pgClient: { query } });

    const result = await service.discover(15);

    expect(query.mock.calls.map(([sql]) => sql)).toContain(POSTGRES_RELATIONS_SQL);
    expect(result.descriptors.filter(({ kind }) => kind === 'relation')).toHaveLength(32);
    expect(result.descriptors).toContainEqual(expect.objectContaining({
      path: '/pg/base/1/31',
      objectName: 'public.relation_31',
    }));
    expect(result.gaps).not.toContainEqual({
      code: 'STORAGE_DISCOVERY_INVALID_PATH',
      source: 'postgresql.pg_stat_user_tables',
    });
    expect(result.gaps).not.toContainEqual({
      code: 'STORAGE_DISCOVERY_LIMIT_REACHED',
      source: 'postgresql.pg_stat_user_tables',
    });
  });

  it('degrades Oracle query classes independently and preserves ASM paths', async () => {
    const execute = vi.fn(async (sql: string) => {
      if (sql === ORACLE_DATA_FILES_SQL) {
        return oracleResult(
          [['+DATA/ORCL/DATAFILE/system.256.123', 'SYSTEM', '1048576']],
          ['FILE_NAME', 'TABLESPACE_NAME', 'BYTES'],
        );
      }
      if (sql === ORACLE_TEMP_FILES_SQL) throw new Error('ORA-00942');
      if (sql === ORACLE_LOG_FILES_SQL) {
        return { rows: [{ MEMBER: '/u02/oradata/redo01.log' }] };
      }
      if (sql === ORACLE_CONTROL_FILES_SQL) {
        return oracleResult([['/u02/oradata/control01.ctl']], ['NAME']);
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const { service } = createService({ db_type: 'oracle', oracleConnection: { execute } });

    const result = await service.discover(15);

    expect(execute.mock.calls.map(([sql]) => sql)).toEqual([
      ORACLE_DATA_FILES_SQL,
      ORACLE_TEMP_FILES_SQL,
      ORACLE_LOG_FILES_SQL,
      ORACLE_CONTROL_FILES_SQL,
    ]);
    expect(result.descriptors).toEqual(expect.arrayContaining([
      {
        path: '+DATA/ORCL/DATAFILE/system.256.123',
        kind: 'data-file',
        source: 'oracle.dba_data_files',
        hostInspectable: false,
        tablespace: 'SYSTEM',
        logicalBytes: 1048576,
      },
      {
        path: '/u02/oradata/redo01.log',
        kind: 'redo-log',
        source: 'oracle.v_logfile',
        hostInspectable: true,
      },
      {
        path: '/u02/oradata/control01.ctl',
        kind: 'control-file',
        source: 'oracle.v_controlfile',
        hostInspectable: true,
      },
    ]));
    expect(result.gaps).toContainEqual({
      code: 'STORAGE_DISCOVERY_QUERY_FAILED',
      source: 'oracle.dba_temp_files',
    });
  });

  it('reads Dameng array rows and validates logical byte values', async () => {
    const execute = vi.fn(async () => ({
      rows: [
        ['/opt/dmdb/data/MAIN.DBF', 'MAIN', '4096'],
        ['/opt/dmdb/data/NEGATIVE.DBF', 'MAIN', -1],
        ['/opt/dmdb/data/NAN.DBF', 'MAIN', 'not-a-number'],
      ],
    }));
    const { service } = createService({ db_type: 'dameng', dmConnection: { execute } });

    const result = await service.discover(16);

    expect(execute).toHaveBeenCalledWith(DAMENG_DATA_FILES_SQL);
    expect(result.descriptors).toContainEqual({
      path: '/opt/dmdb/data/MAIN.DBF',
      kind: 'data-file',
      source: 'dameng.dba_data_files',
      hostInspectable: true,
      tablespace: 'MAIN',
      logicalBytes: 4096,
    });
    for (const path of ['/opt/dmdb/data/NEGATIVE.DBF', '/opt/dmdb/data/NAN.DBF']) {
      expect(result.descriptors.find((descriptor) => descriptor.path === path)).not.toHaveProperty('logicalBytes');
    }
    expect(result.gaps).toContainEqual({
      code: 'STORAGE_DISCOVERY_INVALID_LOGICAL_BYTES',
      source: 'dameng.dba_data_files',
    });
  });

  it('rejects non-absolute, traversal, control-character, and overlong paths while normalizing duplicates', async () => {
    const overlong = `/${'界'.repeat(1366)}`;
    const execute = vi.fn(async (sql: string) => {
      if (sql === ORACLE_DATA_FILES_SQL) {
        return oracleResult([
          ['relative/users01.dbf', 'USERS', 1],
          ['/u01/oradata/../escape.dbf', 'USERS', 2],
          ['/u01/oradata/bad\u0000name.dbf', 'USERS', 3],
          ['/u01/oradata/bad\u0085name.dbf', 'USERS', 3],
          [overlong, 'USERS', 4],
          ['/u01/oradata//users/./users01.dbf', 'USERS', 5],
          ['/u01/oradata/users/users01.dbf', 'USERS', 6],
        ], ['FILE_NAME', 'TABLESPACE_NAME', 'BYTES']);
      }
      return { rows: [] };
    });
    const { service } = createService({ db_type: 'oracle', oracleConnection: { execute } });

    const result = await service.discover(17);

    expect(result.descriptors).toEqual([{
      path: '/u01/oradata/users/users01.dbf',
      kind: 'data-file',
      source: 'oracle.dba_data_files',
      hostInspectable: true,
      tablespace: 'USERS',
      logicalBytes: 5,
    }]);
    expect(result.gaps).toContainEqual({
      code: 'STORAGE_DISCOVERY_INVALID_PATH',
      source: 'oracle.dba_data_files',
    });
  });

  it('reports when MySQL storage rows reach the deterministic source limit', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === MYSQL_DATADIR_SQL) return [[{ path: '/mysql' }], []];
      return [[...repeatRows(['shared.ibd', 'shared', 'DATAFILE'])], []];
    });
    const { service } = createService({ db_type: 'mysql', pool: { query } });

    const result = await service.discover(18);

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([MYSQL_DATADIR_SQL, MYSQL_FILES_SQL]);
    expect(result.gaps).toContainEqual({
      code: 'STORAGE_DISCOVERY_LIMIT_REACHED',
      source: 'mysql.information_schema.files',
    });
    expect(result.gaps).not.toContainEqual({
      code: 'STORAGE_DISCOVERY_LIMIT_REACHED',
      source: 'database',
    });
  });

  it('reports when PostgreSQL tablespaces reach the deterministic source limit', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ data_directory: '/postgres', server_version_num: 160000 }] })
      .mockResolvedValueOnce({
        rows: Array.from({ length: 128 }, () => ({
          tablespace_name: 'shared',
          path: '/tablespaces/shared',
        })),
      })
      .mockResolvedValueOnce({ rows: [] });
    const { service } = createService({ db_type: 'postgresql', pgClient: { query } });

    const result = await service.discover(19);

    expect(result.gaps).toContainEqual({
      code: 'STORAGE_DISCOVERY_LIMIT_REACHED',
      source: 'postgresql.pg_tablespace',
    });
    expect(result.gaps).not.toContainEqual({
      code: 'STORAGE_DISCOVERY_LIMIT_REACHED',
      source: 'database',
    });
  });

  it('reports each Oracle query class that reaches its deterministic source limit', async () => {
    const execute = vi.fn(async (sql: string) => {
      if (sql === ORACLE_DATA_FILES_SQL) {
        return oracleResult(repeatRows(['/oracle/data.dbf']), ['FILE_NAME']);
      }
      if (sql === ORACLE_TEMP_FILES_SQL) {
        return oracleResult(repeatRows(['/oracle/temp.dbf']), ['FILE_NAME']);
      }
      if (sql === ORACLE_LOG_FILES_SQL) {
        return oracleResult(repeatRows(['/oracle/redo.log']), ['MEMBER']);
      }
      if (sql === ORACLE_CONTROL_FILES_SQL) {
        return oracleResult(repeatRows(['/oracle/control.ctl']), ['NAME']);
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const { service } = createService({ db_type: 'oracle', oracleConnection: { execute } });

    const result = await service.discover(20);

    expect(execute.mock.calls.map(([sql]) => sql)).toEqual([
      ORACLE_DATA_FILES_SQL,
      ORACLE_TEMP_FILES_SQL,
      ORACLE_LOG_FILES_SQL,
      ORACLE_CONTROL_FILES_SQL,
    ]);
    for (const source of [
      'oracle.dba_data_files',
      'oracle.dba_temp_files',
      'oracle.v_logfile',
      'oracle.v_controlfile',
    ]) {
      expect(result.gaps).toContainEqual({
        code: 'STORAGE_DISCOVERY_LIMIT_REACHED',
        source,
      });
    }
    expect(result.gaps).not.toContainEqual({
      code: 'STORAGE_DISCOVERY_LIMIT_REACHED',
      source: 'database',
    });
  });

  it('reports when Dameng data files reach the deterministic source limit', async () => {
    const execute = vi.fn(async (_sql: string) => ({
      rows: repeatRows(['/dm/data.dbf', 'MAIN', 4096]),
    }));
    const { service } = createService({ db_type: 'dameng', dmConnection: { execute } });

    const result = await service.discover(21);

    expect(execute).toHaveBeenCalledWith(DAMENG_DATA_FILES_SQL);
    expect(result.gaps).toContainEqual({
      code: 'STORAGE_DISCOVERY_LIMIT_REACHED',
      source: 'dameng.dba_data_files',
    });
    expect(result.gaps).not.toContainEqual({
      code: 'STORAGE_DISCOVERY_LIMIT_REACHED',
      source: 'database',
    });
  });

  it('applies a deterministic global limit of 128 descriptors', async () => {
    const rows = (prefix: string, count: number) => Array.from(
      { length: count },
      (_, index) => [`/${prefix}/${prefix}-${String(index).padStart(3, '0')}.dbf`],
    );
    const execute = vi.fn(async (sql: string) => {
      if (sql === ORACLE_DATA_FILES_SQL) {
        return oracleResult(rows('data', 60), ['FILE_NAME']);
      }
      if (sql === ORACLE_TEMP_FILES_SQL) {
        return oracleResult(rows('temp', 60), ['FILE_NAME']);
      }
      if (sql === ORACLE_LOG_FILES_SQL) {
        return oracleResult(rows('redo', 20), ['MEMBER']);
      }
      return oracleResult(rows('control', 20), ['NAME']);
    });
    const { service } = createService({ db_type: 'oracle', oracleConnection: { execute } });

    const result = await service.discover(18);

    expect(result.descriptors).toHaveLength(128);
    expect(result.descriptors.map(({ path }) => path)).toEqual(
      [...result.descriptors.map(({ path }) => path)].sort(),
    );
    expect(new Set(result.descriptors.map(({ path }) => path)).size).toBe(128);
    expect(result.gaps).toContainEqual({
      code: 'STORAGE_DISCOVERY_LIMIT_REACHED',
      source: 'database',
    });
  });

  it('executes only fixed, read-only, bounded SQL templates', async () => {
    const mysqlQuery = vi.fn()
      .mockResolvedValueOnce([[{ path: '/mysql' }], []])
      .mockResolvedValueOnce([[], []]);
    const pgQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ data_directory: '/postgres', server_version_num: 160000 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const oracleExecute = vi.fn(async (_sql: string) => ({ rows: [] }));
    const damengExecute = vi.fn(async (_sql: string) => ({ rows: [] }));

    await createService({ db_type: 'mysql', pool: { query: mysqlQuery } }).service.discover(19);
    await createService({ db_type: 'postgresql', pgClient: { query: pgQuery } }).service.discover(20);
    await createService({ db_type: 'oracle', oracleConnection: { execute: oracleExecute } }).service.discover(21);
    await createService({ db_type: 'dameng', dmConnection: { execute: damengExecute } }).service.discover(22);

    expect(mysqlQuery.mock.calls.map(([sql]) => sql)).toEqual([MYSQL_DATADIR_SQL, MYSQL_FILES_SQL]);
    expect(pgQuery.mock.calls.map(([sql]) => sql)).toEqual([
      POSTGRES_METADATA_SQL,
      POSTGRES_TABLESPACES_SQL,
      POSTGRES_RELATIONS_SQL,
    ]);
    expect(oracleExecute.mock.calls.map(([sql]) => sql)).toEqual([
      ORACLE_DATA_FILES_SQL,
      ORACLE_TEMP_FILES_SQL,
      ORACLE_LOG_FILES_SQL,
      ORACLE_CONTROL_FILES_SQL,
    ]);
    expect(damengExecute.mock.calls.map(([sql]) => sql)).toEqual([DAMENG_DATA_FILES_SQL]);

    const allSql = [mysqlQuery, pgQuery, oracleExecute, damengExecute]
      .flatMap((driver) => driver.mock.calls.map(([sql]) => sql as string));
    expect(allSql.every((sql) => /^SELECT\b/.test(sql))).toBe(true);
    expect(allSql.join('\n')).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|EXECUTE)\b/i);
    expect(MYSQL_FILES_SQL).toContain('LIMIT 128');
    expect(MYSQL_FILES_SQL).toContain('ORDER BY TABLESPACE_NAME, FILE_NAME LIMIT 128');
    expect(POSTGRES_TABLESPACES_SQL).toContain('LIMIT 128');
    expect(POSTGRES_RELATIONS_SQL).toContain('WHERE pg_relation_filepath(relid) IS NOT NULL');
    expect(POSTGRES_RELATIONS_SQL).toContain('LIMIT 32');
    expect([ORACLE_DATA_FILES_SQL, ORACLE_TEMP_FILES_SQL, ORACLE_LOG_FILES_SQL, ORACLE_CONTROL_FILES_SQL]
      .every((sql) => sql.includes('ROWNUM <= 128'))).toBe(true);
    expect([ORACLE_DATA_FILES_SQL, ORACLE_TEMP_FILES_SQL, ORACLE_LOG_FILES_SQL, ORACLE_CONTROL_FILES_SQL]
      .every((sql) => sql.includes('ORDER BY'))).toBe(true);
    expect(DAMENG_DATA_FILES_SQL).toContain('ORDER BY FILE_ID FETCH FIRST 128 ROWS ONLY');
  });
});
