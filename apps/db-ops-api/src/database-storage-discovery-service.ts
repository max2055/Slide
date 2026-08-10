import { posix } from 'node:path';
import { databaseService, type DatabaseConnection } from './database-service.js';
import { dbConnection } from './db-connection.js';

const MAX_PATH_BYTES = 4096;
const MAX_DESCRIPTORS = 128;
const POSTGRES_RELATION_SAMPLE_LIMIT = 32;
const POSTGRES_RELATION_SENTINEL_LIMIT = POSTGRES_RELATION_SAMPLE_LIMIT + 1;

const INSTANCE_TYPE_SQL = 'SELECT db_type FROM database_instances WHERE id = ? LIMIT 1';
const MYSQL_DATADIR_SQL = 'SELECT @@GLOBAL.datadir AS path';
const MYSQL_FILES_SQL = "SELECT FILE_NAME, TABLESPACE_NAME, FILE_TYPE FROM INFORMATION_SCHEMA.FILES WHERE FILE_NAME IS NOT NULL AND FILE_TYPE IN ('TABLESPACE', 'DATAFILE', 'UNDO LOG', 'TEMPORARY') ORDER BY TABLESPACE_NAME, FILE_NAME LIMIT 128";
const POSTGRES_METADATA_SQL = "SELECT current_setting('data_directory') AS data_directory, current_setting('server_version_num') AS server_version_num";
const POSTGRES_TABLESPACES_SQL = "SELECT spcname AS tablespace_name, pg_tablespace_location(oid) AS path FROM pg_tablespace WHERE pg_tablespace_location(oid) <> '' ORDER BY spcname LIMIT 128";
const POSTGRES_RELATIONS_SQL = `SELECT schemaname AS schema_name, relname AS object_name, pg_relation_filepath(relid) AS path, pg_total_relation_size(relid) AS logical_bytes FROM pg_stat_user_tables WHERE pg_relation_filepath(relid) IS NOT NULL ORDER BY pg_total_relation_size(relid) DESC, schemaname, relname LIMIT ${POSTGRES_RELATION_SENTINEL_LIMIT}`;
const ORACLE_DATA_FILES_SQL = 'SELECT FILE_NAME, TABLESPACE_NAME, BYTES FROM (SELECT FILE_NAME, TABLESPACE_NAME, BYTES FROM DBA_DATA_FILES ORDER BY TABLESPACE_NAME, FILE_NAME) WHERE ROWNUM <= 128';
const ORACLE_TEMP_FILES_SQL = 'SELECT FILE_NAME, TABLESPACE_NAME, BYTES FROM (SELECT FILE_NAME, TABLESPACE_NAME, BYTES FROM DBA_TEMP_FILES ORDER BY TABLESPACE_NAME, FILE_NAME) WHERE ROWNUM <= 128';
const ORACLE_LOG_FILES_SQL = 'SELECT MEMBER FROM (SELECT MEMBER FROM V$LOGFILE ORDER BY MEMBER) WHERE ROWNUM <= 128';
const ORACLE_CONTROL_FILES_SQL = 'SELECT NAME FROM (SELECT NAME FROM V$CONTROLFILE ORDER BY NAME) WHERE ROWNUM <= 128';
const DAMENG_DATA_FILES_SQL = 'SELECT FILE_NAME, TABLESPACE_NAME, BYTES FROM DBA_DATA_FILES ORDER BY FILE_ID FETCH FIRST 128 ROWS ONLY';

export type StorageDescriptorKind =
  | 'data-directory'
  | 'data-file'
  | 'undo-log'
  | 'tablespace'
  | 'relation'
  | 'write-ahead-log'
  | 'temp-file'
  | 'redo-log'
  | 'control-file';

export interface StorageDescriptor {
  path: string;
  kind: StorageDescriptorKind;
  source: string;
  hostInspectable: boolean;
  tablespace?: string;
  objectName?: string;
  logicalBytes?: number;
}

export type StorageDiscoveryGapCode =
  | 'STORAGE_DISCOVERY_UNSUPPORTED'
  | 'STORAGE_DISCOVERY_QUERY_FAILED'
  | 'STORAGE_DISCOVERY_INVALID_PATH'
  | 'STORAGE_DISCOVERY_INVALID_LOGICAL_BYTES'
  | 'STORAGE_DISCOVERY_LIMIT_REACHED';

export interface StorageDiscoveryGap {
  code: StorageDiscoveryGapCode;
  source: string;
}

export interface StorageDiscoveryResult {
  descriptors: StorageDescriptor[];
  gaps: StorageDiscoveryGap[];
}

export interface DatabaseStorageConnectionProvider {
  ensureConnectionAlive(instanceId: number): Promise<boolean>;
  getConnection(instanceId: number): DatabaseConnection | null;
}

export interface DatabaseStorageMetadataProvider {
  getDatabaseType(instanceId: number): Promise<string | null>;
}

export class DatabaseStorageInstanceTypeProvider implements DatabaseStorageMetadataProvider {
  async getDatabaseType(instanceId: number): Promise<string | null> {
    if (!Number.isSafeInteger(instanceId) || instanceId <= 0) return null;
    const pool = dbConnection.getPool();
    if (!pool) return null;

    try {
      const [rows] = await pool.execute(INSTANCE_TYPE_SQL, [instanceId]) as unknown as [unknown, unknown];
      if (!Array.isArray(rows) || rows.length === 0 || !isRecord(rows[0])) return null;
      return typeof rows[0].db_type === 'string' ? rows[0].db_type : null;
    } catch {
      return null;
    }
  }
}

export const databaseStorageInstanceTypeProvider = new DatabaseStorageInstanceTypeProvider();

export type StorageDiscoveryErrorCode =
  | 'STORAGE_DISCOVERY_INVALID_INSTANCE_ID'
  | 'STORAGE_DISCOVERY_METADATA_UNAVAILABLE'
  | 'STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE';

export class DatabaseStorageDiscoveryError extends Error {
  constructor(public readonly code: StorageDiscoveryErrorCode) {
    super(code);
    this.name = 'DatabaseStorageDiscoveryError';
  }
}

export { DatabaseStorageDiscoveryError as StorageDiscoveryError };

type DescriptorDraft = Omit<StorageDescriptor, 'path' | 'hostInspectable'>;
type QueryRow = Record<string, unknown> | unknown[];
type ExecuteClient = {
  execute(sql: string): Promise<unknown>;
};

interface PathOptions {
  basePath?: string;
  allowOracleAsm?: boolean;
}

interface NormalizedStoragePath {
  path: string;
  hostInspectable: boolean;
}

class DiscoveryAccumulator {
  private readonly descriptorsByPath = new Map<string, StorageDescriptor>();
  private readonly gapsByKey = new Map<string, StorageDiscoveryGap>();

  addGap(code: StorageDiscoveryGapCode, source: string): void {
    const key = `${code}\u0000${source}`;
    if (!this.gapsByKey.has(key)) this.gapsByKey.set(key, { code, source });
  }

  addDescriptor(
    rawPath: unknown,
    draft: DescriptorDraft,
    options: PathOptions = {},
  ): string | null {
    const normalized = normalizeStoragePath(rawPath, options);
    if (!normalized) {
      this.addGap('STORAGE_DISCOVERY_INVALID_PATH', draft.source);
      return null;
    }

    if (!this.descriptorsByPath.has(normalized.path)) {
      this.descriptorsByPath.set(normalized.path, {
        path: normalized.path,
        ...draft,
        hostInspectable: normalized.hostInspectable,
      });
    }
    return normalized.path;
  }

  result(): StorageDiscoveryResult {
    const descriptors = [...this.descriptorsByPath.values()].sort(compareDescriptors);
    if (descriptors.length > MAX_DESCRIPTORS) {
      this.addGap('STORAGE_DISCOVERY_LIMIT_REACHED', 'database');
    }

    return {
      descriptors: descriptors.slice(0, MAX_DESCRIPTORS),
      gaps: [...this.gapsByKey.values()].sort(compareGaps),
    };
  }
}

function normalizeStoragePath(rawPath: unknown, options: PathOptions): NormalizedStoragePath | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  if (Buffer.byteLength(rawPath, 'utf8') > MAX_PATH_BYTES) return null;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(rawPath)) return null;
  if (rawPath.split('/').some((segment) => segment === '..')) return null;

  const isOracleAsm = /^\+[A-Za-z0-9_$#.-]+(?:\/|$)/.test(rawPath);
  if (isOracleAsm) {
    if (!options.allowOracleAsm) return null;
    const normalizedAsm = canonicalPosixPath(rawPath);
    if (Buffer.byteLength(normalizedAsm, 'utf8') > MAX_PATH_BYTES) return null;
    return { path: normalizedAsm, hostInspectable: false };
  }

  let normalized: string;
  if (posix.isAbsolute(rawPath)) {
    normalized = canonicalPosixPath(rawPath);
  } else if (options.basePath) {
    normalized = canonicalPosixPath(posix.join(options.basePath, rawPath));
    const basePrefix = options.basePath === '/' ? '/' : `${options.basePath}/`;
    if (normalized !== options.basePath && !normalized.startsWith(basePrefix)) return null;
  } else {
    return null;
  }

  if (!posix.isAbsolute(normalized)) return null;
  if (Buffer.byteLength(normalized, 'utf8') > MAX_PATH_BYTES) return null;
  return { path: normalized, hostInspectable: true };
}

function canonicalPosixPath(value: string): string {
  const normalized = posix.normalize(value);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDescriptors(left: StorageDescriptor, right: StorageDescriptor): number {
  return compareText(left.path, right.path)
    || compareText(left.kind, right.kind)
    || compareText(left.source, right.source);
}

function compareGaps(left: StorageDiscoveryGap, right: StorageDiscoveryGap): number {
  return compareText(left.source, right.source) || compareText(left.code, right.code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractRows(result: unknown): QueryRow[] {
  if (Array.isArray(result)) return result as QueryRow[];
  if (!isRecord(result) || !Array.isArray(result.rows)) return [];
  return result.rows as QueryRow[];
}

function mysqlRows(result: unknown): QueryRow[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return [];
  return result[0] as QueryRow[];
}

function rowValue(row: QueryRow, names: string[], arrayIndex: number): unknown {
  if (Array.isArray(row)) return row[arrayIndex];
  const wanted = new Set(names.map((name) => name.toUpperCase()));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(key.toUpperCase())) return value;
  }
  return undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function logicalBytes(
  value: unknown,
  source: string,
  accumulator: DiscoveryAccumulator,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && value.trim().length === 0)) {
    accumulator.addGap('STORAGE_DISCOVERY_INVALID_LOGICAL_BYTES', source);
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    accumulator.addGap('STORAGE_DISCOVERY_INVALID_LOGICAL_BYTES', source);
    return undefined;
  }
  return parsed;
}

function withOptionalFields(
  draft: DescriptorDraft,
  fields: Pick<StorageDescriptor, 'tablespace' | 'objectName' | 'logicalBytes'>,
): DescriptorDraft {
  if (fields.tablespace !== undefined) draft.tablespace = fields.tablespace;
  if (fields.objectName !== undefined) draft.objectName = fields.objectName;
  if (fields.logicalBytes !== undefined) draft.logicalBytes = fields.logicalBytes;
  return draft;
}

export class DatabaseStorageDiscoveryService {
  constructor(
    private readonly provider: DatabaseStorageConnectionProvider = databaseService,
    private readonly metadataProvider: DatabaseStorageMetadataProvider = databaseStorageInstanceTypeProvider,
  ) {}

  async discover(instanceId: number): Promise<StorageDiscoveryResult> {
    if (!Number.isSafeInteger(instanceId) || instanceId <= 0) {
      throw new DatabaseStorageDiscoveryError('STORAGE_DISCOVERY_INVALID_INSTANCE_ID');
    }

    let rawDatabaseType: string | null;
    try {
      rawDatabaseType = await this.metadataProvider.getDatabaseType(instanceId);
    } catch {
      throw new DatabaseStorageDiscoveryError('STORAGE_DISCOVERY_METADATA_UNAVAILABLE');
    }
    if (typeof rawDatabaseType !== 'string' || rawDatabaseType.trim().length === 0) {
      throw new DatabaseStorageDiscoveryError('STORAGE_DISCOVERY_METADATA_UNAVAILABLE');
    }

    const databaseType = rawDatabaseType.trim().toLowerCase();
    const accumulator = new DiscoveryAccumulator();
    if (!['mysql', 'postgresql', 'oracle', 'dameng'].includes(databaseType)) {
      accumulator.addGap('STORAGE_DISCOVERY_UNSUPPORTED', databaseType);
      return accumulator.result();
    }

    let alive: boolean;
    try {
      alive = await this.provider.ensureConnectionAlive(instanceId);
    } catch {
      throw new DatabaseStorageDiscoveryError('STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE');
    }
    if (!alive) throw new DatabaseStorageDiscoveryError('STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE');

    let connection: DatabaseConnection | null;
    try {
      connection = this.provider.getConnection(instanceId);
    } catch {
      throw new DatabaseStorageDiscoveryError('STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE');
    }
    if (!connection) throw new DatabaseStorageDiscoveryError('STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE');

    switch (databaseType) {
      case 'mysql':
        await this.discoverMySql(connection, accumulator);
        break;
      case 'postgresql':
        await this.discoverPostgreSql(connection, accumulator);
        break;
      case 'oracle':
        await this.discoverOracle(connection, accumulator);
        break;
      case 'dameng':
        await this.discoverDameng(connection, accumulator);
        break;
    }

    return accumulator.result();
  }

  private async discoverMySql(
    connection: DatabaseConnection,
    accumulator: DiscoveryAccumulator,
  ): Promise<void> {
    const pool = connection.pool;
    if (!pool) throw new DatabaseStorageDiscoveryError('STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE');

    let dataDirectory: string | null = null;
    try {
      const result = await pool.query(MYSQL_DATADIR_SQL) as unknown;
      const firstRow = mysqlRows(result)[0];
      if (!firstRow) {
        accumulator.addGap('STORAGE_DISCOVERY_QUERY_FAILED', 'mysql.datadir');
      } else {
        dataDirectory = accumulator.addDescriptor(
          rowValue(firstRow, ['path'], 0),
          { kind: 'data-directory', source: 'mysql.datadir' },
        );
      }
    } catch {
      accumulator.addGap('STORAGE_DISCOVERY_QUERY_FAILED', 'mysql.datadir');
    }

    try {
      const result = await pool.query(MYSQL_FILES_SQL) as unknown;
      const rows = mysqlRows(result);
      if (rows.length >= MAX_DESCRIPTORS) {
        accumulator.addGap('STORAGE_DISCOVERY_LIMIT_REACHED', 'mysql.information_schema.files');
      }
      for (const row of rows) {
        const fileType = optionalText(rowValue(row, ['FILE_TYPE'], 2))?.toUpperCase();
        if (!fileType || !['TABLESPACE', 'DATAFILE', 'UNDO LOG', 'TEMPORARY'].includes(fileType)) continue;

        const tablespace = optionalText(rowValue(row, ['TABLESPACE_NAME'], 1));
        accumulator.addDescriptor(
          rowValue(row, ['FILE_NAME'], 0),
          withOptionalFields({
            kind: fileType === 'UNDO LOG'
              ? 'undo-log'
              : fileType === 'TEMPORARY' ? 'temp-file' : 'data-file',
            source: 'mysql.information_schema.files',
          }, { tablespace }),
          dataDirectory ? { basePath: dataDirectory } : {},
        );
      }
    } catch {
      accumulator.addGap('STORAGE_DISCOVERY_QUERY_FAILED', 'mysql.information_schema.files');
    }
  }

  private async discoverPostgreSql(
    connection: DatabaseConnection,
    accumulator: DiscoveryAccumulator,
  ): Promise<void> {
    const client = connection.pgClient;
    if (!client) throw new DatabaseStorageDiscoveryError('STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE');

    let dataDirectory: string | null = null;
    let serverVersion: number | null = null;
    try {
      const result = await client.query(POSTGRES_METADATA_SQL) as unknown;
      const firstRow = extractRows(result)[0];
      if (!firstRow) {
        accumulator.addGap('STORAGE_DISCOVERY_QUERY_FAILED', 'postgresql.data_directory');
      } else {
        dataDirectory = accumulator.addDescriptor(
          rowValue(firstRow, ['data_directory', 'path'], 0),
          { kind: 'data-directory', source: 'postgresql.data_directory' },
        );
        const parsedVersion = Number(rowValue(firstRow, ['server_version_num', 'version_num'], 1));
        if (Number.isFinite(parsedVersion) && parsedVersion >= 0) {
          serverVersion = parsedVersion;
        } else {
          accumulator.addGap('STORAGE_DISCOVERY_QUERY_FAILED', 'postgresql.data_directory');
        }
      }
    } catch {
      accumulator.addGap('STORAGE_DISCOVERY_QUERY_FAILED', 'postgresql.data_directory');
    }

    if (dataDirectory && serverVersion !== null) {
      accumulator.addDescriptor(
        serverVersion >= 100000 ? 'pg_wal' : 'pg_xlog',
        { kind: 'write-ahead-log', source: 'postgresql.wal' },
        { basePath: dataDirectory },
      );
    }

    try {
      const result = await client.query(POSTGRES_TABLESPACES_SQL) as unknown;
      const rows = extractRows(result);
      if (rows.length >= MAX_DESCRIPTORS) {
        accumulator.addGap('STORAGE_DISCOVERY_LIMIT_REACHED', 'postgresql.pg_tablespace');
      }
      for (const row of rows) {
        const rawPath = rowValue(row, ['path'], 1);
        if (rawPath === '') continue;
        const tablespace = optionalText(rowValue(row, ['tablespace_name'], 0));
        accumulator.addDescriptor(
          rawPath,
          withOptionalFields(
            { kind: 'tablespace', source: 'postgresql.pg_tablespace' },
            { tablespace },
          ),
        );
      }
    } catch {
      accumulator.addGap('STORAGE_DISCOVERY_QUERY_FAILED', 'postgresql.pg_tablespace');
    }

    try {
      const result = await client.query(POSTGRES_RELATIONS_SQL) as unknown;
      const rows = extractRows(result);
      if (rows.length > POSTGRES_RELATION_SAMPLE_LIMIT) {
        accumulator.addGap('STORAGE_DISCOVERY_LIMIT_REACHED', 'postgresql.pg_stat_user_tables');
      }
      for (const row of rows.slice(0, POSTGRES_RELATION_SAMPLE_LIMIT)) {
        const schemaName = optionalText(rowValue(row, ['schema_name'], 0));
        const relationName = optionalText(rowValue(row, ['object_name'], 1));
        const objectName = schemaName && relationName
          ? `${schemaName}.${relationName}`
          : relationName;
        const bytes = logicalBytes(
          rowValue(row, ['logical_bytes'], 3),
          'postgresql.pg_stat_user_tables',
          accumulator,
        );
        accumulator.addDescriptor(
          rowValue(row, ['path'], 2),
          withOptionalFields(
            { kind: 'relation', source: 'postgresql.pg_stat_user_tables' },
            { objectName, logicalBytes: bytes },
          ),
          dataDirectory ? { basePath: dataDirectory } : {},
        );
      }
    } catch {
      accumulator.addGap('STORAGE_DISCOVERY_QUERY_FAILED', 'postgresql.pg_stat_user_tables');
    }
  }

  private async discoverOracle(
    connection: DatabaseConnection,
    accumulator: DiscoveryAccumulator,
  ): Promise<void> {
    let client = connection.oracleConnection as unknown as ExecuteClient | null;
    let borrowedClient: (ExecuteClient & { close(): Promise<void> }) | null = null;

    if (!client && connection.oraclePool) {
      try {
        borrowedClient = await connection.oraclePool.getConnection() as unknown as ExecuteClient & {
          close(): Promise<void>;
        };
        client = borrowedClient;
      } catch {
        throw new DatabaseStorageDiscoveryError('STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE');
      }
    }
    if (!client) throw new DatabaseStorageDiscoveryError('STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE');

    try {
      await this.runOracleQuery(client, ORACLE_DATA_FILES_SQL, 'oracle.dba_data_files', accumulator, (row) => {
        const tablespace = optionalText(rowValue(row, ['TABLESPACE_NAME'], 1));
        const bytes = logicalBytes(rowValue(row, ['BYTES'], 2), 'oracle.dba_data_files', accumulator);
        accumulator.addDescriptor(
          rowValue(row, ['FILE_NAME'], 0),
          withOptionalFields(
            { kind: 'data-file', source: 'oracle.dba_data_files' },
            { tablespace, logicalBytes: bytes },
          ),
          { allowOracleAsm: true },
        );
      });

      await this.runOracleQuery(client, ORACLE_TEMP_FILES_SQL, 'oracle.dba_temp_files', accumulator, (row) => {
        const tablespace = optionalText(rowValue(row, ['TABLESPACE_NAME'], 1));
        const bytes = logicalBytes(rowValue(row, ['BYTES'], 2), 'oracle.dba_temp_files', accumulator);
        accumulator.addDescriptor(
          rowValue(row, ['FILE_NAME'], 0),
          withOptionalFields(
            { kind: 'temp-file', source: 'oracle.dba_temp_files' },
            { tablespace, logicalBytes: bytes },
          ),
          { allowOracleAsm: true },
        );
      });

      await this.runOracleQuery(client, ORACLE_LOG_FILES_SQL, 'oracle.v_logfile', accumulator, (row) => {
        accumulator.addDescriptor(
          rowValue(row, ['MEMBER'], 0),
          { kind: 'redo-log', source: 'oracle.v_logfile' },
          { allowOracleAsm: true },
        );
      });

      await this.runOracleQuery(client, ORACLE_CONTROL_FILES_SQL, 'oracle.v_controlfile', accumulator, (row) => {
        accumulator.addDescriptor(
          rowValue(row, ['NAME'], 0),
          { kind: 'control-file', source: 'oracle.v_controlfile' },
          { allowOracleAsm: true },
        );
      });
    } finally {
      if (borrowedClient) await borrowedClient.close().catch(() => undefined);
    }
  }

  private async runOracleQuery(
    client: ExecuteClient,
    sql: string,
    source: string,
    accumulator: DiscoveryAccumulator,
    consumeRow: (row: QueryRow) => void,
  ): Promise<void> {
    try {
      const result = await client.execute(sql);
      const rows = extractRows(result);
      if (rows.length >= MAX_DESCRIPTORS) {
        accumulator.addGap('STORAGE_DISCOVERY_LIMIT_REACHED', source);
      }
      for (const row of rows) consumeRow(row);
    } catch {
      accumulator.addGap('STORAGE_DISCOVERY_QUERY_FAILED', source);
    }
  }

  private async discoverDameng(
    connection: DatabaseConnection,
    accumulator: DiscoveryAccumulator,
  ): Promise<void> {
    const client = connection.dmConnection as unknown as ExecuteClient | null;
    if (!client) throw new DatabaseStorageDiscoveryError('STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE');

    try {
      const result = await client.execute(DAMENG_DATA_FILES_SQL);
      const rows = extractRows(result);
      if (rows.length >= MAX_DESCRIPTORS) {
        accumulator.addGap('STORAGE_DISCOVERY_LIMIT_REACHED', 'dameng.dba_data_files');
      }
      for (const row of rows) {
        const tablespace = optionalText(rowValue(row, ['TABLESPACE_NAME'], 1));
        const bytes = logicalBytes(rowValue(row, ['BYTES'], 2), 'dameng.dba_data_files', accumulator);
        accumulator.addDescriptor(
          rowValue(row, ['FILE_NAME'], 0),
          withOptionalFields(
            { kind: 'data-file', source: 'dameng.dba_data_files' },
            { tablespace, logicalBytes: bytes },
          ),
        );
      }
    } catch {
      accumulator.addGap('STORAGE_DISCOVERY_QUERY_FAILED', 'dameng.dba_data_files');
    }
  }
}

export const databaseStorageDiscoveryService = new DatabaseStorageDiscoveryService();
