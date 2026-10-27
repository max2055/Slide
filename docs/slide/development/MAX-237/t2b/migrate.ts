/**
 * MAX-237 / T2B — drill-only storage-compatibility migration program.
 *
 * This file lives only under `docs/slide/development/MAX-237/t2b/`. It is NOT an
 * application migration: nothing imports it, nothing registers it, and it never
 * touches a shared pool, the platform database or any object outside the one
 * task-owned disposable fixture created by `env-start.sh`.
 *
 * Default mode `plan` performs **zero connections and zero writes**: it only
 * validates the exact creation handle (owner, phase, container, image, volume,
 * three-schema allowlist) from the untracked state directory. A connection is
 * opened only for the explicit `execute`/`seed`/`verify` modes, and `execute`
 * additionally proves it is talking to the recorded container (hostname prefix),
 * the allowlisted user and exactly the three allowlisted schemas.
 *
 *   tsx migrate.ts plan
 *   tsx migrate.ts seed
 *   tsx migrate.ts execute up [--inject after-parents|after-versions]
 *   tsx migrate.ts execute down
 *   tsx migrate.ts verify
 *
 * The copy is a bounded, explicit field mapping between the original DDL 140
 * source schema and the T2B candidate schema. It is not a generic migration
 * framework, does not ALTER existing tables, and does not promise transactional
 * DDL rollback.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../../../../apps/db-ops-api/package.json', import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
type Pool = import('mysql2/promise').Pool;
type PoolConnection = import('mysql2/promise').PoolConnection;

export const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
export const EXPECTED_IMAGE_ID = 'sha256:c592c15aaf4a1961e15d82eb31ea5987dda862d1c4b1e93424438c0e91dc1f8d';
export const OWNER = '15coder1-t2b';
export const PHASE = 'T2B-20261027';
export const CONTAINER_NAME = 'max237-t2b-15coder1-20261027';
export const VOLUME_NAME = 'max237-t2b-15coder1-20261027-data';
export const SOURCE_SCHEMA = 'max237_t2b_d1';
export const CANDIDATE_SCHEMA = 'max237_t2b';
export const RESTORE_SCHEMA = 'max237_t2b_restore';
export const APP_USER = 'max237_t2b_app';
export const SCHEMAS = [SOURCE_SCHEMA, CANDIDATE_SCHEMA, RESTORE_SCHEMA] as const;

export type Table =
  | 'metric_templates_v2'
  | 'metric_template_drafts'
  | 'metric_template_items'
  | 'metric_template_item_versions'
  | 'metric_template_versions';

/** FK-safe copy order: parent → draft/items → item versions → template versions. */
export const COPY_ORDER: Table[] = [
  'metric_templates_v2', 'metric_template_drafts', 'metric_template_items',
  'metric_template_item_versions', 'metric_template_versions',
];

export const PRIMARY_KEYS: Record<Table, string[]> = {
  metric_templates_v2: ['template_id'],
  metric_template_drafts: ['template_id'],
  metric_template_items: ['template_id', 'item_id'],
  metric_template_item_versions: ['template_id', 'item_id', 'version'],
  metric_template_versions: ['template_id', 'version'],
};

export const COLUMNS: Record<Table, string[]> = {
  metric_templates_v2: [
    'template_id', 'name', 'status', 'current_published_version', 'revision',
    'created_by', 'created_at', 'updated_at',
  ],
  metric_template_drafts: ['template_id', 'revision', 'aggregate', 'published_version', 'updated_by', 'updated_at'],
  metric_template_items: ['template_id', 'item_id', 'status', 'created_at'],
  metric_template_item_versions: [
    'template_id', 'item_id', 'version', 'display_name', 'canonical_metric_id', 'canonical_semantic_version',
    'unit', 'dimensions', 'collector_ref', 'params_default', 'source_chain',
  ],
  metric_template_versions: [
    'template_id', 'version', 'status', 'content_hash', 'aggregate', 'items', 'package_composition',
    'source_chain', 'published_at', 'retired_at',
  ],
};

const TIMESTAMP_COLUMNS: Record<Table, string[]> = {
  metric_templates_v2: ['created_at', 'updated_at'],
  metric_template_drafts: ['updated_at'],
  metric_template_items: ['created_at'],
  metric_template_item_versions: [],
  metric_template_versions: ['published_at', 'retired_at'],
};

const ACTOR_COLUMNS: Record<Table, string[]> = {
  metric_templates_v2: ['created_by'],
  metric_template_drafts: ['updated_by'],
  metric_template_items: [],
  metric_template_item_versions: [],
  metric_template_versions: [],
};

const JSON_COLUMNS: Record<Table, string[]> = {
  metric_templates_v2: [],
  metric_template_drafts: ['aggregate'],
  metric_template_items: [],
  metric_template_item_versions: ['dimensions', 'collector_ref', 'params_default', 'source_chain'],
  metric_template_versions: ['aggregate', 'items', 'package_composition', 'source_chain'],
};

export class DrillError extends Error {
  readonly reason: string;
  readonly detail: unknown;
  constructor(reason: string, message: string, detail: unknown = null) {
    super(message);
    this.name = 'DrillError';
    this.reason = reason;
    this.detail = detail;
  }
}

// ------------------------------------------------------------------ config

export interface FixtureHandle {
  owner: string;
  phase: string;
  container_id: string;
  container_name: string;
  image: string;
  image_id: string;
  volume: string;
  port: number;
  schemas: string[];
  source_schema: string;
  candidate_schema: string;
  restore_schema: string;
  app_user: string;
}

export interface DrillConfig {
  stateDir: string;
  handlePath: string;
  credentialsPath: string;
  handle: FixtureHandle;
}

const stateDirOf = (env: NodeJS.ProcessEnv): string =>
  env.MAX237_T2B_STATE_DIR ?? `${ROOT}/.max237-t2b`;

/**
 * Static validation only — no connection, no filesystem write. Used by `plan`
 * exactly as it is used before every mutating mode.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DrillConfig {
  const stateDir = stateDirOf(env);
  const handlePath = `${stateDir}/handle.json`;
  let handle: FixtureHandle;
  try {
    handle = JSON.parse(readFileSync(handlePath, 'utf8')) as FixtureHandle;
  } catch (error) {
    throw new DrillError('handle-missing', `cannot read the T2B creation handle ${handlePath}`, String(error));
  }
  const expect = (actual: unknown, wanted: unknown, field: string): void => {
    if (actual !== wanted) {
      throw new DrillError('handle-mismatch', `handle ${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
    }
  };
  expect(handle.owner, OWNER, 'owner');
  expect(handle.phase, PHASE, 'phase');
  expect(handle.container_name, CONTAINER_NAME, 'container_name');
  expect(handle.image_id, EXPECTED_IMAGE_ID, 'image_id');
  expect(handle.volume, VOLUME_NAME, 'volume');
  expect(JSON.stringify(handle.schemas), JSON.stringify(SCHEMAS), 'schemas');
  expect(handle.source_schema, SOURCE_SCHEMA, 'source_schema');
  expect(handle.candidate_schema, CANDIDATE_SCHEMA, 'candidate_schema');
  expect(handle.restore_schema, RESTORE_SCHEMA, 'restore_schema');
  expect(handle.app_user, APP_USER, 'app_user');
  if (!/^[0-9a-f]{64}$/.test(String(handle.container_id))) {
    throw new DrillError('handle-mismatch', 'handle container_id is not a full container ID');
  }
  if (!Number.isInteger(handle.port) || handle.port <= 0) {
    throw new DrillError('handle-mismatch', 'handle port is not a valid loopback port');
  }
  return { stateDir, handlePath, credentialsPath: `${stateDir}/credentials.env`, handle };
}

/** Credentials live only in the untracked 0600 file written by env-start.sh. */
export function readCredentials(cfg: DrillConfig): {
  port: number; user: string; password: string; database: string;
} {
  const text = readFileSync(cfg.credentialsPath, 'utf8');
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]!] = match[2]!;
  }
  const password = values.MAX237_T2B_MYSQL_PASSWORD;
  const port = Number(values.MAX237_T2B_MYSQL_PORT);
  if (!password || !Number.isInteger(port) || port <= 0) {
    throw new DrillError('credentials-missing', `credentials file ${cfg.credentialsPath} is incomplete`);
  }
  return {
    port,
    user: values.MAX237_T2B_MYSQL_USER ?? '',
    password,
    database: values.MAX237_T2B_MYSQL_DATABASE ?? '',
  };
}

export function openPool(cfg: DrillConfig): Pool {
  const credentials = readCredentials(cfg);
  if (credentials.port !== cfg.handle.port) {
    throw new DrillError('credentials-mismatch', 'credentials port does not match the creation handle');
  }
  if (credentials.database !== CANDIDATE_SCHEMA || credentials.user !== APP_USER) {
    throw new DrillError('credentials-mismatch', 'credentials user/database are not the allowlisted selector');
  }
  return mysql.createPool({
    host: '127.0.0.1',
    port: credentials.port,
    user: credentials.user,
    password: credentials.password,
    database: credentials.database,
    waitForConnections: true,
    connectionLimit: 4,
    // Both driver renderings are handled explicitly by normalization below.
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  });
}

// ------------------------------------------------------------- normalization

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_FORMAT_RENDERING = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/;

/** Already-canonical candidate string; anything else is a corrupt row. */
export function normalizeCanonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL.test(value)) {
    throw new DrillError('bad-timestamp', `candidate timestamp ${JSON.stringify(value)} is not canonical`);
  }
  return value;
}

/** `DATE_FORMAT(...%f)` rendering from the 140 schemas → the same canonical string. */
export function normalizeDateTimeTimestamp(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const match = DATE_FORMAT_RENDERING.exec(text);
  if (!match) {
    throw new DrillError('bad-timestamp', `source DATETIME rendering ${JSON.stringify(text)} is unexpected`);
  }
  const year = Number(match[1]!.slice(0, 4));
  if (year < 1000) {
    throw new DrillError('bad-timestamp', `source DATETIME year ${year} is not representable`);
  }
  return `${match[1]}.${match[2]!.slice(0, 3)}Z`;
}

/** Canonical string → the `DATETIME(3)` literal of DDL 140 (down direction). */
export function canonicalToDateTime(value: string): string {
  if (!CANONICAL.test(value)) {
    throw new DrillError('bad-timestamp', `candidate timestamp ${JSON.stringify(value)} is not canonical`);
  }
  const year = Number(value.slice(0, 4));
  if (year < 1000) {
    throw new DrillError('down-irreversible', `timestamp ${value} is before the DATETIME year 1000`);
  }
  return `${value.slice(0, 10)} ${value.slice(11, 23)}`;
}

export function normalizeActor(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new DrillError('bad-actor', `actor ${JSON.stringify(value)} is not a safe non-negative integer`);
  }
  return numeric;
}

const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map(key => [key, sortDeep(source[key])]));
  }
  return value;
};

export const stable = (value: unknown): string => JSON.stringify(sortDeep(value));

const sha256 = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');

// ------------------------------------------------------------------ manifests

export interface Manifest {
  schema: string;
  kind: 'source' | 'candidate' | 'restore';
  tables: Record<Table, Record<string, unknown>[]>;
  sha256: string;
}

const selectList = (kind: Manifest['kind'], table: Table): string =>
  COLUMNS[table].map(column => {
    if (TIMESTAMP_COLUMNS[table].includes(column) && kind !== 'candidate') {
      return `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.%fZ') AS ${column}`;
    }
    return column;
  }).join(', ');

export function normalizeRow(kind: Manifest['kind'], table: Table, row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const column of COLUMNS[table]) {
    const value = row[column];
    if (TIMESTAMP_COLUMNS[table].includes(column)) {
      normalized[column] = value === null || value === undefined
        ? null
        : (kind === 'candidate' ? normalizeCanonicalTimestamp(value) : normalizeDateTimeTimestamp(value));
    } else if (ACTOR_COLUMNS[table].includes(column)) {
      normalized[column] = normalizeActor(value);
    } else if (JSON_COLUMNS[table].includes(column)) {
      normalized[column] = value === null || value === undefined
        ? null
        : (typeof value === 'string' ? JSON.parse(value) as unknown : value);
    } else if (column === 'current_published_version' || column === 'published_version' || column === 'revision' || column === 'version') {
      normalized[column] = value === null || value === undefined ? null : Number(value);
    } else {
      normalized[column] = value ?? null;
    }
  }
  return normalized;
}

export async function readManifest(
  pool: Pool, schema: string, kind: Manifest['kind'],
): Promise<Manifest> {
  const tables = {} as Record<Table, Record<string, unknown>[]>;
  for (const table of COPY_ORDER) {
    const [rows] = await pool.query(
      `SELECT ${selectList(kind, table)} FROM \`${schema}\`.\`${table}\`
        ORDER BY ${PRIMARY_KEYS[table].join(', ')}`,
    );
    tables[table] = (rows as Record<string, unknown>[]).map(row => normalizeRow(kind, table, row));
  }
  const payload = { schema, kind, tables };
  return { ...payload, sha256: sha256(tables) };
}

/** Row counts per table; used for the empty-target preflight. */
export async function rowCounts(pool: Pool, schema: string): Promise<Record<Table, number>> {
  const counts = {} as Record<Table, number>;
  for (const table of COPY_ORDER) {
    const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM \`${schema}\`.\`${table}\``);
    counts[table] = Number((rows as { n: number }[])[0]!.n);
  }
  return counts;
}

const isEmpty = (counts: Record<Table, number>): boolean => Object.values(counts).every(count => count === 0);

// ------------------------------------------------------------- live fixture

const CANDIDATE_COLUMN_TYPES: Record<Table, Record<string, string>> = {
  metric_templates_v2: {
    template_id: 'varchar(64)', name: 'varchar(128)',
    status: "enum('draft','active','deprecated','archived')",
    current_published_version: 'int', revision: 'int', created_by: 'bigint unsigned',
    created_at: 'char(24)', updated_at: 'char(24)',
  },
  metric_template_drafts: {
    template_id: 'varchar(64)', revision: 'int', aggregate: 'json', published_version: 'int',
    updated_by: 'bigint unsigned', updated_at: 'char(24)',
  },
  metric_template_items: {
    template_id: 'varchar(64)', item_id: 'varchar(64)',
    status: "enum('active','archived')", created_at: 'char(24)',
  },
  metric_template_item_versions: {
    template_id: 'varchar(64)', item_id: 'varchar(64)', version: 'int', display_name: 'varchar(128)',
    canonical_metric_id: 'longtext', canonical_semantic_version: 'longtext', unit: 'varchar(32)',
    dimensions: 'json', collector_ref: 'json', params_default: 'json', source_chain: 'json',
  },
  metric_template_versions: {
    template_id: 'varchar(64)', version: 'int', status: "enum('published','retired')",
    content_hash: 'char(71)', aggregate: 'json', items: 'json', package_composition: 'json',
    source_chain: 'json', published_at: 'char(24)', retired_at: 'char(24)',
  },
};

/**
 * Proves this pool is the recorded container, the allowlisted DML user and
 * exactly the three allowlisted schemas, and that the candidate tables match the
 * frozen column representations.
 */
export async function verifyLiveFixture(pool: Pool, cfg: DrillConfig): Promise<void> {
  const [identity] = await pool.query('SELECT @@hostname AS hostname, CURRENT_USER() AS user, @@version AS version');
  const row = (identity as { hostname: string; user: string; version: string }[])[0]!;
  if (!String(row.hostname).startsWith(cfg.handle.container_id.slice(0, 12))) {
    throw new DrillError('wrong-fixture', `connected host ${row.hostname} is not the recorded container ${cfg.handle.container_id}`);
  }
  if (String(row.user) !== `${APP_USER}@%`) {
    throw new DrillError('wrong-fixture', `connected as ${row.user}, expected ${APP_USER}@%`);
  }
  const [schemas] = await pool.query(
    "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'max237_t2b%' ORDER BY SCHEMA_NAME",
  );
  const names = (schemas as { name: string }[]).map(entry => entry.name);
  if (JSON.stringify(names) !== JSON.stringify([...SCHEMAS].sort())) {
    throw new DrillError('wrong-fixture', `schemas ${JSON.stringify(names)} are not the allowlisted three`);
  }
  for (const [schema, label] of [
    [SOURCE_SCHEMA, 'source'], [CANDIDATE_SCHEMA, 'candidate'], [RESTORE_SCHEMA, 'restore'],
  ] as const) {
    const [tables] = await pool.query(
      'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [schema],
    );
    const tableNames = (tables as { name: string }[]).map(entry => entry.name);
    if (JSON.stringify(tableNames) !== JSON.stringify([...COPY_ORDER].sort())) {
      throw new DrillError('wrong-fixture', `${label} schema ${schema} does not have exactly the five tables`);
    }
  }
  const [columns] = await pool.query(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType,
            CHARACTER_SET_NAME AS characterSet, COLLATION_NAME AS collationName
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?`, [CANDIDATE_SCHEMA],
  );
  const seen = new Map<string, Record<string, unknown>>();
  for (const column of columns as Record<string, unknown>[]) {
    seen.set(`${column.tableName}.${column.columnName}`, column);
  }
  for (const table of COPY_ORDER) {
    for (const [column, type] of Object.entries(CANDIDATE_COLUMN_TYPES[table])) {
      const actual = seen.get(`${table}.${column}`);
      if (!actual) throw new DrillError('wrong-fixture', `candidate column ${table}.${column} is missing`);
      if (actual.columnType !== type) {
        throw new DrillError('wrong-fixture', `candidate column ${table}.${column} is ${actual.columnType}, expected ${type}`);
      }
    }
  }
  for (const [table, column] of [
    ['metric_templates_v2', 'created_at'], ['metric_templates_v2', 'updated_at'],
    ['metric_template_drafts', 'updated_at'], ['metric_template_items', 'created_at'],
    ['metric_template_versions', 'published_at'], ['metric_template_versions', 'retired_at'],
    ['metric_template_item_versions', 'canonical_metric_id'],
    ['metric_template_item_versions', 'canonical_semantic_version'],
  ] as const) {
    const actual = seen.get(`${table}.${column}`)!;
    if (actual.characterSet !== 'ascii' || actual.collationName !== 'ascii_bin') {
      throw new DrillError('wrong-fixture', `candidate column ${table}.${column} is not ascii/ascii_bin`);
    }
  }
}

// ------------------------------------------------------------- transformations

const isTimestamp = (table: Table, column: string): boolean => TIMESTAMP_COLUMNS[table].includes(column);
const isActor = (table: Table, column: string): boolean => ACTOR_COLUMNS[table].includes(column);
const isJson = (table: Table, column: string): boolean => JSON_COLUMNS[table].includes(column);

/** Source rows are already normalized to canonical instants; write them as such. */
function toCandidateValue(table: Table, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (isTimestamp(table, column)) return normalizeCanonicalTimestamp(value);
  if (isActor(table, column)) return normalizeActor(value);
  if (isJson(table, column)) return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value);
  return value;
}

/** Candidate → 140 values; representability was verified before any write. */
function toRestoreValue(table: Table, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (isTimestamp(table, column)) return canonicalToDateTime(normalizeCanonicalTimestamp(value));
  if (isActor(table, column)) return normalizeActor(value);
  if (isJson(table, column)) return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value);
  return value;
}

/** A copy's rows are already normalized, so the expected manifest is the same data. */
export const expectedFrom = (
  kind: Manifest['kind'], schema: string, source: Manifest,
): Manifest => ({ schema, kind, tables: source.tables, sha256: sha256(source.tables) });

/** Down is allowed only when every candidate row is losslessly representable in DDL 140. */
export function checkDownRepresentable(candidate: Manifest): string[] {
  const problems: string[] = [];
  for (const table of COPY_ORDER) {
    for (const row of candidate.tables[table]) {
      const key = PRIMARY_KEYS[table].map(column => String(row[column])).join('/');
      for (const column of COLUMNS[table]) {
        const value = row[column];
        if (value === null || value === undefined) continue;
        if (isActor(table, column) && Number(value) > 2147483647) {
          problems.push(`${table}[${key}].${column}=${String(value)} exceeds INT`);
        }
        if (column === 'canonical_metric_id' && String(value).length > 128) {
          problems.push(`${table}[${key}].${column} is ${String(value).length} chars, not VARCHAR(128)`);
        }
        if (column === 'canonical_semantic_version' && String(value).length > 16) {
          problems.push(`${table}[${key}].${column} is ${String(value).length} chars, not VARCHAR(16)`);
        }
        if (isTimestamp(table, column) && Number(String(value).slice(0, 4)) < 1000) {
          problems.push(`${table}[${key}].${column}=${String(value)} precedes DATETIME year 1000`);
        }
      }
    }
  }
  return problems;
}

// -------------------------------------------------------------------- writes

async function insertRows(
  connection: PoolConnection, schema: string, table: Table,
  rows: Record<string, unknown>[], direction: 'up' | 'down',
): Promise<void> {
  if (rows.length === 0) return;
  const placeholders = COLUMNS[table].map(() => '?').join(', ');
  const sql = `INSERT INTO \`${schema}\`.\`${table}\` (${COLUMNS[table].join(', ')}) VALUES (${placeholders})`;
  for (const row of rows) {
    const values = COLUMNS[table].map(column =>
      (direction === 'up' ? toCandidateValue(table, column, row[column]) : toRestoreValue(table, column, row[column])));
    await connection.query(sql, values);
  }
}

export interface TransferResult {
  status: 'copied' | 'no-op';
  sourceManifest: Manifest;
  expected: Manifest;
  observed: Manifest;
  injected: string | null;
  rows: Record<Table, number>;
  connectionIdentity?: { hostname: string; user: string; version: string };
}

export async function up(cfg: DrillConfig, pool: Pool, inject: string | null = null): Promise<TransferResult> {
  await verifyLiveFixture(pool, cfg);
  const source = await readManifest(pool, SOURCE_SCHEMA, 'source');
  const expected = expectedFrom('candidate', CANDIDATE_SCHEMA, source);
  const targetCounts = await rowCounts(pool, CANDIDATE_SCHEMA);
  if (!isEmpty(targetCounts)) {
    const observed = await readManifest(pool, CANDIDATE_SCHEMA, 'candidate');
    if (observed.sha256 === expected.sha256) {
      return { status: 'no-op', sourceManifest: source, expected, observed, injected: null, rows: targetCounts };
    }
    throw new DrillError('target-drift',
      'candidate target is not empty and does not match the source manifest; refusing to overwrite', {
        counts: targetCounts, expected: expected.sha256, observed: observed.sha256,
      });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    try {
      for (const table of COPY_ORDER) {
        await insertRows(connection, CANDIDATE_SCHEMA, table, source.tables[table], 'up');
        if (inject === 'after-parents' && table === 'metric_templates_v2') {
          throw new DrillError('injected-failure', 'injected failure after copying parent rows');
        }
        if (inject === 'after-versions' && table === 'metric_template_versions') {
          throw new DrillError('injected-failure', 'injected failure after copying version snapshot rows');
        }
      }
      await connection.commit();
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // The drill reports the original failure; it never retries automatically.
      }
      throw error;
    }
  } finally {
    connection.release();
  }

  const observed = await readManifest(pool, CANDIDATE_SCHEMA, 'candidate');
  if (observed.sha256 !== expected.sha256) {
    throw new DrillError('verify-failed', 'target manifest differs from the expected copy');
  }
  const sourceAfter = await readManifest(pool, SOURCE_SCHEMA, 'source');
  if (sourceAfter.sha256 !== source.sha256) {
    throw new DrillError('source-mutated', 'source manifest changed during the copy');
  }
  return {
    status: 'copied', sourceManifest: source, expected, observed, injected: inject,
    rows: await rowCounts(pool, CANDIDATE_SCHEMA),
  };
}

export async function down(cfg: DrillConfig, pool: Pool): Promise<TransferResult> {
  await verifyLiveFixture(pool, cfg);
  const source = await readManifest(pool, SOURCE_SCHEMA, 'source');
  const candidate = await readManifest(pool, CANDIDATE_SCHEMA, 'candidate');
  const problems = checkDownRepresentable(candidate);
  if (problems.length > 0) {
    throw new DrillError('down-irreversible',
      'candidate rows cannot be represented losslessly in DDL 140; refusing to down-migrate', problems);
  }
  const expected = expectedFrom('restore', RESTORE_SCHEMA, candidate);
  const restoreCounts = await rowCounts(pool, RESTORE_SCHEMA);
  if (!isEmpty(restoreCounts)) {
    const observed = await readManifest(pool, RESTORE_SCHEMA, 'restore');
    if (observed.sha256 === expected.sha256) {
      return { status: 'no-op', sourceManifest: source, expected, observed, injected: null, rows: restoreCounts };
    }
    throw new DrillError('target-drift',
      'restore target is not empty and does not match the candidate manifest; refusing to overwrite', {
        counts: restoreCounts, expected: expected.sha256, observed: observed.sha256,
      });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    try {
      for (const table of COPY_ORDER) {
        await insertRows(connection, RESTORE_SCHEMA, table, candidate.tables[table], 'down');
      }
      await connection.commit();
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // Keep the original failure.
      }
      throw error;
    }
  } finally {
    connection.release();
  }

  const observed = await readManifest(pool, RESTORE_SCHEMA, 'restore');
  if (observed.sha256 !== expected.sha256) {
    throw new DrillError('verify-failed', 'restore manifest differs from the expected copy');
  }
  const candidateAfter = await readManifest(pool, CANDIDATE_SCHEMA, 'candidate');
  if (candidateAfter.sha256 !== candidate.sha256) {
    throw new DrillError('candidate-mutated', 'candidate manifest changed during the down copy');
  }
  const sourceAfter = await readManifest(pool, SOURCE_SCHEMA, 'source');
  if (sourceAfter.sha256 !== source.sha256) {
    throw new DrillError('source-mutated', 'source manifest changed during the down copy');
  }
  return {
    status: 'copied', sourceManifest: source, expected, observed, injected: null,
    rows: await rowCounts(pool, RESTORE_SCHEMA),
  };
}

// ---------------------------------------------------------------------- seed

const RELEASE = `mysql-basic@1.0.0#sha256:${'a'.repeat(64)}`;

/**
 * Representative pre-existing aggregate in the 140 source schema: nullable
 * actors/timestamps, a published version and pointer, multiple item versions and
 * JSON with empty/comma/Unicode keys. No real ACL or credential data is copied.
 */
export async function seedSource(pool: Pool): Promise<Manifest> {
  const counts = await rowCounts(pool, SOURCE_SCHEMA);
  if (!isEmpty(counts)) {
    throw new DrillError('source-not-empty', 'source schema is not empty; recreate the fixture before seeding', counts);
  }
  const capabilities = () => ({
    discovery: { contract_version: '1.0.0', ref: null, executable: false },
    graphs: { contract_version: '1.0.0', ref: null, executable: false },
  });
  const itemChain = (base: unknown) => ({
    actor_id: 7, request_id: 'req-t2b', base, created_at: '2026-01-01T00:00:00.1Z',
    published_at: '2026-01-01T00:00:00.1Z', retired_at: null, migration_ref: null,
  });
  const versionChain = (publishedAt: string, retiredAt: string | null) => JSON.stringify({
    actor_id: 7, request_id: 'req-t2b', base: null, created_at: '2026-01-01T00:00:00.1Z',
    published_at: publishedAt, retired_at: retiredAt, migration_ref: null,
  });
  const draftAggregate = (templateId: string, version: number) => JSON.stringify({
    template_id: templateId, base: null,
    items: [{ item_id: 'uptime', version }],
    triggers: [], parameters: { schema: { interval_ms: { type: 'integer', min: 1000 } }, defaults: {} },
    capabilities: capabilities(),
  });
  const itemSnapshot = (
    version: number, displayName: string, base: unknown,
  ) => ({
    template_id: 'tpl-legacy-a', item_id: 'uptime', version, display_name: displayName,
    canonical_metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, unit: 's',
    dimensions: { '主机': '主机标识' },
    collector_ref: { package_release: RELEASE, implementation_id: 'builtin:mysql.status.v1' },
    params_default: {}, source_chain: itemChain(base),
  });
  const publishedAggregate = (version: number) => JSON.stringify({
    template_id: 'tpl-legacy-a', base: null,
    items: [{ item_id: 'uptime', version }],
    triggers: [], parameters: { schema: { interval_ms: { type: 'integer', min: 1000 } }, defaults: {} },
    capabilities: capabilities(),
    package_composition: [{ release: RELEASE, items: ['uptime'] }],
  });
  const composition = JSON.stringify([{ release: RELEASE, items: ['uptime'] }]);
  const inserts: [string, string, unknown[]][] = [
    ['max237_t2b_d1.metric_templates_v2',
      'INSERT INTO max237_t2b_d1.metric_templates_v2 (template_id, name, status, current_published_version, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['tpl-legacy-a', 'Legacy A', 'active', 2, 5, 2147483647, '1000-01-01 00:00:00.000', '2026-10-27 12:34:56.789']],
    ['max237_t2b_d1.metric_templates_v2',
      'INSERT INTO max237_t2b_d1.metric_templates_v2 (template_id, name, status, current_published_version, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['tpl-legacy-b', 'Legacy B', 'draft', null, 0, null, '1000-01-01 00:00:00.000', '1000-01-01 00:00:00.000']],
    ['max237_t2b_d1.metric_template_drafts',
      'INSERT INTO max237_t2b_d1.metric_template_drafts (template_id, revision, aggregate, published_version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['tpl-legacy-a', 5, draftAggregate('tpl-legacy-a', 2), 2, null, '2026-10-27 12:34:56.789']],
    ['max237_t2b_d1.metric_template_drafts',
      'INSERT INTO max237_t2b_d1.metric_template_drafts (template_id, revision, aggregate, published_version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['tpl-legacy-b', 0, draftAggregate('tpl-legacy-b', 1), null, null, '1000-01-01 00:00:00.000']],
    ['max237_t2b_d1.metric_template_items',
      'INSERT INTO max237_t2b_d1.metric_template_items (template_id, item_id, status, created_at) VALUES (?, ?, ?, ?)',
      ['tpl-legacy-a', 'queries', 'active', '2026-01-02 03:04:05.006']],
    ['max237_t2b_d1.metric_template_items',
      'INSERT INTO max237_t2b_d1.metric_template_items (template_id, item_id, status, created_at) VALUES (?, ?, ?, ?)',
      ['tpl-legacy-a', 'uptime', 'active', '2026-01-02 03:04:05.006']],
    ['max237_t2b_d1.metric_template_item_versions',
      'INSERT INTO max237_t2b_d1.metric_template_item_versions (template_id, item_id, version, display_name, canonical_metric_id, canonical_semantic_version, unit, dimensions, collector_ref, params_default, source_chain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['tpl-legacy-a', 'queries', 1, 'Queries', 'mysql.queries.total', '1.0.0', 'count', JSON.stringify({ '': 'empty key', 'db,host': 'comma key' }), JSON.stringify({ package_release: RELEASE, implementation_id: 'builtin:mysql.status.v1' }), '{}', JSON.stringify(itemChain(null))]],
    ['max237_t2b_d1.metric_template_item_versions',
      'INSERT INTO max237_t2b_d1.metric_template_item_versions (template_id, item_id, version, display_name, canonical_metric_id, canonical_semantic_version, unit, dimensions, collector_ref, params_default, source_chain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['tpl-legacy-a', 'uptime', 1, 'Uptime', 'db.uptime_seconds', '1.0.0', 's', JSON.stringify({ '主机': '主机标识' }), JSON.stringify({ package_release: RELEASE, implementation_id: 'builtin:mysql.status.v1' }), '{}', JSON.stringify(itemChain(null))]],
    ['max237_t2b_d1.metric_template_item_versions',
      'INSERT INTO max237_t2b_d1.metric_template_item_versions (template_id, item_id, version, display_name, canonical_metric_id, canonical_semantic_version, unit, dimensions, collector_ref, params_default, source_chain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['tpl-legacy-a', 'uptime', 2, 'Database uptime', 'db.uptime_seconds', '1.0.0', 's', JSON.stringify({ '主机': '主机标识' }), JSON.stringify({ package_release: RELEASE, implementation_id: 'builtin:mysql.status.v1' }), '{}', JSON.stringify(itemChain({ kind: 'item', template_id: 'tpl-legacy-a', id: 'uptime', version: 1 }))]],
    ['max237_t2b_d1.metric_template_versions',
      'INSERT INTO max237_t2b_d1.metric_template_versions (template_id, version, status, content_hash, aggregate, items, package_composition, source_chain, published_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['tpl-legacy-a', 1, 'retired', `sha256:${'1'.repeat(64)}`, publishedAggregate(1), JSON.stringify([itemSnapshot(1, 'Uptime', null)]), composition, versionChain('2026-01-02T03:04:05.006Z', '2026-02-03T04:05:06.120Z'), '2026-01-02 03:04:05.006', '2026-02-03 04:05:06.120']],
    ['max237_t2b_d1.metric_template_versions',
      'INSERT INTO max237_t2b_d1.metric_template_versions (template_id, version, status, content_hash, aggregate, items, package_composition, source_chain, published_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['tpl-legacy-a', 2, 'published', `sha256:${'2'.repeat(64)}`, publishedAggregate(2), JSON.stringify([itemSnapshot(2, 'Database uptime', { kind: 'item', template_id: 'tpl-legacy-a', id: 'uptime', version: 1 })]), composition, versionChain('2026-10-27T00:00:00.500Z', null), '2026-10-27 00:00:00.500', null]],
  ];
  for (const [, sql, values] of inserts) await pool.query(sql, values);
  return readManifest(pool, SOURCE_SCHEMA, 'source');
}

// ----------------------------------------------------------------------- CLI

interface CliOptions {
  mode: 'plan' | 'seed' | 'execute' | 'verify';
  direction: 'up' | 'down' | null;
  inject: string | null;
}

export function parseArgs(argv: string[]): CliOptions {
  const [mode, ...rest] = argv;
  const options: CliOptions = {
    mode: (mode ?? 'plan') as CliOptions['mode'], direction: null, inject: null,
  };
  if (!['plan', 'seed', 'execute', 'verify'].includes(options.mode)) {
    throw new DrillError('usage', `unknown mode ${JSON.stringify(mode)}`);
  }
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === 'up' || arg === 'down') options.direction = arg;
    else if (arg === '--inject') options.inject = rest[++index] ?? null;
    else throw new DrillError('usage', `unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.mode === 'execute' && options.direction === null) {
    throw new DrillError('usage', 'execute requires an explicit up|down direction');
  }
  return options;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<unknown> {
  const options = parseArgs(argv);
  const cfg = loadConfig();
  // Plan never opens a connection (and the guard proves it in the drill).
  if (options.mode === 'plan') {
    return {
      mode: 'plan',
      connects: false,
      writes: false,
      handle: cfg.handlePath,
      container: cfg.handle.container_name,
      schemas: cfg.handle.schemas,
      direction: options.direction,
      inject: options.inject,
      steps: options.direction === 'down'
        ? ['verify candidate representable in DDL 140', 'copy into empty restore schema in one transaction']
        : ['preflight source/target', 'copy parent → draft/items → item versions → template versions in one target transaction'],
    };
  }
  if (process.env.MAX237_T2B_FORBID_CONNECT === '1') {
    throw new DrillError('connection-forbidden', 'MAX237_T2B_FORBID_CONNECT=1 forbids opening a connection');
  }
  const pool = openPool(cfg);
  try {
    if (options.mode === 'seed') return { mode: 'seed', manifest: await seedSource(pool) };
    if (options.mode === 'verify') {
      await verifyLiveFixture(pool, cfg);
      return {
        mode: 'verify',
        source: await readManifest(pool, SOURCE_SCHEMA, 'source'),
        candidate: await readManifest(pool, CANDIDATE_SCHEMA, 'candidate'),
        restore: await readManifest(pool, RESTORE_SCHEMA, 'restore'),
      };
    }
    return options.direction === 'down'
      ? { mode: 'execute', direction: 'down', result: await down(cfg, pool) }
      : { mode: 'execute', direction: 'up', result: await up(cfg, pool, options.inject) };
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  runCli()
    .then(result => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      const payload = error instanceof DrillError
        ? { reason: error.reason, message: error.message, detail: error.detail }
        : { reason: 'error', message: String((error as Error)?.message ?? error) };
      process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exitCode = 1;
    });
}
