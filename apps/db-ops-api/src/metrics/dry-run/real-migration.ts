/**
 * MAX-236 / P0-REAL-A: executable migration and rollback on the *real* platform
 * schema, inside the task's own disposable, non-production acceptance database.
 *
 * Why this file exists: the three-class rehearsal in `migration-drill.ts` and
 * `migration-drill-fixture.test.ts` runs on a purpose-built fixture schema. The
 * P0 acceptance item asks for a real migration/rollback with history, credential
 * references, ACL, revision and audit preserved — so this executor reads and
 * writes the actual platform tables (`metric_policy_bindings`,
 * `metric_policy_audit`, `metric_policy_lock`, `metric_schedule`,
 * `metric_observations`, `metric_publications`, `metrics_history`, `alerts`,
 * `instance_permissions`, `audit_log_entries`, the three resource tables) and
 * reuses the accepted reference model's `dispose` rules for what may move.
 *
 * Hard boundaries, by design:
 * - it is **not** registered in the application, has no route and no startup
 *   wiring; `scripts/max236-migrate.ts` / `max236-rollback.ts` are the only
 *   entry points and they refuse any endpoint that does not match the exact
 *   creation-record handle (`assertOwnedEndpoint`) *before* opening a connection;
 * - `metric_policy_bindings.payload.binding` stays the single authority. No
 *   `template_pins`/`template_revision` column, no second binding table and no
 *   `migration_digest` field is added; the plan digest is recorded in the real
 *   `metric_policy_audit.request_id`, which is what the replay check reads;
 * - the multi-pin *resolved* plan does not exist yet (S3/P1). The executor
 *   therefore refuses a binding that already carries a compiled `resolved`
 *   plan and writes `resolved: null` + `application.status: 'pending'`: it can
 *   never let an old single-package consumer silently ignore new pins. That
 *   also means a successful apply here is an isolated-library result, not a
 *   production cutover;
 * - secret *values* are never read. Credential preservation compares an
 *   in-database SHA-256 of the ciphertext and its presence, never the ciphertext
 *   itself.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createConnection } from 'mysql2/promise';
import type { Connection, ConnectionOptions } from 'mysql2/promise';
import {
  dispose, digestOf, planDigest,
  type IdentityInput, type PlanRow, type ResourceType, type TemplatePin,
} from './migration-drill.js';

const run = promisify(execFile);

/** Bumped whenever the write protocol or a guard changes; bound into every digest. */
export const EXECUTOR_VERSION = 'max236-real-a/4';
export const PLAN_VERSION = 2;
export const MIGRATE_REQUEST_PREFIX = 'max236-migrate:';
export const ROLLBACK_REQUEST_PREFIX = 'max236-rollback:';
export const BASELINE_REQUEST_PREFIX = 'max236-baseline:';

/**
 * The plan binds the actual executor code, not only a version string. Reading
 * this module's own source is the only non-forgeable fingerprint available to a
 * script (a caller-supplied "version" is not evidence).
 */
export const EXECUTOR_CODE_FINGERPRINT: string = (() => {
  try {
    return digestOf(readFileSync(fileURLToPath(import.meta.url), 'utf8'));
  } catch {
    return '';
  }
})();

const HASH = /^sha256:[a-f0-9]{64}$/;
const CREDENTIAL_REF = /^credential:[A-Za-z0-9_.:=-]{1,200}$/;
const MAX_CONTENT_ROWS = 20000;
/**
 * The creation record publishes the endpoint on the IPv4 loopback address, and
 * `assertOwnedEndpoint` verifies exactly that binding. `localhost` is NOT
 * equivalent: it may resolve to `::1` and is a different socket than the
 * inspected `127.0.0.1:<port>` publication, so it is refused.
 */
const LOOPBACK_HOST = '127.0.0.1';
/** Every connection and statement is bounded; a hung inspect/read is a refusal, not a hang. */
export const CONNECT_TIMEOUT_MS = 10_000;
export const STATEMENT_TIMEOUT_MS = 120_000;
export const LOCK_WAIT_TIMEOUT_SECONDS = 30;
const OWNED_DATABASE = /^max236_[a-z0-9_]{1,48}$/;
const RESOURCE_KEY = /^(instance|server|network_device):[1-9][0-9]*$/;

/** Tables whose exact column shape a plan is bound to. Fixed list, never caller input. */
export const FINGERPRINT_TABLES = [
  'alerts', 'audit_log_entries', 'database_instances', 'instance_permissions', 'metric_definitions',
  'metric_observations', 'metric_policy_audit', 'metric_policy_bindings', 'metric_policy_groups',
  'metric_policy_lock', 'metric_publications', 'metric_rollout', 'metric_schedule',
  'metric_template_items', 'metric_template_item_versions', 'metric_template_versions', 'metric_templates_v2',
  'metrics_history', 'network_device_credentials', 'network_device_observations', 'network_devices',
  'server_metrics', 'servers',
] as const;

/** Template tables come from the candidate S8 DDL (140), applied only in the isolated library. */
const TEMPLATE_TABLES = ['metric_templates_v2', 'metric_template_versions'];

/** Tables whose full row content is part of the preservation proof. */
const CONTENT_TABLES = [
  'alerts', 'metrics_history', 'metric_observations', 'metric_publications',
  'network_device_observations', 'server_metrics',
] as const;
const PLATFORM_AUDIT_TABLE = 'audit_log_entries';
const ACL_TABLE = 'instance_permissions';

export type RealResourceType = 'instance' | 'server' | 'network_device';
export interface RealResourceRef { type: RealResourceType; id: number }
export const realResourceKey = (ref: RealResourceRef): string => `${ref.type}:${ref.id}`;

export class RealRefusal extends Error {
  constructor(readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = 'RealRefusal';
  }
}
function refuse(code: string, details: Record<string, unknown> = {}): never {
  throw new RealRefusal(code, details);
}

/* ------------------------------------------------------------------ */
/* Owned-target handle and endpoint verification                      */
/* ------------------------------------------------------------------ */

/**
 * The exact resources this phase created, recorded by `env-start.sh` when it
 * created them. Nothing here is caller-invented at write time: the CLI reads
 * this record and re-inspects the live Docker objects before connecting.
 */
export interface OwnedTargetHandle {
  owner: string;
  phase: string;
  container_id: string;
  container_name: string;
  image: string;
  network: string;
  network_id: string;
  volume: string;
  volume_destination: string;
  volume_labels: Record<string, string>;
  port: number;
  database: string;
  user: string;
  /** This phase uses the disposable container's empty password; anything else is a foreign credential source. */
  password: 'empty';
  /** Resources this phase may write. A manifest cannot extend it. */
  resources: string[];
  created_at: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isStringMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every(item => typeof item === 'string');

/** Strict parse of the creation record. Missing or malformed means "do not connect". */
export function parseHandle(input: unknown): OwnedTargetHandle {
  if (!isRecord(input)) refuse('REAL_TARGET_HANDLE_INVALID');
  const handle = input as Record<string, unknown>;
  const text = (field: string): string => {
    const value = handle[field];
    if (typeof value !== 'string' || value.length === 0) refuse('REAL_TARGET_HANDLE_INVALID', { field });
    return value;
  };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(text('owner'))) refuse('REAL_TARGET_HANDLE_INVALID', { field: 'owner' });
  if (text('phase') !== 'P0-REAL-A') refuse('REAL_TARGET_HANDLE_INVALID', { field: 'phase' });
  if (!/^[a-f0-9]{64}$/.test(text('container_id'))) refuse('REAL_TARGET_HANDLE_INVALID', { field: 'container_id' });
  if (!/^[a-f0-9]{64}$/.test(text('network_id'))) refuse('REAL_TARGET_HANDLE_INVALID', { field: 'network_id' });
  if (!HASH.test(text('image'))) refuse('REAL_TARGET_HANDLE_INVALID', { field: 'image' });
  if (!OWNED_DATABASE.test(text('database'))) refuse('REAL_TARGET_HANDLE_INVALID', { field: 'database' });
  if (text('volume_destination') !== '/var/lib/mysql') refuse('REAL_TARGET_HANDLE_INVALID', { field: 'volume_destination' });
  const port = handle.port;
  if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535) {
    refuse('REAL_TARGET_HANDLE_INVALID', { field: 'port' });
  }
  const labels = handle.volume_labels;
  if (!isStringMap(labels)) refuse('REAL_TARGET_HANDLE_INVALID', { field: 'volume_labels' });
  const resources = handle.resources;
  if (!Array.isArray(resources) || resources.length === 0
    || resources.some(item => typeof item !== 'string' || !RESOURCE_KEY.test(item))) {
    refuse('REAL_TARGET_HANDLE_INVALID', { field: 'resources' });
  }
  if (handle.password !== 'empty') refuse('REAL_TARGET_HANDLE_INVALID', { field: 'password' });
  return {
    owner: text('owner'),
    phase: text('phase'),
    container_id: text('container_id'),
    container_name: text('container_name'),
    image: text('image'),
    network: text('network'),
    network_id: text('network_id'),
    volume: text('volume'),
    volume_destination: text('volume_destination'),
    volume_labels: labels,
    port: port as number,
    database: text('database'),
    user: text('user'),
    password: 'empty',
    resources: resources as string[],
    created_at: text('created_at'),
  };
}

export interface InspectedContainer {
  id: string;
  name: string;
  image: string;
  running: boolean;
  labels: Record<string, string>;
  mounts: Array<{ type: string; name?: string; destination: string }>;
  networks: string[];
  network_ids: string[];
  published: Array<{ host_ip: string; host_port: number; container_port: number }>;
}
export interface InspectedNetwork { id: string; name: string; labels: Record<string, string> }
export interface InspectedVolume { name: string; labels: Record<string, string> }
export interface EndpointInspection {
  container: InspectedContainer;
  network: InspectedNetwork;
  volume: InspectedVolume;
}

/**
 * Fresh `docker inspect` of the exact IDs in the creation record. Never inspects
 * by name: a same-named replacement is a different object and must be refused.
 */
export async function inspectOwnedTarget(handle: OwnedTargetHandle): Promise<EndpointInspection> {
  const inspect = async (args: string[]): Promise<Record<string, unknown>> => {
    const { stdout } = await run('docker', args, { timeout: 10000 });
    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
    const first = parsed[0];
    if (!first) refuse('REAL_TARGET_CONTAINER_UNKNOWN');
    return first;
  };
  const containerRaw = await inspect(['inspect', '--type', 'container', handle.container_id]);
  const networkRaw = await inspect(['network', 'inspect', handle.network_id]);
  const volumeRaw = await inspect(['volume', 'inspect', handle.volume]);
  const config = (containerRaw.Config ?? {}) as { Labels?: Record<string, string> | null };
  const state = (containerRaw.State ?? {}) as { Running?: boolean };
  const mounts = (containerRaw.Mounts ?? []) as Array<{ Type?: string; Name?: string; Destination?: string }>;
  const networkSettings = (containerRaw.NetworkSettings ?? {}) as {
    Networks?: Record<string, { NetworkID?: string }>;
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  const ports: InspectedContainer['published'] = [];
  for (const [key, bindings] of Object.entries(networkSettings.Ports ?? {})) {
    const containerPort = Number(key.split('/')[0]);
    for (const binding of bindings ?? []) {
      ports.push({ host_ip: binding.HostIp ?? '', host_port: Number(binding.HostPort ?? 0), container_port: containerPort });
    }
  }
  return {
    container: {
      id: String(containerRaw.Id ?? ''),
      name: String(containerRaw.Name ?? ''),
      image: String(containerRaw.Image ?? ''),
      running: state.Running === true,
      labels: config.Labels ?? {},
      mounts: mounts.map(mount => ({ type: mount.Type ?? '', name: mount.Name, destination: mount.Destination ?? '' })),
      networks: Object.keys(networkSettings.Networks ?? {}),
      network_ids: Object.values(networkSettings.Networks ?? {}).map(network => String(network.NetworkID ?? '')),
      published: ports,
    },
    network: {
      id: String(networkRaw.Id ?? ''),
      name: String(networkRaw.Name ?? ''),
      labels: ((networkRaw.Labels ?? {}) as Record<string, string>),
    },
    volume: {
      name: String(volumeRaw.Name ?? ''),
      labels: ((volumeRaw.Labels ?? {}) as Record<string, string>),
    },
  };
}

export interface EndpointOptions {
  /** Test/harness-only: the disposable test database this endpoint may create. */
  allow_database?: string;
  require_running?: boolean;
}

const endpointFailure = (code: string, details: Record<string, unknown> = {}): never => refuse(code, details);

/**
 * Proves the DSN names the exact endpoint recorded at creation time. Runs BEFORE
 * `createConnection`: unknown/remote hosts, non-recorded IDs, a changed owner,
 * phase, image, mount, network or published port all refuse without a socket.
 */
export function assertOwnedEndpoint(dsn: string, handle: OwnedTargetHandle, inspection: EndpointInspection, options: EndpointOptions = {}): void {
  let url: URL;
  try { url = new URL(dsn); } catch { refuse('REAL_DSN_INVALID'); }
  if (url.protocol !== 'mysql:') refuse('REAL_DSN_INVALID', { protocol: url.protocol });
  if (url.hostname !== LOOPBACK_HOST) endpointFailure('REAL_TARGET_DSN_REMOTE', { hostname: url.hostname });
  if (decodeURIComponent(url.password) !== '') endpointFailure('REAL_TARGET_CREDENTIAL_SOURCE_REFUSED');
  if (decodeURIComponent(url.username) !== handle.user) endpointFailure('REAL_TARGET_USER_MISMATCH');
  if (Number(url.port || 3306) !== handle.port) endpointFailure('REAL_TARGET_PORT_MISMATCH', { port: url.port || '3306' });
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database) {
    if (database !== handle.database) endpointFailure('REAL_TARGET_DATABASE_MISMATCH', { database });
  } else {
    const allowed = options.allow_database;
    if (!allowed || !OWNED_DATABASE.test(allowed) || allowed === handle.database) {
      endpointFailure('REAL_TARGET_DATABASE_MISMATCH', { database: allowed ?? '' });
    }
  }

  const container = inspection.container;
  if (options.require_running !== false && !container.running) endpointFailure('REAL_TARGET_NOT_RUNNING');
  if (container.id !== handle.container_id) endpointFailure('REAL_TARGET_CONTAINER_ID_MISMATCH');
  if (container.labels['max236.owner'] !== handle.owner) endpointFailure('REAL_TARGET_OWNER_REFUSED', { owner: container.labels['max236.owner'] ?? '' });
  if (container.labels['max236.phase'] !== handle.phase) endpointFailure('REAL_TARGET_PHASE_REFUSED', { phase: container.labels['max236.phase'] ?? '' });
  if (container.image !== handle.image) endpointFailure('REAL_TARGET_IMAGE_MISMATCH');
  if (container.mounts.length !== 1
    || container.mounts[0]?.type !== 'volume'
    || container.mounts[0]?.name !== handle.volume
    || container.mounts[0]?.destination !== handle.volume_destination) {
    endpointFailure('REAL_TARGET_MOUNT_MISMATCH');
  }
  if (container.networks.length !== 1 || container.networks[0] !== handle.network
    || container.network_ids?.length !== 1 || container.network_ids[0] !== handle.network_id
    || inspection.network.id !== handle.network_id) {
    endpointFailure('REAL_TARGET_NETWORK_MISMATCH');
  }
  if (inspection.network.labels['max236.owner'] !== handle.owner
    || inspection.network.labels['max236.phase'] !== handle.phase) {
    endpointFailure('REAL_TARGET_NETWORK_MISMATCH', { field: 'network_labels' });
  }
  if (inspection.volume.name !== handle.volume
    || inspection.volume.labels['max236.owner'] !== handle.owner
    || inspection.volume.labels['max236.phase'] !== handle.phase) {
    endpointFailure('REAL_TARGET_MOUNT_MISMATCH', { field: 'volume_labels' });
  }
  if (container.published.length !== 1
    || container.published[0]?.host_ip !== '127.0.0.1'
    || container.published[0]?.host_port !== handle.port
    || container.published[0]?.container_port !== 3306) {
    endpointFailure('REAL_TARGET_PORT_BINDING_MISMATCH');
  }
}

/* ------------------------------------------------------------------ */
/* SQL session                                                         */
/* ------------------------------------------------------------------ */

/**
 * The minimal surface this executor needs. Keeping it this small is what lets
 * the pure plan/replay rules be unit-tested without a server and the MySQL
 * suite exercise the exact same code over one explicit connection.
 */
export interface SqlSession {
  query<R = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<R[]>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Text protocol on purpose: `IN (?)` array expansion is used by the history reads. */
export function mysqlSession(connection: Connection): SqlSession {
  return {
    query: async <R>(sql: string, values: unknown[] = []) => {
      const [rows] = await connection.query(sql, values);
      return rows as R[];
    },
    begin: () => connection.beginTransaction(),
    commit: () => connection.commit(),
    rollback: () => connection.rollback(),
  };
}

export interface RealSessionHandle {
  session: SqlSession;
  close(): Promise<void>;
  inspection: EndpointInspection;
}

/**
 * The socket is built from the INSPECTED endpoint, never from the caller's URL
 * text: the host is the verified `127.0.0.1` publication and the port is the
 * recorded handle port. Connect, statement and lock waits are all bounded so a
 * stalled target is a refusal instead of a hang.
 */
function connectionConfig(handle: OwnedTargetHandle, database: string): ConnectionOptions {
  const published = handle.port;
  const config: ConnectionOptions = {
    host: LOOPBACK_HOST,
    port: published,
    user: handle.user,
    password: '',
    timezone: 'Z',
    multipleStatements: false,
    connectTimeout: CONNECT_TIMEOUT_MS,
  };
  if (database) config.database = database;
  return config;
}

export interface RealSessionOptions extends EndpointOptions {
  /** Injecting the inspection lets a no-network test prove refusal happens before connect. */
  inspect?: (handle: OwnedTargetHandle) => Promise<EndpointInspection>;
  /** A connector that throws is enough to prove no connection is attempted on refusal. */
  connect?: (config: ConnectionOptions) => Promise<Connection>;
}

/**
 * Verify ownership first, connect second. The DSN is parsed only to check it
 * against the creation record; no error message echoes the URL and the password
 * (empty in this phase) is only handed to mysql2. After connecting, the session
 * bounds statement time and lock waits on that same connection.
 */
export async function openRealSession(dsn: string, handle: OwnedTargetHandle, options: RealSessionOptions = {}): Promise<RealSessionHandle> {
  const inspection = await (options.inspect ?? inspectOwnedTarget)(handle);
  assertOwnedEndpoint(dsn, handle, inspection, options);
  const url = new URL(dsn);
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || options.allow_database || '';
  const connection = await (options.connect ?? createConnection)(connectionConfig(handle, database));
  const session = mysqlSession(connection);
  try {
    await session.query('SET SESSION innodb_lock_wait_timeout = ?', [LOCK_WAIT_TIMEOUT_SECONDS]);
    await session.query('SET SESSION max_execution_time = ?', [STATEMENT_TIMEOUT_MS]);
  } catch (error) {
    await connection.end().catch(() => undefined);
    throw error;
  }
  return { session, close: () => connection.end(), inspection };
}

export interface VerifiedSessionHandle extends RealSessionHandle {
  facts: WritableTargetFacts;
}

/**
 * Ownership is verified before connecting; the live connection identity
 * (hostname, database, version, owner/phase labels) is verified before ANY
 * snapshot read. A connection that is not the recorded container/database is
 * closed and refused, so no SELECT can run against a foreign target.
 */
export async function openVerifiedSession(dsn: string, handle: OwnedTargetHandle, options: RealSessionOptions = {}): Promise<VerifiedSessionHandle> {
  const opened = await openRealSession(dsn, handle, options);
  try {
    const facts = await targetFacts(opened.session, opened.inspection.container);
    assertTargetIdentity(facts, handle);
    return { ...opened, facts };
  } catch (error) {
    await opened.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Default (read-only) plan reads must come from ONE consistent snapshot: the
 * identity/state SELECTs otherwise run in autocommit and can straddle a
 * concurrent publish. Starts an explicit REPEATABLE READ, READ ONLY transaction
 * on the same connection, verifies the resulting transaction state, and always
 * rolls back (never commits) — a failed read leaves no transaction behind.
 */
export async function beginReadOnlySnapshot(session: SqlSession): Promise<void> {
  await session.query(`SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
  await session.query('START TRANSACTION READ ONLY');
  try {
    // `@@transaction_read_only` still reports the session default, so the ACTIVE
    // transaction itself is read from performance_schema. No row means the
    // engine could not prove the mode: fail closed rather than assume.
    const [state] = await session.query<{ isolation: string; access_mode: string }>(
      `SELECT t.ISOLATION_LEVEL AS isolation, t.ACCESS_MODE AS access_mode
       FROM performance_schema.events_transactions_current t
       WHERE t.THREAD_ID = PS_CURRENT_THREAD_ID() AND t.STATE = 'ACTIVE'`);
    if (!state) refuse('REAL_READ_SNAPSHOT_UNKNOWN');
    if (state.isolation !== 'REPEATABLE READ') {
      refuse('REAL_READ_SNAPSHOT_ISOLATION_MISMATCH', { isolation: state.isolation });
    }
    if (state.access_mode !== 'READ ONLY') refuse('REAL_READ_SNAPSHOT_NOT_READ_ONLY', { access_mode: state.access_mode });
  } catch (error) {
    await session.rollback().catch(() => undefined);
    throw error;
  }
}

/** Reads one consistent, verified read-only snapshot and always releases the transaction. */
export async function readConsistentSnapshot(session: SqlSession, resource: RealResourceRef): Promise<RealSnapshot> {
  await beginReadOnlySnapshot(session);
  try {
    return await readRealSnapshot(session, resource);
  } finally {
    await session.rollback();
  }
}

const parseJson = <T>(value: unknown): T =>
  (typeof value === 'string' ? JSON.parse(value) : value) as T;

const asNumber = (value: unknown, code: string): number => {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 0) refuse(code);
  return number;
};

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

export interface RealPackagePin { id: string; version: string; digest: string }
export interface RealApplicationState {
  applied_revision: number | null;
  reported_at: string | null;
  status: string | null;
  error_code: string | null;
}
export interface RealBinding {
  revision: number;
  package: RealPackagePin | null;
  template_pins: TemplatePin[];
  group_id: string | null;
  overrides: Record<string, unknown>;
  /** `resolved` as stored. A non-null value means a compiled plan we cannot reproduce. */
  resolved: unknown;
  application: RealApplicationState;
}

/** One revision as recorded by the real publish audit; the only revision history that exists. */
export interface RealRevisionRecord {
  revision: number;
  audit_id: number;
  request_id: string;
  package: RealPackagePin | null;
  template_pins: TemplatePin[];
  group_id: string | null;
  overrides: Record<string, unknown>;
  at: string | null;
  /** The complete pre-rollback baseline a rollback bound, recorded with its audit row. */
  baseline: RealBindingBaseline | null;
}

/** One immutable published template version (candidate table 140). */
export interface RealTemplateVersion {
  content_hash: string;
  status: string;
  retired_at: string | null;
  aggregate_ok: boolean;
  items_ok: boolean;
}
/** A template row and its immutable versions. */
export interface RealTemplateEntry {
  status: string;
  versions: Record<number, RealTemplateVersion>;
}

export interface ContentBlock { table: string; count: number; digest: string; truncated: boolean }
export interface AuditEntryDigest { id: number; request_id: string; digest: string }
export interface CredentialRef { ref: string; present: boolean; digest: string }

export interface RealPreservationSnapshot {
  history: ContentBlock[];
  credentials: CredentialRef[];
  acl: { supported: boolean; count: number; digest: string; truncated: boolean; rows: string[]; reason?: string };
  schedules: { count: number; rows: Array<{ job_id: string | null; digest: string }>; truncated: boolean };
  events: { supported: boolean; count: number; digest: string; truncated: boolean; reason?: string };
  policy_audit: { count: number; entries: AuditEntryDigest[]; truncated: boolean };
  platform_audit: { count: number; entries: string[]; truncated: boolean };
}

export interface RealSnapshot {
  resource: RealResourceRef;
  resource_key: string;
  resource_type: RealResourceType;
  engine: string | null;
  resource_exists: boolean;
  binding: RealBinding | null;
  /** Digest of the whole binding payload — the immutable baseline a plan is bound to. */
  binding_payload_digest: string | null;
  /** `target_type:id` for the real `metric_definitions` catalog. Empty for network_device (no catalog table). */
  catalog: Record<string, { unit: string; is_collected: boolean }>;
  catalog_supported: boolean;
  templates: Record<string, RealTemplateEntry>;
  template_catalog_supported: boolean;
  schema_fingerprint: string;
  revisions: RealRevisionRecord[];
  preservation: RealPreservationSnapshot;
}

const resourceTables: Record<RealResourceType, string> = {
  instance: 'database_instances', server: 'servers', network_device: 'network_devices',
};

const catalogTargetType: Record<RealResourceType, string | null> = {
  instance: 'instance', server: 'server', network_device: null,
};

/**
 * Read everything a plan and its preservation proof need. Every statement is a
 * plain SELECT; the caller decides whether a write follows. Secret values are
 * never selected — only `credential:` reference identities, presence flags and
 * an in-database hash of the ciphertext.
 */
export async function readRealSnapshot(session: SqlSession, resource: RealResourceRef): Promise<RealSnapshot> {
  if (!Number.isInteger(resource.id) || resource.id <= 0) refuse('REAL_RESOURCE_INVALID');
  const resource_key = realResourceKey(resource);
  const schema_fingerprint = await readSchemaFingerprint(session);

  const resourceRow = (await session.query<Record<string, unknown>>(
    `SELECT id${resource.type === 'instance' ? ', db_type' : ''} FROM ${resourceTables[resource.type]} WHERE id = ?`, [resource.id]))[0];
  const engine = resource.type === 'instance' && typeof resourceRow?.db_type === 'string' ? resourceRow.db_type : null;

  const bindingRow = (await session.query<{ group_id: string | null; payload: unknown }>(
    'SELECT group_id, payload FROM metric_policy_bindings WHERE resource_key = ?', [resource_key]))[0];
  const binding = bindingRow ? parseRealBinding(bindingRow.payload) : null;
  if (bindingRow && (bindingRow.group_id ?? null) !== binding?.group_id) {
    // payload.binding.group_id and the real group_id column must agree; a split is fail-closed.
    refuse('REAL_BINDING_GROUP_INCONSISTENT');
  }
  const binding_payload_digest = bindingRow ? digestOf(parseJson(bindingRow.payload)) : null;

  const targetType = catalogTargetType[resource.type];
  const catalog: RealSnapshot['catalog'] = {};
  if (targetType) {
    for (const row of await session.query<{ id: string; target_type: string; unit: string; is_collected: number | boolean }>(
      'SELECT id, target_type, unit, is_collected FROM metric_definitions WHERE target_type = ? ORDER BY id', [targetType])) {
      catalog[`${row.target_type}:${row.id}`] = { unit: row.unit, is_collected: Boolean(row.is_collected) };
    }
  }

  const { templates, supported: template_catalog_supported } = await readTemplates(session);
  const revisions = await readRevisions(session, resource_key);
  const contentColumns = await readContentColumns(session);
  const preservation = await readPreservation(session, resource, contentColumns);

  return {
    resource, resource_key, resource_type: resource.type, engine,
    resource_exists: resourceRow !== undefined,
    binding, binding_payload_digest, catalog, catalog_supported: targetType !== null,
    templates, template_catalog_supported,
    schema_fingerprint, revisions, preservation,
  };
}

async function readTemplates(session: SqlSession): Promise<{ templates: Record<string, RealTemplateEntry>; supported: boolean }> {
  const present = await session.query<{ table_name: string }>(
    `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`, [TEMPLATE_TABLES]);
  if (present.length < TEMPLATE_TABLES.length) return { templates: {}, supported: false };
  const templates: Record<string, RealTemplateEntry> = {};
  for (const row of await session.query<{ template_id: string; status: string }>(
    'SELECT template_id, status FROM metric_templates_v2 ORDER BY template_id')) {
    templates[row.template_id] = { status: row.status, versions: {} };
  }
  for (const row of await session.query<{
    template_id: string; version: number; status: string; content_hash: string;
    retired_at: unknown; aggregate: unknown; items: unknown;
  }>(
    `SELECT template_id, version, status, content_hash, retired_at, aggregate, items
     FROM metric_template_versions ORDER BY template_id, version`)) {
    const entry = templates[row.template_id];
    if (!entry) continue;
    let aggregate: Record<string, unknown> | null = null;
    let items: unknown = null;
    try {
      aggregate = parseJson<Record<string, unknown>>(row.aggregate);
      items = parseJson(row.items);
    } catch {
      // Keep the raw failure as "not valid content"; the plan refuses the pin.
      aggregate = null;
    }
    entry.versions[row.version] = {
      content_hash: String(row.content_hash),
      status: String(row.status),
      retired_at: row.retired_at === null || row.retired_at === undefined ? null : String(row.retired_at),
      aggregate_ok: isRecord(aggregate) && Array.isArray(aggregate.items) && Array.isArray(aggregate.triggers),
      items_ok: Array.isArray(items),
    };
  }
  return { templates, supported: true };
}

/** Parse one stored binding payload. `application` is retained so replay can compare it too. */
export function parseRealBinding(payload: unknown): RealBinding {
  const decoded = parseJson<Record<string, unknown>>(payload);
  // Native template plans must go through their existing receipt/CAS writer.
  // Treating an envelope as legacy would discard the compiled plan and evidence.
  if (decoded?.envelope !== undefined || decoded?.pending !== undefined) refuse('REAL_NATIVE_BINDING_UNSUPPORTED');
  const raw = decoded?.binding;
  if (!raw || typeof raw !== 'object') refuse('REAL_RESOURCE_BINDING_INVALID', { field: 'binding' });
  const binding = raw as Record<string, unknown>;
  const revision = asNumber(binding.revision, 'REAL_RESOURCE_BINDING_INVALID');
  const pins = binding.template_pins === undefined || binding.template_pins === null
    ? [] : parsePins(binding.template_pins, 'REAL_RESOURCE_BINDING_INVALID');
  const packagePin = binding.package === null || binding.package === undefined
    ? null : parsePackagePin(binding.package);
  const application = (decoded.application && typeof decoded.application === 'object'
    ? decoded.application : {}) as Record<string, unknown>;
  return {
    revision,
    package: packagePin,
    template_pins: pins,
    group_id: typeof binding.group_id === 'string' ? binding.group_id : null,
    overrides: (binding.overrides && typeof binding.overrides === 'object' ? binding.overrides : {}) as Record<string, unknown>,
    resolved: decoded.resolved ?? null,
    application: {
      applied_revision: Number.isInteger(application.applied_revision) ? application.applied_revision as number : null,
      reported_at: typeof application.reported_at === 'string' ? application.reported_at : null,
      status: typeof application.status === 'string' ? application.status : null,
      error_code: typeof application.error_code === 'string' ? application.error_code : null,
    },
  };
}

function parsePackagePin(value: unknown): RealPackagePin {
  if (!value || typeof value !== 'object') refuse('REAL_BINDING_PACKAGE_INVALID');
  const pin = value as Record<string, unknown>;
  if (typeof pin.id !== 'string' || pin.id.length === 0
    || typeof pin.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pin.version)
    || typeof pin.digest !== 'string' || !HASH.test(pin.digest)) refuse('REAL_BINDING_PACKAGE_INVALID');
  return { id: pin.id, version: pin.version, digest: pin.digest };
}

/**
 * A rollback records the complete pre-rollback baseline with its own audit row,
 * so an exact re-run of the same command can reproduce the SAME plan digest
 * without rebinding whatever state the applied rollback produced.
 */
function parseBaseline(value: unknown): RealBindingBaseline | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) refuse('REAL_ROLLBACK_BASELINE_INVALID');
  const baseline = value;
  if (!Number.isInteger(baseline.revision) || (baseline.revision as number) < 0) refuse('REAL_ROLLBACK_BASELINE_INVALID');
  if (typeof baseline.payload_digest !== 'string' || !HASH.test(baseline.payload_digest)) refuse('REAL_ROLLBACK_BASELINE_INVALID');
  const application = isRecord(baseline.application) ? baseline.application : {};
  return {
    revision: baseline.revision as number,
    package: baseline.package == null ? null : parsePackagePin(baseline.package),
    template_pins: baseline.template_pins == null ? [] : parsePins(baseline.template_pins, 'REAL_ROLLBACK_BASELINE_INVALID'),
    group_id: typeof baseline.group_id === 'string' ? baseline.group_id : null,
    overrides: isRecord(baseline.overrides) ? baseline.overrides : {},
    resolved: baseline.resolved ?? null,
    application: {
      applied_revision: Number.isInteger(application.applied_revision) ? application.applied_revision as number : null,
      reported_at: typeof application.reported_at === 'string' ? application.reported_at : null,
      status: typeof application.status === 'string' ? application.status : null,
      error_code: typeof application.error_code === 'string' ? application.error_code : null,
    },
    payload_digest: baseline.payload_digest,
  };
}

export function parsePins(value: unknown, code = 'REAL_TEMPLATE_PIN_INVALID'): TemplatePin[] {
  if (!Array.isArray(value)) refuse(code);
  const pins = value.map(item => {
    if (!item || typeof item !== 'object') refuse(code);
    const pin = item as Record<string, unknown>;
    if (typeof pin.template_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(pin.template_id)
      || !Number.isInteger(pin.version) || (pin.version as number) <= 0
      || typeof pin.content_hash !== 'string' || !HASH.test(pin.content_hash)) refuse(code);
    return { template_id: pin.template_id, version: pin.version as number, content_hash: pin.content_hash };
  });
  const ids = pins.map(pin => pin.template_id);
  if (new Set(ids).size !== ids.length) refuse('REAL_TEMPLATE_PIN_DUPLICATE');
  return pins.sort((left, right) => (left.template_id < right.template_id ? -1 : left.template_id > right.template_id ? 1 : 0));
}

/**
 * The schema fingerprint covers columns, keys/constraints and the migration
 * ledger (id + checksum + status). A column digest alone would miss DDL
 * constraints and a migration applied after the plan was computed.
 */
async function readSchemaFingerprint(session: SqlSession): Promise<string> {
  const columns = await session.query<Record<string, unknown>>(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)
     ORDER BY TABLE_NAME, ORDINAL_POSITION`, [FINGERPRINT_TABLES as unknown as string[]]);
  const indexes = await session.query<Record<string, unknown>>(
    `SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)
     ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [FINGERPRINT_TABLES as unknown as string[]]);
  const ledger = await session.query<Record<string, unknown>>(
    'SELECT migration_id, checksum, status FROM app_schema_migrations ORDER BY migration_id');
  return digestOf({
    columns: columns.map(row => [row.TABLE_NAME, row.COLUMN_NAME, row.COLUMN_TYPE, row.IS_NULLABLE, row.COLUMN_KEY, row.EXTRA]),
    indexes: indexes.map(row => [row.TABLE_NAME, row.INDEX_NAME, row.SEQ_IN_INDEX, row.COLUMN_NAME, row.NON_UNIQUE, row.INDEX_TYPE]),
    ledger: ledger.map(row => [row.migration_id, row.checksum, row.status]),
  });
}

async function readRevisions(session: SqlSession, resource_key: string): Promise<RealRevisionRecord[]> {
  const rows = await session.query<{ id: number; payload: unknown }>(
    'SELECT id, payload FROM metric_policy_audit WHERE target = ? ORDER BY id', [resource_key]);
  const records = new Map<number, RealRevisionRecord>();
  for (const row of rows) {
    const payload = parseJson<Record<string, unknown>>(row.payload);
    if (!payload || typeof payload !== 'object') continue;
    const revision = payload.revision;
    if (!Number.isInteger(revision) || (revision as number) < 0) continue;
    const configuration = (payload.configuration && typeof payload.configuration === 'object'
      ? payload.configuration : {}) as Record<string, unknown>;
    const record: RealRevisionRecord = {
      revision: revision as number,
      audit_id: Number(row.id),
      request_id: typeof payload.request_id === 'string' ? payload.request_id : '',
      package: configuration.package == null ? null : parsePackagePin(configuration.package),
      template_pins: configuration.template_pins == null ? [] : parsePins(configuration.template_pins),
      group_id: typeof configuration.group_id === 'string' ? configuration.group_id : null,
      overrides: (configuration.overrides && typeof configuration.overrides === 'object'
        ? configuration.overrides : {}) as Record<string, unknown>,
      at: typeof payload.at === 'string' ? payload.at : null,
      baseline: parseBaseline(configuration.baseline),
    };
    // A target must publish each revision once; a duplicate is a data defect, keep the first.
    if (!records.has(record.revision)) records.set(record.revision, record);
  }
  return [...records.values()].sort((left, right) => left.revision - right.revision);
}

/** Actual column lists per table, from the schema — content reads never guess a column set. */
async function readContentColumns(session: SqlSession): Promise<Record<string, string[]>> {
  const tables = [...CONTENT_TABLES, PLATFORM_AUDIT_TABLE, ACL_TABLE];
  const rows = await session.query<{ table_name: string; column_name: string }>(
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)
     ORDER BY TABLE_NAME, ORDINAL_POSITION`, [tables]);
  const columns: Record<string, string[]> = {};
  for (const row of rows) {
    (columns[row.table_name] ??= []).push(row.column_name);
  }
  for (const table of tables) {
    if (!columns[table] || columns[table].length === 0) refuse('REAL_CONTENT_TABLE_UNKNOWN', { table });
  }
  return columns;
}

interface ContentRead {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  count: number;
  truncated: boolean;
}

/** Bounded full-row read: count is exact, rows are capped, and truncation is explicit. */
async function readContent(session: SqlSession, columns: Record<string, string[]>, table: string, where: string, values: unknown[]): Promise<ContentRead> {
  const list = columns[table];
  if (!list) refuse('REAL_CONTENT_TABLE_UNKNOWN', { table });
  const [countRow] = await session.query<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, values);
  const order = list.map(column => `\`${column}\``).join(', ');
  const rows = await session.query<Record<string, unknown>>(
    `SELECT ${order} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ${MAX_CONTENT_ROWS + 1}`, values);
  const count = Number(countRow?.n ?? 0);
  const truncated = rows.length > MAX_CONTENT_ROWS || count > rows.length;
  return { columns: list, rows: rows.slice(0, MAX_CONTENT_ROWS), count, truncated };
}

/**
 * `digestOf` treats every non-array object by its enumerable keys; a mysql2
 * `Date` therefore hashes as `{}`. Content digests must not lose DATETIME
 * columns (grant_expiry, recorded_at, created_at), so dates and buffers are
 * encoded explicitly before hashing.
 */
const contentValue = (value: unknown): unknown => {
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (Buffer.isBuffer(value)) return `buffer:${value.toString('base64')}`;
  if (Array.isArray(value)) return value.map(contentValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, contentValue(item)]));
  }
  return value;
};

const digestRows = (read: ContentRead): string =>
  digestOf(read.rows.map(row => read.columns.map(column => contentValue(row[column] ?? null))));

async function contentBlock(session: SqlSession, columns: Record<string, string[]>, table: string, where: string, values: unknown[]): Promise<ContentBlock> {
  const read = await readContent(session, columns, table, where, values);
  return { table, count: read.count, digest: digestRows(read), truncated: read.truncated };
}

async function readPreservation(
  session: SqlSession, resource: RealResourceRef, contentColumns: Record<string, string[]>,
): Promise<RealPreservationSnapshot> {
  const id = resource.id;
  const history: ContentBlock[] = [];
  const rollouts = await session.query<{ series_hash: string }>(
    'SELECT series_hash FROM metric_rollout WHERE resource_type = ? AND resource_id = ? ORDER BY series_hash',
    [resource.type, String(id)]);
  const series = rollouts.map(row => row.series_hash);

  if (resource.type === 'instance') history.push(await contentBlock(session, contentColumns, 'metrics_history', 'instance_id = ?', [id]));
  if (resource.type === 'server') history.push(await contentBlock(session, contentColumns, 'server_metrics', 'server_id = ?', [id]));
  if (resource.type === 'network_device') history.push(await contentBlock(session, contentColumns, 'network_device_observations', 'device_id = ?', [id]));
  if (series.length > 0) {
    history.push(await contentBlock(session, contentColumns, 'metric_observations', 'series_hash IN (?)', [series]));
    history.push(await contentBlock(session, contentColumns, 'metric_publications', 'series_hash IN (?)', [series]));
  }

  const credentials: CredentialRef[] = [];
  const credential = (ref: string, present: unknown, digest: unknown): void => {
    credentials.push({ ref, present: Boolean(present), digest: `sha256:${String(digest ?? '')}` });
  };
  if (resource.type === 'instance') {
    const rows = await session.query<{ id: number; present: number | boolean; digest: string }>(
      `SELECT id, (password_encrypted IS NOT NULL AND password_encrypted <> '') AS present,
         SHA2(CAST(COALESCE(password_encrypted, '') AS CHAR), 256) AS digest
       FROM database_instances WHERE id = ?`, [id]);
    for (const row of rows) credential(`credential:instance-${row.id}:password`, row.present, row.digest);
  }
  if (resource.type === 'server') {
    const rows = await session.query<{ id: number; present: number | boolean; digest: string }>(
      `SELECT id, (credential_encrypted IS NOT NULL AND credential_encrypted <> '') AS present,
         SHA2(CAST(COALESCE(credential_encrypted, '') AS CHAR), 256) AS digest
       FROM servers WHERE id = ?`, [id]);
    for (const row of rows) credential(`credential:server-${row.id}:primary`, row.present, row.digest);
  }
  if (resource.type === 'network_device') {
    const rows = await session.query<{
      id: number; protocol: string; present: number | boolean;
      community: string; credential: string; auth_secret: string; privacy_secret: string;
    }>(
      `SELECT id, protocol,
         (COALESCE(community_encrypted, credential_encrypted, auth_secret_encrypted) IS NOT NULL) AS present,
         SHA2(CAST(COALESCE(community_encrypted, '') AS CHAR), 256) AS community,
         SHA2(CAST(COALESCE(credential_encrypted, '') AS CHAR), 256) AS credential,
         SHA2(CAST(COALESCE(auth_secret_encrypted, '') AS CHAR), 256) AS auth_secret,
         SHA2(CAST(COALESCE(privacy_secret_encrypted, '') AS CHAR), 256) AS privacy_secret
       FROM network_device_credentials WHERE device_id = ? ORDER BY id`, [id]);
    for (const row of rows) {
      credential(`credential:device-${id}-${row.id}:${row.protocol}`, row.present,
        digestOf({ community: row.community, credential: row.credential, auth: row.auth_secret, privacy: row.privacy_secret }));
    }
  }
  for (const ref of credentials) if (!CREDENTIAL_REF.test(ref.ref)) refuse('REAL_CREDENTIAL_REF_INVALID');

  let acl: RealPreservationSnapshot['acl'];
  if (resource.type === 'instance') {
    const read = await readContent(session, contentColumns, ACL_TABLE, 'instance_id = ?', [id]);
    acl = {
      supported: true,
      count: read.count,
      digest: digestRows(read),
      truncated: read.truncated,
      rows: read.rows.map(row => `acl:instance-${id}:user-${String(row.user_id)}`),
    };
  } else {
    acl = { supported: false, count: 0, digest: digestOf([]), truncated: false, rows: [],
      reason: `the real schema has no per-resource ACL table for ${resource.type}` };
  }

  const scheduleRows = await session.query<Record<string, unknown>>(
    'SELECT * FROM metric_schedule WHERE resource_key = ? ORDER BY job_id', [realResourceKey(resource)]);
  const schedules = {
    count: scheduleRows.length,
    rows: scheduleRows.map(row => ({ job_id: typeof row.job_id === 'string' ? row.job_id : null, digest: digestOf(contentValue(row)) })),
    truncated: scheduleRows.length > MAX_CONTENT_ROWS,
  };

  const events = resource.type === 'instance'
    ? await contentBlock(session, contentColumns, 'alerts', 'instance_id = ?', [id])
    : undefined;

  const auditRows = await session.query<Record<string, unknown>>(
    'SELECT * FROM metric_policy_audit WHERE target = ? ORDER BY id LIMIT ?', [realResourceKey(resource), MAX_CONTENT_ROWS + 1]);
  const auditTruncated = auditRows.length > MAX_CONTENT_ROWS;
  const policyAudit = auditRows.slice(0, MAX_CONTENT_ROWS).map(row => ({
    id: Number(row.id),
    request_id: String(parseJson<Record<string, unknown>>(row.payload)?.request_id ?? ''),
    digest: digestOf(contentValue(row)),
  }));
  const platformRows = await session.query<Record<string, unknown>>(
    `SELECT * FROM audit_log_entries WHERE resource_type = ? AND resource_id = ? ORDER BY id LIMIT ?`,
    [resource.type, String(id), MAX_CONTENT_ROWS + 1]);
  const platformTruncated = platformRows.length > MAX_CONTENT_ROWS;

  return {
    history,
    credentials,
    acl,
    schedules,
    events: events === undefined
      ? { supported: false, count: 0, digest: digestOf([]), truncated: false, reason: `alerts has no ${resource.type} resource linkage` }
      : { supported: true, count: events.count, digest: events.digest, truncated: events.truncated },
    policy_audit: { count: auditRows.length, entries: policyAudit, truncated: auditTruncated },
    platform_audit: { count: platformRows.length, entries: platformRows.slice(0, MAX_CONTENT_ROWS).map(row => digestOf(contentValue(row))), truncated: platformTruncated },
  };
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

export interface RealPlanRequest {
  resource: RealResourceRef;
  identities: IdentityInput[];
  template_pins: unknown;
  object_blockers?: string[];
}

/** The exact invocation content a plan was computed from — replayed inside the write lock. */
export interface RealPlanInvocation {
  identities: IdentityInput[];
  template_pins: TemplatePin[];
  object_blockers: string[];
}

/** The complete binding baseline a plan is bound to. */
export interface RealBindingBaseline {
  revision: number;
  package: RealPackagePin | null;
  template_pins: TemplatePin[];
  group_id: string | null;
  overrides: Record<string, unknown>;
  resolved: unknown;
  application: RealApplicationState;
  payload_digest: string;
}

export interface RealMigrationPlan {
  plan_version: number;
  executor_version: string;
  code_fingerprint: string;
  schema_fingerprint: string;
  resource_key: string;
  resource_type: RealResourceType;
  engine: string | null;
  base_revision: number;
  baseline: RealBindingBaseline | null;
  invocation: RealPlanInvocation;
  rows: PlanRow[];
  pins: TemplatePin[];
  blockers: string[];
  cutover_allowed: boolean;
  /** The accepted reference plan's digest for the same rows/pins/blockers (informational). */
  reference_digest: string;
  digest: string;
}

export const bindingBaseline = (snapshot: RealSnapshot): RealBindingBaseline | null => {
  const binding = snapshot.binding;
  if (!binding || snapshot.binding_payload_digest === null) return null;
  return {
    revision: binding.revision,
    package: binding.package,
    template_pins: binding.template_pins,
    group_id: binding.group_id,
    overrides: binding.overrides,
    resolved: binding.resolved,
    application: binding.application,
    payload_digest: snapshot.binding_payload_digest,
  };
};

export const realPlanDigest = (plan: Omit<RealMigrationPlan, 'digest' | 'reference_digest'>): string => digestOf({
  plan_version: plan.plan_version,
  executor_version: plan.executor_version,
  code_fingerprint: plan.code_fingerprint,
  schema_fingerprint: plan.schema_fingerprint,
  resource_key: plan.resource_key,
  resource_type: plan.resource_type,
  engine: plan.engine,
  base_revision: plan.base_revision,
  baseline: plan.baseline,
  invocation: plan.invocation,
  rows: plan.rows,
  pins: plan.pins,
  blockers: plan.blockers,
  cutover_allowed: plan.cutover_allowed,
});

/** A real catalog row decides the target's unit; the manifest can only claim a mapping. */
function applyCatalog(identity: IdentityInput, snapshot: RealSnapshot): IdentityInput {
  if (identity.target_metric_id === null) return identity;
  const targetType = catalogTargetType[snapshot.resource_type];
  if (targetType === null) return { ...identity, target_missing: true, target_unit: null };
  const entry = snapshot.catalog[`${targetType}:${identity.target_metric_id}`];
  if (!entry) return { ...identity, target_missing: true, target_unit: null };
  return { ...identity, target_missing: false, target_unit: entry.unit };
}

/**
 * Reuses the accepted `dispose` rules and adds exactly one real-catalog rule:
 * a canonical target the platform does not collect keeps the legacy path. The
 * input's `target_unit` is never trusted — the catalog's unit is.
 */
export function disposeReal(identity: IdentityInput, snapshot: RealSnapshot): PlanRow {
  const withCatalog = applyCatalog(identity, snapshot);
  const row = dispose(withCatalog);
  const targetType = catalogTargetType[snapshot.resource_type];
  const entry = withCatalog.target_metric_id !== null && targetType !== null
    ? snapshot.catalog[`${targetType}:${withCatalog.target_metric_id}`] : undefined;
  if (row.disposition === 'mapped' && entry && !entry.is_collected) {
    return {
      ...row, disposition: 'keep-legacy',
      reason: 'CANONICAL_NOT_COLLECTED: the canonical target exists but the platform does not collect it',
      actions: ['keep the legacy path read-only', 'enable or replace the canonical metric before planning this identity'],
    };
  }
  return row;
}

/** Same engine scope rule as the accepted reference model. */
const engineInScope = (identity: IdentityInput, snapshot: RealSnapshot): boolean =>
  snapshot.resource_type === 'instance' ? identity.engine === snapshot.engine : identity.engine === null;

/**
 * Plan against the real snapshot. Read-only; nothing here writes.
 *
 * Blockers: a missing resource row or binding row, a pin whose template/version
 * is absent, retired, not `published`, missing required content, or whose hash
 * differs from the immutable published version, an un-present template catalog
 * (the candidate 140 tables), and any identity `dispose` marks `blocked`.
 */
export function planRealMigration(snapshot: RealSnapshot, request: RealPlanRequest): RealMigrationPlan {
  if (EXECUTOR_CODE_FINGERPRINT.length === 0) refuse('REAL_CODE_FINGERPRINT_UNAVAILABLE');
  if (request.resource.type !== snapshot.resource.type || request.resource.id !== snapshot.resource.id) {
    refuse('REAL_PLAN_RESOURCE_MISMATCH', { expected: snapshot.resource_key, received: realResourceKey(request.resource) });
  }
  // An existing compiled plan cannot be reproduced by this executor; fail closed
  // instead of writing a binding an old single-package consumer would ignore.
  if (snapshot.binding !== null && snapshot.binding.resolved !== null && snapshot.binding.resolved !== undefined) {
    refuse('REAL_RESOLVED_PLAN_UNSUPPORTED');
  }
  const pins = parsePins(request.template_pins);
  const invocation: RealPlanInvocation = {
    identities: request.identities, template_pins: pins, object_blockers: [...(request.object_blockers ?? [])],
  };
  const objectBlockers = [...invocation.object_blockers];
  if (!snapshot.resource_exists) objectBlockers.push(`RESOURCE_MISSING:${snapshot.resource_key}`);
  if (!snapshot.binding) objectBlockers.push(`RESOURCE_BINDING_MISSING:${snapshot.resource_key}`);
  if (pins.length > 0 && !snapshot.template_catalog_supported) objectBlockers.push('TEMPLATE_CATALOG_MISSING');
  for (const pin of pins) {
    const template = snapshot.templates[pin.template_id];
    if (!template) { objectBlockers.push(`TEMPLATE_PIN_MISSING:${pin.template_id}`); continue; }
    if (template.status !== 'active' && template.status !== 'draft') objectBlockers.push(`TEMPLATE_PIN_DISABLED:${pin.template_id}`);
    const version = template.versions[pin.version];
    if (!version) { objectBlockers.push(`TEMPLATE_VERSION_MISSING:${pin.template_id}@${pin.version}`); continue; }
    if (version.content_hash !== pin.content_hash) objectBlockers.push(`TEMPLATE_VERSION_HASH_MISMATCH:${pin.template_id}@${pin.version}`);
    // A retired/non-published version is history, never a new application target.
    if (version.status !== 'published') objectBlockers.push(`TEMPLATE_VERSION_NOT_PUBLISHED:${pin.template_id}@${pin.version}:${version.status}`);
    if (!version.aggregate_ok || !version.items_ok) objectBlockers.push(`TEMPLATE_VERSION_CONTENT_INVALID:${pin.template_id}@${pin.version}`);
  }

  const scoped = request.identities.filter(identity => identity.resource_type === snapshot.resource_type && engineInScope(identity, snapshot));
  const rows = scoped.map(identity => disposeReal(identity, snapshot))
    .sort((left, right) => (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0));
  const blockedRows = rows.filter(row => row.in_scope && row.disposition === 'blocked');
  const mapped = rows.filter(row => row.in_scope && row.disposition === 'mapped');
  const blockers = [...new Set([...objectBlockers, ...blockedRows.map(row => row.identity)])].sort();
  const planPins = mapped.length > 0 ? pins : [];
  const cutover_allowed = blockers.length === 0 && planPins.length > 0;
  const body = {
    plan_version: PLAN_VERSION,
    executor_version: EXECUTOR_VERSION,
    code_fingerprint: EXECUTOR_CODE_FINGERPRINT,
    schema_fingerprint: snapshot.schema_fingerprint,
    resource_key: snapshot.resource_key,
    resource_type: snapshot.resource_type,
    engine: snapshot.engine,
    base_revision: snapshot.binding?.revision ?? 0,
    baseline: bindingBaseline(snapshot),
    invocation,
    rows,
    pins: planPins,
    blockers,
    cutover_allowed,
  };
  // The accepted reference digest covers exactly these fields, so evidence can
  // compare the real plan with the reference model without a second encoder.
  const reference_digest = planDigest({ ...body, rows, pins: planPins });
  return { ...body, reference_digest, digest: realPlanDigest(body) };
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

export interface RealApplyOptions {
  actor_id: number;
  at: string;
  fail_at?: 'before-write' | 'after-binding' | 'before-audit';
}

export interface RealApplyResult {
  outcome: 'applied' | 'noop';
  revision: number;
  written: number;
  request_id: string | null;
  plan_digest: string;
  preservation: RealPreservationReport;
}

export type PreservationStatus = 'pass' | 'fail' | 'unsupported';
export interface PreservationCheck { name: string; status: PreservationStatus; ok: boolean; detail: string }
export interface RealPreservationReport {
  /** No check failed. Unknown/unsupported scopes are reported but are not full proof. */
  ok: boolean;
  /** Every check passed; false when a scope is unknown/unsupported or truncated. */
  complete: boolean;
  checks: PreservationCheck[];
}

const same = (left: unknown, right: unknown): boolean => digestOf(left) === digestOf(right);

const pinsEqual = (left: TemplatePin[], right: TemplatePin[]): boolean => same(
  [...left].sort((a, b) => (a.template_id < b.template_id ? -1 : 1)),
  [...right].sort((a, b) => (a.template_id < b.template_id ? -1 : 1)),
);

/** The complete state an apply must produce for an exact replay to be a no-op. */
export interface ExpectedBindingState {
  revision: number;
  package: RealPackagePin | null;
  template_pins: TemplatePin[];
  group_id: string | null;
  overrides: Record<string, unknown>;
  resolved: unknown;
  application: RealApplicationState;
}

const expectedApplication = (): RealApplicationState =>
  ({ applied_revision: null, reported_at: null, status: 'pending', error_code: null });

export const expectedApplyState = (plan: RealMigrationPlan): ExpectedBindingState => ({
  revision: plan.base_revision + 1,
  package: null,
  template_pins: plan.pins,
  group_id: plan.baseline?.group_id ?? null,
  overrides: plan.baseline?.overrides ?? {},
  resolved: null,
  application: expectedApplication(),
});

export const expectedRollbackState = (plan: RealRollbackPlan): ExpectedBindingState => ({
  revision: plan.next_revision,
  package: plan.package,
  template_pins: plan.pins,
  group_id: plan.group_id,
  overrides: plan.overrides,
  resolved: null,
  application: expectedApplication(),
});

/** Exact structural equality — revision, package, pins, group, overrides, resolved AND application. */
export const bindingMatches = (binding: RealBinding | null, expected: ExpectedBindingState): boolean =>
  binding !== null
  && binding.revision === expected.revision
  && same(binding.package, expected.package)
  && pinsEqual(binding.template_pins, expected.template_pins)
  && same(binding.group_id, expected.group_id)
  && same(binding.overrides, expected.overrides)
  && same(binding.resolved, expected.resolved)
  && same(binding.application, expected.application);

/** Preservation compares CONTENT, never only counts; truncated/unknown never pass. */
export function verifyPreservation(before: RealSnapshot, after: RealSnapshot): RealPreservationReport {
  const checks: PreservationCheck[] = [];
  const push = (name: string, status: PreservationStatus, detail: string) =>
    checks.push({ name, status, ok: status === 'pass', detail });

  const truncated = [
    ...before.preservation.history.filter(block => block.truncated).map(block => `${block.table}:before`),
    ...after.preservation.history.filter(block => block.truncated).map(block => `${block.table}:after`),
    ...(before.preservation.events.truncated ? ['events:before'] : []),
    ...(after.preservation.events.truncated ? ['events:after'] : []),
    ...(before.preservation.policy_audit.truncated ? ['policy_audit:before'] : []),
    ...(after.preservation.policy_audit.truncated ? ['policy_audit:after'] : []),
    ...(before.preservation.platform_audit.truncated ? ['platform_audit:before'] : []),
    ...(after.preservation.platform_audit.truncated ? ['platform_audit:after'] : []),
    ...(before.preservation.acl.truncated ? ['acl:before'] : []),
    ...(after.preservation.acl.truncated ? ['acl:after'] : []),
  ];
  push('history-content',
    truncated.some(item => item.startsWith('metrics_history') || item.startsWith('server_metrics')
      || item.startsWith('network_device_observations') || item.startsWith('metric_observations')
      || item.startsWith('metric_publications')) || !same(before.preservation.history, after.preservation.history)
      ? 'fail' : 'pass',
    before.preservation.history.map(block => `${block.table}:${block.count}`).join(',') || 'none');
  push('credentials', same(before.preservation.credentials, after.preservation.credentials) ? 'pass' : 'fail',
    `${after.preservation.credentials.length} reference(s)`);
  if (!before.preservation.acl.supported) {
    push('acl', 'unsupported', `unsupported: ${before.preservation.acl.reason}`);
  } else {
    // A truncated ACL read cannot prove equality, even when the truncated slices
    // compare equal to themselves.
    const aclTruncated = before.preservation.acl.truncated || after.preservation.acl.truncated;
    push('acl', aclTruncated ? 'fail' : same(before.preservation.acl, after.preservation.acl) ? 'pass' : 'fail',
      `${after.preservation.acl.count} grant(s)${aclTruncated ? ' (truncated)' : ''}`);
  }
  const auditPrefix = (beforeEntries: Array<{ digest: string }>, afterEntries: Array<{ digest: string }>): boolean =>
    beforeEntries.length <= afterEntries.length && beforeEntries.every((entry, index) => entry.digest === afterEntries[index]?.digest);
  const auditTruncated = before.preservation.policy_audit.truncated || after.preservation.policy_audit.truncated
    || before.preservation.platform_audit.truncated || after.preservation.platform_audit.truncated;
  push('audit-append-only',
    auditTruncated ? 'fail' : auditPrefix(before.preservation.policy_audit.entries, after.preservation.policy_audit.entries)
      && auditPrefix(before.preservation.platform_audit.entries.map(digest => ({ digest })),
        after.preservation.platform_audit.entries.map(digest => ({ digest })))
      ? 'pass' : 'fail',
    `${before.preservation.policy_audit.count} -> ${after.preservation.policy_audit.count} policy, platform ${before.preservation.platform_audit.count} -> ${after.preservation.platform_audit.count}`);
  const beforeRevision = before.binding?.revision ?? -1;
  push('revisions-retained',
    same(before.revisions, after.revisions.filter(record => record.revision <= beforeRevision))
      && (after.binding?.revision ?? -1) >= beforeRevision ? 'pass' : 'fail',
    `${before.binding?.revision ?? 'none'} -> ${after.binding?.revision ?? 'none'}`);
  // A truncated schedule read cannot prove the single-executor property.
  const schedulesTruncated = before.preservation.schedules.truncated || after.preservation.schedules.truncated;
  push('single-executor',
    schedulesTruncated ? 'fail' : same(before.preservation.schedules, after.preservation.schedules) ? 'pass' : 'fail',
    (after.preservation.schedules.rows.map(row => row.job_id ?? 'none').join(',') || 'none')
      + (schedulesTruncated ? ' (truncated)' : ''));
  if (!before.preservation.events.supported) {
    push('events-unchanged', 'unsupported', `unsupported: ${before.preservation.events.reason}`);
  } else {
    // Same rule as ACL/history: truncation blocks a complete event proof.
    const eventsTruncated = before.preservation.events.truncated || after.preservation.events.truncated;
    push('events-unchanged', eventsTruncated ? 'fail' : same(before.preservation.events, after.preservation.events) ? 'pass' : 'fail',
      `${after.preservation.events.count} event(s)${eventsTruncated ? ' (truncated)' : ''}`);
  }
  const noFailures = checks.every(check => check.status !== 'fail');
  return { ok: noFailures, complete: noFailures && checks.every(check => check.status === 'pass'), checks };
}

const assertCode = (planCode: string): void => {
  if (EXECUTOR_CODE_FINGERPRINT.length === 0) refuse('REAL_CODE_FINGERPRINT_UNAVAILABLE');
  if (planCode !== EXECUTOR_CODE_FINGERPRINT) refuse('REAL_CODE_FINGERPRINT_MISMATCH');
};

const assertPlanShape = (plan: RealMigrationPlan, snapshot: RealSnapshot): void => {
  if (plan.plan_version !== PLAN_VERSION) refuse('REAL_PLAN_VERSION_MISMATCH', { plan: plan.plan_version });
  if (plan.executor_version !== EXECUTOR_VERSION) refuse('REAL_EXECUTOR_VERSION_MISMATCH', { plan: plan.executor_version });
  assertCode(plan.code_fingerprint);
  if (realPlanDigest(plan) !== plan.digest) refuse('REAL_PLAN_DIGEST_MISMATCH');
  if (plan.schema_fingerprint !== snapshot.schema_fingerprint) refuse('REAL_SCHEMA_FINGERPRINT_MISMATCH');
  if (plan.resource_key !== snapshot.resource_key || plan.resource_type !== snapshot.resource_type || plan.engine !== snapshot.engine) {
    refuse('REAL_PLAN_RESOURCE_MISMATCH');
  }
  if (!plan.cutover_allowed) refuse('REAL_CUTOVER_BLOCKED', { blockers: plan.blockers });
  if (plan.pins.length === 0) refuse('REAL_CUTOVER_BLOCKED', { blockers: ['NO_PINS'] });
  if (plan.invocation.template_pins.length !== plan.pins.length) refuse('REAL_PLAN_DIGEST_MISMATCH', { field: 'pins' });
};

const resourceOf = (resource_key: string): RealResourceRef => {
  const match = /^(instance|server|network_device):([1-9][0-9]*)$/.exec(resource_key);
  if (!match) refuse('REAL_RESOURCE_INVALID');
  return { type: match![1] as RealResourceType, id: Number(match![2]) };
};

const invocationOf = (plan: RealMigrationPlan): RealPlanRequest => ({
  resource: resourceOf(plan.resource_key),
  identities: plan.invocation.identities,
  template_pins: plan.invocation.template_pins,
  object_blockers: plan.invocation.object_blockers,
});

/**
 * A saved plan may only be re-submitted for the CURRENT invocation. The plan
 * digest covers its own invocation, so replaying it under a different manifest
 * (new identities, pins or blockers) would silently ignore the new input; this
 * compares the current resource/identities/pins/object_blockers semantically and
 * refuses on any difference, before the write lock.
 */
export function assertPlanInvocation(plan: RealMigrationPlan, request: RealPlanRequest): void {
  if (realResourceKey(request.resource) !== plan.resource_key) {
    refuse('REAL_PLAN_INVOCATION_MISMATCH', { field: 'resource', plan: plan.resource_key, manifest: realResourceKey(request.resource) });
  }
  const blockers = (values: string[] | undefined): string[] => [...new Set(values ?? [])].sort();
  const manifestPins = parsePins(request.template_pins);
  if (!same(request.identities, plan.invocation.identities)) refuse('REAL_PLAN_INVOCATION_MISMATCH', { field: 'identities' });
  if (!pinsEqual(manifestPins, plan.invocation.template_pins)) refuse('REAL_PLAN_INVOCATION_MISMATCH', { field: 'pins' });
  if (!same(blockers(request.object_blockers), blockers(plan.invocation.object_blockers))) {
    refuse('REAL_PLAN_INVOCATION_MISMATCH', {
      field: 'object_blockers', plan: blockers(plan.invocation.object_blockers), manifest: blockers(request.object_blockers),
    });
  }
}

const auditRecorded = (snapshot: RealSnapshot, revision: number, requestId: string): boolean =>
  snapshot.revisions.some(record => record.revision === revision && record.request_id === requestId);

/** Recompute the plan inside the write lock: baseline, schema, templates, catalog and invocation. */
async function assertPlanStillCurrent(session: SqlSession, plan: RealMigrationPlan): Promise<RealSnapshot> {
  const fresh = await readRealSnapshot(session, resourceOf(plan.resource_key));
  const rebuilt = planRealMigration(fresh, invocationOf(plan));
  if (rebuilt.digest !== plan.digest) refuse('REAL_BASELINE_DRIFT', { recomputed: rebuilt.digest });
  return fresh;
}

async function assertBaselineInLock(session: SqlSession, plan: RealMigrationPlan): Promise<RealSnapshot> {
  const [lock] = await session.query<{ id: number }>('SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE');
  if (!lock) refuse('REAL_POLICY_LOCK_MISSING');
  const row = (await session.query<{ group_id: string | null; payload: unknown }>(
    'SELECT group_id, payload FROM metric_policy_bindings WHERE resource_key = ? FOR UPDATE', [plan.resource_key]))[0];
  if (!row) refuse('REAL_RESOURCE_BINDING_MISSING');
  const live = parseRealBinding(row.payload);
  if (live.revision !== plan.base_revision) refuse('REAL_REPLAY_CONFLICT', { base: plan.base_revision, current: live.revision });
  if (live.resolved !== null && live.resolved !== undefined) refuse('REAL_RESOLVED_PLAN_UNSUPPORTED');
  if ((row.group_id ?? null) !== live.group_id) refuse('REAL_BINDING_GROUP_INCONSISTENT');
  if (plan.baseline === null || digestOf(parseJson(row.payload)) !== plan.baseline.payload_digest) {
    refuse('REAL_BASELINE_DRIFT', { field: 'payload' });
  }
  return assertPlanStillCurrent(session, plan);
}

/**
 * Apply one plan as one new revision. The plan's digest, executor code, schema
 * fingerprint, resource identity, complete baseline and replay state are all
 * checked before a single write. Writes happen on ONE explicit connection under
 * `metric_policy_lock FOR UPDATE`; the baseline is re-read and the plan is
 * recomputed inside the lock, and every preservation/result check runs BEFORE
 * COMMIT. Any failure rolls the whole transaction back.
 *
 * An exact replay — the complete expected binding (revision, pins, package,
 * group, overrides, resolved, application) plus this plan's own audit request —
 * is a no-op; any drift refuses.
 */
export async function applyRealMigration(
  session: SqlSession, plan: RealMigrationPlan, snapshot: RealSnapshot, options: RealApplyOptions,
): Promise<RealApplyResult> {
  assertPlanShape(plan, snapshot);
  const current = snapshot.binding;
  if (!current) refuse('REAL_RESOURCE_BINDING_MISSING');

  const requestId = `${MIGRATE_REQUEST_PREFIX}${plan.digest}`;
  if (current.revision === plan.base_revision + 1) {
    const exact = bindingMatches(current, expectedApplyState(plan)) && auditRecorded(snapshot, current.revision, requestId);
    if (exact) {
      // No write happens, so the caller's fresh snapshot is the state being proven.
      return {
        outcome: 'noop', revision: current.revision, written: 0,
        request_id: requestId, plan_digest: plan.digest, preservation: verifyPreservation(snapshot, snapshot),
      };
    }
    refuse('REAL_REPLAY_CONFLICT', { base: plan.base_revision, current: current.revision });
  }
  if (current.revision !== plan.base_revision) refuse('REAL_PLAN_STALE', { base: plan.base_revision, current: current.revision });
  if (options.fail_at === 'before-write') refuse('REAL_INJECTED_FAILURE:before-write');

  let preserved: RealPreservationReport;
  await session.begin();
  try {
    const preWrite = await assertBaselineInLock(session, plan);
    const [row] = await session.query<{ group_id: string | null; payload: unknown }>(
      'SELECT group_id, payload FROM metric_policy_bindings WHERE resource_key = ? FOR UPDATE', [plan.resource_key]);
    if (!row) refuse('REAL_RESOURCE_BINDING_MISSING');
    const payload = parseJson<Record<string, unknown>>(row.payload);
    const nextRevision = plan.base_revision + 1;
    const target = expectedApplyState(plan);
    const nextPayload = {
      ...payload,
      binding: {
        ...(payload.binding as Record<string, unknown>),
        revision: nextRevision, package: null, template_pins: plan.pins,
        group_id: target.group_id, overrides: target.overrides,
      },
      published_at: options.at,
      resolved: null,
      application: target.application,
    };
    await session.query('UPDATE metric_policy_bindings SET payload = ?, group_id = ? WHERE resource_key = ?',
      [JSON.stringify(nextPayload), target.group_id, plan.resource_key]);
    if (options.fail_at === 'after-binding' || options.fail_at === 'before-audit') refuse('REAL_INJECTED_FAILURE:after-binding');
    await session.query('INSERT INTO metric_policy_audit (target, payload) VALUES (?, ?)', [plan.resource_key, JSON.stringify({
      actor_id: options.actor_id,
      request_id: requestId,
      action: 'binding.publish',
      target: plan.resource_key,
      revision: nextRevision,
      at: options.at,
      configuration: { package: null, group_id: target.group_id, overrides: target.overrides, template_pins: plan.pins },
    })]);

    // All post-write checks are INSIDE the transaction: a violation must abort
    // the write, never report failure after a durable commit.
    const after = await readRealSnapshot(session, resourceOf(plan.resource_key));
    preserved = verifyPreservation(preWrite, after);
    if (!preserved.ok) refuse('REAL_PRESERVATION_VIOLATION', { checks: preserved.checks.filter(check => check.status === 'fail') });
    if (!bindingMatches(after.binding, target)) refuse('REAL_RESULT_MISMATCH');
    if (!auditRecorded(after, nextRevision, requestId)) refuse('REAL_AUDIT_MISMATCH');
    await session.commit();
  } catch (error) {
    await session.rollback().catch(() => undefined);
    throw error;
  }

  return {
    outcome: 'applied', revision: plan.base_revision + 1, written: 1,
    request_id: requestId, plan_digest: plan.digest, preservation: preserved,
  };
}

/* ------------------------------------------------------------------ */
/* Rollback                                                            */
/* ------------------------------------------------------------------ */

export interface RealRollbackPlan {
  plan_version: number;
  executor_version: string;
  code_fingerprint: string;
  schema_fingerprint: string;
  resource_key: string;
  from_revision: number;
  target_revision: number;
  next_revision: number;
  pins: TemplatePin[];
  package: RealPackagePin | null;
  group_id: string | null;
  overrides: Record<string, unknown>;
  /**
   * The COMPLETE live baseline the rollback was planned from (payload digest
   * included). An apply refuses if the live state drifted from it; a legal
   * replay reconstructs the same baseline from the rollback's own audit row.
   */
  baseline: RealBindingBaseline;
  digest: string;
}

export interface RealRollbackOptions {
  target_revision: number;
  expected_current_revision: number;
  actor_id: number;
  at: string;
  fail_at?: 'before-write' | 'after-binding' | 'before-audit';
}

export const realRollbackDigest = (plan: Omit<RealRollbackPlan, 'digest'>): string => digestOf({
  plan_version: plan.plan_version,
  executor_version: plan.executor_version,
  code_fingerprint: plan.code_fingerprint,
  schema_fingerprint: plan.schema_fingerprint,
  resource_key: plan.resource_key,
  from_revision: plan.from_revision,
  target_revision: plan.target_revision,
  next_revision: plan.next_revision,
  pins: plan.pins,
  package: plan.package,
  group_id: plan.group_id,
  overrides: plan.overrides,
  baseline: plan.baseline,
});

const targetConfigMatches = (binding: RealBinding | null, plan: Pick<RealRollbackPlan, 'pins' | 'package' | 'group_id' | 'overrides'>): boolean =>
  binding !== null
  && pinsEqual(binding.template_pins, plan.pins)
  && same(binding.package, plan.package)
  && same(binding.group_id, plan.group_id)
  && same(binding.overrides, plan.overrides);

/**
 * Rollback appends a revision that reproduces the target revision's COMPLETE
 * configuration (pins, package, group and overrides). It never deletes history
 * and never flattens a multi-template target into a single package.
 *
 * The plan binds the COMPLETE live baseline (including the exact payload
 * digest), so a same-revision configuration change refuses at apply time with
 * zero writes. When the caller already applied exactly this rollback, the same
 * deterministic plan is reconstructed from the rollback's own audit row — which
 * records the baseline it bound — so a re-run keeps the SAME digest and
 * `applyRealRollback` recognises the exact replay as a no-op.
 */
export function planRealRollback(snapshot: RealSnapshot, options: {
  target_revision: number; expected_current_revision: number;
}): RealRollbackPlan {
  if (EXECUTOR_CODE_FINGERPRINT.length === 0) refuse('REAL_CODE_FINGERPRINT_UNAVAILABLE');
  const current = snapshot.binding;
  if (!current) refuse('REAL_RESOURCE_BINDING_MISSING');
  if (current.resolved !== null && current.resolved !== undefined) refuse('REAL_RESOLVED_PLAN_UNSUPPORTED');
  const target = snapshot.revisions.find(record => record.revision === options.target_revision);
  if (!target) refuse('REAL_ROLLBACK_TARGET_MISSING', { target: options.target_revision });
  const body = {
    plan_version: PLAN_VERSION,
    executor_version: EXECUTOR_VERSION,
    code_fingerprint: EXECUTOR_CODE_FINGERPRINT,
    schema_fingerprint: snapshot.schema_fingerprint,
    resource_key: snapshot.resource_key,
    from_revision: options.expected_current_revision,
    target_revision: target.revision,
    next_revision: options.expected_current_revision + 1,
    pins: target.template_pins,
    package: target.package,
    group_id: target.group_id,
    overrides: target.overrides,
  };
  if (current.revision === body.next_revision && options.target_revision < options.expected_current_revision) {
    // A legal exact replay of this rollback: everything but the revision/application
    // must already equal the target; otherwise the recorded operation drifted.
    if (!targetConfigMatches(current, body) || current.application.status !== 'pending') {
      refuse('REAL_ROLLBACK_CONFLICT', { expected: options.expected_current_revision, current: current.revision });
    }
    // Rebind the baseline the ORIGINAL rollback planned from, never the state
    // this rollback itself produced. Its own audit row carries that baseline.
    const recorded = snapshot.revisions.find(record => record.revision === body.next_revision
      && record.request_id.startsWith(ROLLBACK_REQUEST_PREFIX));
    if (!recorded?.baseline) refuse('REAL_ROLLBACK_BASELINE_MISSING', { revision: body.next_revision });
    const replay = { ...body, baseline: recorded.baseline };
    return { ...replay, digest: realRollbackDigest(replay) };
  }
  if (current.revision !== options.expected_current_revision) {
    refuse('REAL_ROLLBACK_CONFLICT', { expected: options.expected_current_revision, current: current.revision });
  }
  if (options.target_revision >= options.expected_current_revision) {
    refuse('REAL_ROLLBACK_TARGET_NOT_HISTORICAL', { target: options.target_revision });
  }
  const baseline = bindingBaseline(snapshot);
  if (!baseline) refuse('REAL_ROLLBACK_BASELINE_MISSING', { revision: current.revision });
  const plan = { ...body, baseline };
  return { ...plan, digest: realRollbackDigest(plan) };
}

const assertRollbackShape = (plan: RealRollbackPlan, snapshot: RealSnapshot): void => {
  if (plan.plan_version !== PLAN_VERSION) refuse('REAL_PLAN_VERSION_MISMATCH', { plan: plan.plan_version });
  if (plan.executor_version !== EXECUTOR_VERSION) refuse('REAL_EXECUTOR_VERSION_MISMATCH');
  assertCode(plan.code_fingerprint);
  if (realRollbackDigest(plan) !== plan.digest) refuse('REAL_PLAN_DIGEST_MISMATCH');
  if (plan.schema_fingerprint !== snapshot.schema_fingerprint) refuse('REAL_SCHEMA_FINGERPRINT_MISMATCH');
  if (plan.resource_key !== snapshot.resource_key) refuse('REAL_PLAN_RESOURCE_MISMATCH');
  if (!plan.baseline || plan.baseline.revision !== plan.from_revision) refuse('REAL_ROLLBACK_BASELINE_MISSING', { field: 'baseline' });
};

export async function applyRealRollback(
  session: SqlSession, plan: RealRollbackPlan, snapshot: RealSnapshot, options: RealRollbackOptions,
): Promise<RealApplyResult> {
  assertRollbackShape(plan, snapshot);
  if (options.target_revision !== plan.target_revision) refuse('REAL_ROLLBACK_TARGET_MISMATCH');
  if (options.expected_current_revision !== plan.from_revision) refuse('REAL_ROLLBACK_CONFLICT');
  const current = snapshot.binding;
  if (!current) refuse('REAL_RESOURCE_BINDING_MISSING');
  const requestId = `${ROLLBACK_REQUEST_PREFIX}${plan.digest}`;
  const expected = expectedRollbackState(plan);
  if (current.revision === plan.next_revision) {
    const exact = bindingMatches(current, expected) && auditRecorded(snapshot, current.revision, requestId);
    if (exact) {
      return {
        outcome: 'noop', revision: current.revision, written: 0,
        request_id: requestId, plan_digest: plan.digest, preservation: verifyPreservation(snapshot, snapshot),
      };
    }
    refuse('REAL_REPLAY_CONFLICT', { expected: plan.from_revision, current: current.revision });
  }
  if (current.revision !== plan.from_revision) refuse('REAL_ROLLBACK_CONFLICT', { expected: plan.from_revision, current: current.revision });
  // The submitted plan is bound to one complete baseline; a state that already
  // differs from it (e.g. a same-revision overrides edit) is drift, not a retry.
  const baseline = bindingBaseline(snapshot);
  if (!baseline || baseline.payload_digest !== plan.baseline.payload_digest
    || !same(baseline, plan.baseline)) {
    refuse('REAL_ROLLBACK_BASELINE_DRIFT', { field: 'snapshot' });
  }
  if (options.fail_at === 'before-write') refuse('REAL_INJECTED_FAILURE:before-write');

  let preserved: RealPreservationReport;
  await session.begin();
  try {
    const [lock] = await session.query<{ id: number }>('SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE');
    if (!lock) refuse('REAL_POLICY_LOCK_MISSING');
    const [row] = await session.query<{ group_id: string | null; payload: unknown }>(
      'SELECT group_id, payload FROM metric_policy_bindings WHERE resource_key = ? FOR UPDATE', [plan.resource_key]);
    if (!row) refuse('REAL_RESOURCE_BINDING_MISSING');
    const live = parseRealBinding(row.payload);
    if (live.revision !== plan.from_revision) refuse('REAL_ROLLBACK_CONFLICT', { expected: plan.from_revision, current: live.revision });
    if (live.resolved !== null && live.resolved !== undefined) refuse('REAL_RESOLVED_PLAN_UNSUPPORTED');
    if ((row.group_id ?? null) !== live.group_id) refuse('REAL_BINDING_GROUP_INCONSISTENT');
    // Re-read INSIDE the lock: the payload digest must still be the plan's
    // complete baseline, so a same-revision configuration edit can never be
    // silently overwritten by the rollback.
    if (digestOf(parseJson(row.payload)) !== plan.baseline.payload_digest) {
      refuse('REAL_ROLLBACK_BASELINE_DRIFT', { field: 'payload' });
    }
    // The historical target must still be the recorded configuration; a changed
    // audit record or a drifted target refuses before any write.
    const fresh = await readRealSnapshot(session, resourceOf(plan.resource_key));
    const rebuilt = planRealRollback(fresh, {
      target_revision: plan.target_revision, expected_current_revision: plan.from_revision,
    });
    if (rebuilt.digest !== plan.digest) refuse('REAL_ROLLBACK_TARGET_DRIFT', { recomputed: rebuilt.digest });

    const payload = parseJson<Record<string, unknown>>(row.payload);
    const binding: Record<string, unknown> = {
      ...(payload.binding as Record<string, unknown>),
      revision: plan.next_revision,
      package: plan.package,
      group_id: plan.group_id,
      overrides: plan.overrides,
    };
    if (plan.pins.length > 0) binding.template_pins = plan.pins;
    else delete binding.template_pins;
    const nextPayload = {
      ...payload,
      binding,
      published_at: options.at,
      resolved: null,
      application: expected.application,
    };
    await session.query('UPDATE metric_policy_bindings SET payload = ?, group_id = ? WHERE resource_key = ?',
      [JSON.stringify(nextPayload), plan.group_id, plan.resource_key]);
    if (options.fail_at === 'after-binding' || options.fail_at === 'before-audit') refuse('REAL_INJECTED_FAILURE:after-binding');
    await session.query('INSERT INTO metric_policy_audit (target, payload) VALUES (?, ?)', [plan.resource_key, JSON.stringify({
      actor_id: options.actor_id,
      request_id: requestId,
      action: 'binding.publish',
      target: plan.resource_key,
      revision: plan.next_revision,
      at: options.at,
      configuration: {
        package: plan.package, group_id: plan.group_id, overrides: plan.overrides,
        template_pins: plan.pins, rollback_to_revision: plan.target_revision,
        // Recorded so an exact re-run reproduces the SAME plan digest without
        // rebinding the post-rollback state.
        baseline: plan.baseline,
      },
    })]);

    const after = await readRealSnapshot(session, resourceOf(plan.resource_key));
    preserved = verifyPreservation(fresh, after);
    if (!preserved.ok) refuse('REAL_PRESERVATION_VIOLATION', { checks: preserved.checks.filter(check => check.status === 'fail') });
    if (!bindingMatches(after.binding, expected)) refuse('REAL_RESULT_MISMATCH');
    if (!auditRecorded(after, plan.next_revision, requestId)) refuse('REAL_AUDIT_MISMATCH');
    await session.commit();
  } catch (error) {
    await session.rollback().catch(() => undefined);
    throw error;
  }

  return {
    outcome: 'applied', revision: plan.next_revision, written: 1,
    request_id: requestId, plan_digest: plan.digest, preservation: preserved,
  };
}

/* ------------------------------------------------------------------ */
/* Target confirmation                                                 */
/* ------------------------------------------------------------------ */

export interface WritableTargetFacts {
  database: string;
  hostname: string;
  version: string;
  container_id: string;
  container_labels: Record<string, string>;
}

export interface WritableTargetOptions {
  /** The creation record. There is no caller-supplied owner prefix: this is the only owner. */
  handle: OwnedTargetHandle;
  confirm: string;
  resource_key: string;
}

const RESERVED_DATABASES = new Set(['mysql', 'sys', 'information_schema', 'performance_schema', 'slide', 'db_ops_ai']);

/**
 * The live connection must be the recorded container and database. This is the
 * identity gate every mode (read-only plan included) runs right after connect:
 * a different hostname, database, owner/phase label or an old server refuses
 * before any state is read.
 */
export function assertTargetIdentity(facts: WritableTargetFacts, handle: OwnedTargetHandle): void {
  if (!handle || !handle.container_id || !Array.isArray(handle.resources)) {
    refuse('REAL_TARGET_OWNER_REFUSED', { reason: 'creation-record handle required' });
  }
  if (facts.container_id !== handle.container_id) refuse('REAL_TARGET_CONTAINER_ID_MISMATCH');
  if (facts.database !== handle.database) refuse('REAL_TARGET_DATABASE_REFUSED', { database: facts.database });
  if (facts.container_labels['max236.owner'] !== handle.owner) refuse('REAL_TARGET_OWNER_REFUSED', { owner: facts.container_labels['max236.owner'] ?? '' });
  if (facts.container_labels['max236.phase'] !== handle.phase) refuse('REAL_TARGET_PHASE_REFUSED', { phase: facts.container_labels['max236.phase'] ?? '' });
  if (facts.hostname.slice(0, 12) !== handle.container_id.slice(0, 12)) refuse('REAL_TARGET_HOSTNAME_MISMATCH');
  if (!/^(8|9)\./.test(facts.version)) refuse('REAL_TARGET_VERSION_REFUSED', { version: facts.version });
}

/**
 * Only the exact creation-record database/container may receive a write. The
 * confirmation string is `<database>@<container_id12>:<resource_key>` and the
 * resource must already be in the recorded write allow-list. A self-declared
 * owner prefix, a foreign label or a resource outside the record refuses.
 */
export function assertWritableTarget(facts: WritableTargetFacts, options: WritableTargetOptions): void {
  const handle = options.handle;
  assertTargetIdentity(facts, handle);
  if (!OWNED_DATABASE.test(facts.database) || RESERVED_DATABASES.has(facts.database)) {
    refuse('REAL_TARGET_DATABASE_REFUSED', { database: facts.database });
  }
  if (!handle.resources.includes(options.resource_key)) refuse('REAL_TARGET_RESOURCE_REFUSED', { resource: options.resource_key });
  const expected = `${handle.database}@${handle.container_id.slice(0, 12)}:${options.resource_key}`;
  if (options.confirm !== expected) refuse('REAL_TARGET_CONFIRMATION_MISMATCH', { expected });
}

/** Reads the live database identity. Secrets never appear here. */
export async function targetFacts(session: SqlSession, container: InspectedContainer): Promise<WritableTargetFacts> {
  const [row] = await session.query<{ database_name: string | null; hostname: string; version: string }>(
    'SELECT DATABASE() AS database_name, @@hostname AS hostname, VERSION() AS version');
  if (!row?.database_name) refuse('REAL_TARGET_DATABASE_MISSING');
  return {
    database: row.database_name, hostname: row.hostname, version: row.version,
    container_id: container.id, container_labels: container.labels,
  };
}

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

const IDENTITY_FIELDS = new Set([
  'resource_type', 'engine', 'old_id', 'unit', 'target_metric_id', 'target_unit',
  'in_scope', 'has_custom_sql', 'custom_sql_reviewed', 'ambiguous_provider', 'target_missing',
]);

/** Strict parse of the inventory export the operator hands the CLI. */
export function parseManifest(input: unknown): RealPlanRequest {
  if (!input || typeof input !== 'object') refuse('REAL_MANIFEST_INVALID');
  const manifest = input as Record<string, unknown>;
  const resource = manifest.resource as Record<string, unknown> | undefined;
  if (!resource || !['instance', 'server', 'network_device'].includes(String(resource.type))
    || !Number.isInteger(resource.id) || (resource.id as number) <= 0) refuse('REAL_MANIFEST_INVALID', { field: 'resource' });
  if (!Array.isArray(manifest.identities)) refuse('REAL_MANIFEST_INVALID', { field: 'identities' });
  const identities = manifest.identities.map(item => {
    if (!item || typeof item !== 'object') refuse('REAL_MANIFEST_INVALID', { field: 'identities[]' });
    const identity = item as Record<string, unknown>;
    for (const key of Object.keys(identity)) {
      if (!IDENTITY_FIELDS.has(key)) refuse('REAL_MANIFEST_INVALID', { field: `identities[].${key}` });
    }
    if (!['instance', 'server', 'network_device'].includes(String(identity.resource_type))) refuse('REAL_MANIFEST_INVALID');
    if (typeof identity.old_id !== 'string' || identity.old_id.length === 0) refuse('REAL_MANIFEST_INVALID');
    if (typeof identity.unit !== 'string') refuse('REAL_MANIFEST_INVALID');
    if (identity.target_metric_id !== null && typeof identity.target_metric_id !== 'string') refuse('REAL_MANIFEST_INVALID');
    if (identity.target_unit !== null && typeof identity.target_unit !== 'string') refuse('REAL_MANIFEST_INVALID');
    if (typeof identity.in_scope !== 'boolean' || typeof identity.has_custom_sql !== 'boolean'
      || typeof identity.custom_sql_reviewed !== 'boolean') refuse('REAL_MANIFEST_INVALID');
    const engine = identity.engine === null || identity.engine === undefined ? null : identity.engine;
    if (engine !== null && typeof engine !== 'string') refuse('REAL_MANIFEST_INVALID');
    return { ...identity, engine } as unknown as IdentityInput;
  });
  const blockers = manifest.object_blockers ?? [];
  if (!Array.isArray(blockers) || blockers.some(item => typeof item !== 'string')) refuse('REAL_MANIFEST_INVALID');
  return {
    resource: { type: resource.type as RealResourceType, id: resource.id as number },
    identities,
    template_pins: manifest.template_pins ?? [],
    object_blockers: blockers as string[],
  };
}

/** Stable JSON for evidence files: sorted keys, two-space indent. */
export function evidenceJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sort(item)]));
    }
    return input;
  };
  return JSON.stringify(sort(value), null, 2);
}

/** Digest helper re-exported so CLI/test evidence uses the same encoding. */
export const realDigest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

export type { ResourceType };
