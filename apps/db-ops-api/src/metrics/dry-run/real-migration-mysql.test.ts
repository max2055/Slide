/**
 * MAX-236 / P0-REAL-A real-schema proof.
 *
 * This suite builds a disposable database with the repository's REAL migration
 * ledger (all 134 migrations) plus the candidate S8 DDL (140–142), seeds the
 * task's own acceptance objects, and runs the actual executor against the real
 * tables:
 *
 *   plan -> apply -> exact replay (noop) -> same-revision drift refusal ->
 *   second apply -> rollback (multi-template preserved) -> rollback to the
 *   seeded baseline -> failure injection -> content-level counterexamples.
 *
 * The endpoint is verified against the creation-record handle BEFORE the test
 * database is dropped or created; an arbitrary DSN never reaches DDL.
 *
 *   MAX236_REALA_HANDLE=.max236-reala/handle.json \
 *   MAX236_REALA_MYSQL_DSN=mysql://root@127.0.0.1:33440 \
 *     npx vitest run src/metrics/dry-run/real-migration-mysql.test.ts
 *
 * Without the DSN the suite is skipped, so ordinary CI stays Docker-free.
 * It proves an isolated acceptance database only: no production consumer, no
 * collection, no notification, no production cutover.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, createPool, type Connection, type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, splitSqlStatements } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import type { IdentityInput } from './migration-drill.js';
import {
  applyRealMigration, applyRealRollback, assertOwnedEndpoint, assertWritableTarget, inspectOwnedTarget,
  mysqlSession, parseHandle, parseManifest, planRealMigration, planRealRollback, readRealSnapshot,
  targetFacts, verifyPreservation,
  RealRefusal, type SqlSession,
} from './real-migration.js';

const dsn = process.env.MAX236_REALA_MYSQL_DSN;
const handlePath = process.env.MAX236_REALA_HANDLE;
const run = dsn ? describe : describe.skip;
const TEST_DB = 'max236_reala_test';

const hashOf = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const pin = (id: string, version = 1) => ({ template_id: id, version, content_hash: hashOf(`${id}@${version}`) });
const PINS = [pin('tpl-a'), pin('tpl-foundation')];
const PACKAGE = { id: 'mysql-basic', version: '1.0.0', digest: hashOf('mysql-basic@1.0.0') };
const AT = '2026-10-27 10:00:00.000';
const PENDING = { applied_revision: null, reported_at: null, status: 'pending', error_code: null };

const identities = (type: 'instance' | 'server' | 'network_device', engine: string | null): IdentityInput[] => [
  { resource_type: type, engine, old_id: 'cpu_old', unit: '%', target_metric_id: 'cpu_usage', target_unit: null,
    in_scope: true, has_custom_sql: false, custom_sql_reviewed: false },
  { resource_type: type, engine, old_id: 'legacy_old', unit: '%', target_metric_id: null, target_unit: null,
    in_scope: true, has_custom_sql: false, custom_sql_reviewed: false },
  { resource_type: type, engine, old_id: 'retired_old', unit: '%', target_metric_id: 'retired_metric', target_unit: null,
    in_scope: true, has_custom_sql: false, custom_sql_reviewed: false },
];

const refusalCode = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (error) {
    if (error instanceof RealRefusal) return error.code;
    throw error;
  }
  throw new Error('expected a RealRefusal');
};

const refusalSync = (action: () => unknown): string => {
  try { action(); } catch (error) {
    if (error instanceof RealRefusal) return error.code;
    throw error;
  }
  throw new Error('expected a RealRefusal');
};

let admin: Connection;
let connection: Connection;
let session: SqlSession;
let pool: Pool;

beforeAll(async () => {
  if (!handlePath) throw new Error('MAX236_REALA_HANDLE is required when MAX236_REALA_MYSQL_DSN is set');
  const handle = parseHandle(JSON.parse(readFileSync(handlePath, 'utf8')));
  const inspection = await inspectOwnedTarget(handle);
  // Ownership is proven before the harness drops or creates anything.
  assertOwnedEndpoint(dsn as string, handle, inspection, { allow_database: TEST_DB, require_running: true });
  expect(TEST_DB).not.toBe(handle.database);

  const url = new URL(dsn as string);
  const base = {
    host: url.hostname, port: Number(url.port || 3306),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    multipleStatements: false,
  };
  admin = await createConnection(base);
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await admin.query(`CREATE DATABASE \`${TEST_DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  pool = createPool({ ...base, database: TEST_DB, connectionLimit: 2 });
  await new MigrationRunner(pool as unknown as MigrationPool).run();

  connection = await createConnection({ ...base, database: TEST_DB, timezone: 'Z' });
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../docs/slide/development/MAX-236/real-a/sql');
  const files = readdirSync(root).filter(name => /^14[0-2]_.*\.sql$/.test(name)).sort();
  expect(files).toHaveLength(3);
  for (const file of files) {
    for (const statement of splitSqlStatements(readFileSync(join(root, file), 'utf8'))) await connection.query(statement);
  }
  session = mysqlSession(connection);
}, 300_000);

afterAll(async () => {
  await connection?.end().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  // Fresh ownership re-check immediately before the destructive DROP: the
  // endpoint, container ID and labels must still be the creation record.
  const handle = parseHandle(JSON.parse(readFileSync(handlePath as string, 'utf8')));
  const inspection = await inspectOwnedTarget(handle);
  assertOwnedEndpoint(dsn as string, handle, inspection, { allow_database: TEST_DB, require_running: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await admin.end();
});

const bindingPayload = (type: string, id: number, overrides: Record<string, unknown> = {}) => JSON.stringify({
  binding: {
    resource: { type, id },
    package: PACKAGE,
    group_id: null,
    overrides,
    revision: 0,
  },
  resolved: null,
  published_at: AT,
  application: PENDING,
});

beforeEach(async () => {
  await connection.query('DELETE FROM metric_policy_audit');
  await connection.query('DELETE FROM metric_policy_bindings');
  await connection.query('DELETE FROM metric_schedule');
  await connection.query('DELETE FROM metric_publications');
  await connection.query('DELETE FROM metric_observations');
  await connection.query('DELETE FROM metric_rollout');
  await connection.query('DELETE FROM metrics_history');
  await connection.query('DELETE FROM alerts');
  await connection.query('DELETE FROM audit_log_entries');
  await connection.query('DELETE FROM instance_permissions');
  await connection.query('DELETE FROM network_device_credentials');
  await connection.query('DELETE FROM network_device_observations');
  await connection.query('DELETE FROM server_metrics');
  await connection.query('DELETE FROM database_instances');
  await connection.query('DELETE FROM servers');
  await connection.query('DELETE FROM network_devices');
  await connection.query('DELETE FROM users WHERE id = 9001');
  await connection.query('DELETE FROM metric_template_versions');
  await connection.query('DELETE FROM metric_templates_v2');

  await connection.query('INSERT INTO users (id, username, password_hash, status) VALUES (9001, ?, ?, ?)',
    ['max236-reala-actor', 'not-a-real-hash', 'active']);
  await connection.query(`INSERT INTO metric_templates_v2 (template_id, name, status, current_published_version, revision, created_at, updated_at)
    VALUES ('tpl-a', 'A', 'active', 1, 1, ?, ?), ('tpl-foundation', 'Foundation', 'active', 1, 1, ?, ?)`, [AT, AT, AT, AT]);
  for (const template of ['tpl-a', 'tpl-foundation']) {
    await connection.query(`INSERT INTO metric_template_versions
      (template_id, version, status, content_hash, aggregate, items, package_composition, source_chain, published_at)
      VALUES (?, 1, 'published', ?, ?, '[]', '[]', '{}', ?)`,
    [template, pin(template).content_hash, JSON.stringify({ template_id: template, items: [], triggers: [] }), AT]);
  }
  for (const [target, id, unit, collected] of [
    ['instance', 'cpu_usage', '%', 1], ['instance', 'retired_metric', '%', 0], ['server', 'cpu_usage', '%', 1],
  ] as Array<[string, string, string, number]>) {
    await connection.query(`INSERT INTO metric_definitions
      (id, target_type, name, unit, db_types, aggregation, default_interval, is_collected, is_builtin)
      VALUES (?, ?, ?, ?, '["mysql"]', 'avg', 60, ?, 0)
      ON DUPLICATE KEY UPDATE unit = VALUES(unit), is_collected = VALUES(is_collected)`, [id, target, id, unit, collected]);
  }

  await connection.query(`INSERT INTO database_instances
    (id, name, environment, db_type, host, port, username, password_encrypted, database_name, status)
    VALUES (9101, 'max236-reala-instance', 'testing', 'mysql', '127.0.0.1', 1, 'reala', 'ENC[not-a-secret]', 'none', 'active')`);
  await connection.query(`INSERT INTO servers
    (id, host, port, os_type, credential_type, credential_encrypted, status)
    VALUES (9201, '127.0.0.1', 2222, 'Other', 'password', 'ENC[not-a-secret]', 'offline')`);
  await connection.query(`INSERT INTO network_devices (id, name, host, vendor, status)
    VALUES (9301, 'max236-reala-device', '127.0.0.1', 'huawei', 'unknown')`);
  await connection.query(`INSERT INTO network_device_credentials (device_id, protocol, username, community_encrypted)
    VALUES (9301, 'snmpv2c', 'reala', 'ENC[not-a-secret]')`);
  // ACL content includes the grant level and expiry the old identity-only digest missed.
  await connection.query(`INSERT INTO instance_permissions (user_id, instance_id, access_level, grant_expiry)
    VALUES (9001, 9101, 'admin', '2027-01-01 00:00:00')`);

  for (const [key, type, id] of [['instance:9101', 'instance', 9101], ['server:9201', 'server', 9201],
    ['network_device:9301', 'network_device', 9301]] as Array<[string, string, number]>) {
    await connection.query('INSERT INTO metric_policy_bindings (resource_key, group_id, payload, capabilities) VALUES (?, NULL, ?, ?)',
      [key, bindingPayload(type, id), '[]']);
    await connection.query('INSERT INTO metric_policy_audit (target, payload) VALUES (?, ?)', [key, JSON.stringify({
      actor_id: 9001, request_id: 'max236-baseline:seed', action: 'binding.publish', target: key,
      revision: 0, at: AT, configuration: { package: PACKAGE, group_id: null, overrides: {}, template_pins: [] },
    })]);
    await connection.query(`INSERT INTO metric_schedule (resource_key, revision, next_due_ms, job_id, states)
      VALUES (?, 0, 0, ?, '{}')`, [key, `job-${type}-${id}`]);
  }

  const series = hashOf('series-1').slice('sha256:'.length);
  await connection.query(`INSERT INTO metric_rollout
    (series_hash, source, generation, read_mode, package_pin, published_revision, resource_type, resource_id)
    VALUES (?, 'max236-reala', 1, 'legacy', ?, 0, 'instance', '9101')`, [series, JSON.stringify(PACKAGE)]);
  for (const stage of ['raw', 'normalized']) {
    await connection.query(`INSERT INTO metric_observations
      (id, series_hash, stage, observed_at, stored_at, valid_value, payload, payload_hash, evidence_expires_at)
      VALUES (?, ?, ?, ?, ?, 1, NULL, ?, NULL)`,
    [`${hashOf(`${stage}-1`)}`, series, stage, AT, AT, hashOf(`${stage}-payload`).slice('sha256:'.length)]);
  }
  await connection.query('INSERT INTO metric_publications (observation_id, series_hash, generation, observed_at) VALUES (?, ?, 1, ?)',
    [hashOf('normalized-1'), series, AT]);
  await connection.query(`INSERT INTO metrics_history (instance_id, cpu_usage, memory_usage, buffer_pool_hit_rate, recorded_at)
    VALUES (9101, 42.50, 61.25, 99.10, ?), (9101, 43.50, 62.25, 99.20, ?)`, [AT, AT]);
  await connection.query(`INSERT INTO alerts (instance_id, alert_type, level, title, message, status)
    VALUES (9101, 'performance', 'warning', 'seeded', 'seeded', 'unread')`);
  await connection.query(`INSERT INTO audit_log_entries
    (id, event_type, level, action, resource_type, resource_id, result, timestamp_ms)
    VALUES ('max236-reala-audit-1', 'metric', 'info', 'seed', 'instance', '9101', 'success', 1)`);
  await connection.query(`INSERT INTO server_metrics (server_id, metric_name, dimensions, metric_value, recorded_at)
    VALUES (9201, 'cpu_usage', '{}', 10.0000, ?)`, [AT]);
  await connection.query(`INSERT INTO network_device_observations (device_id, metric_id, dimensions, metric_value, observed_at, quality, source)
    VALUES (9301, 'cpu', '{}', 1.00000000, ?, 'good', 'max236-reala')`, [AT]);
}, 60_000);

const instanceRequest = () => ({ resource: { type: 'instance' as const, id: 9101 }, identities: identities('instance', 'mysql'), template_pins: PINS });
const readInstance = () => readRealSnapshot(session, { type: 'instance', id: 9101 });
const bindingRevision = async (key: string): Promise<number> => {
  const [row] = await session.query<{ payload: unknown }>('SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [key]);
  const payload = typeof row?.payload === 'string' ? JSON.parse(row.payload) as unknown : row?.payload;
  const binding = (payload as { binding?: { revision?: unknown } } | undefined)?.binding;
  if (!binding || typeof binding.revision !== 'number') throw new Error('binding revision missing');
  return binding.revision;
};
const auditCount = async (key: string): Promise<number> => {
  const [row] = await session.query<{ n: number }>('SELECT COUNT(*) AS n FROM metric_policy_audit WHERE target = ?', [key]);
  return Number(row?.n ?? 0);
};

run('real-schema migration and rollback', () => {
  it('reads the real platform tables and treats the candidate template catalog as the pin source', async () => {
    const snapshot = await readInstance();
    expect(snapshot.resource_exists).toBe(true);
    expect(snapshot.engine).toBe('mysql');
    expect(snapshot.binding?.revision).toBe(0);
    expect(snapshot.binding_payload_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snapshot.template_catalog_supported).toBe(true);
    expect(snapshot.templates['tpl-a']?.versions[1]).toMatchObject({ content_hash: pin('tpl-a').content_hash, status: 'published', aggregate_ok: true, items_ok: true });
    expect(snapshot.catalog['instance:cpu_usage']).toEqual({ unit: '%', is_collected: true });
    expect(snapshot.preservation.history.map(block => block.table)).toEqual(
      expect.arrayContaining(['metrics_history', 'metric_observations', 'metric_publications']));
    expect(snapshot.preservation.history.every(block => block.count > 0 && !block.truncated)).toBe(true);
    expect(snapshot.preservation.credentials).toEqual([
      { ref: 'credential:instance-9101:password', present: true, digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
    ]);
    expect(snapshot.preservation.acl.rows).toEqual(['acl:instance-9101:user-9001']);
    expect(snapshot.preservation.acl.count).toBe(1);
    expect(snapshot.preservation.schedules.rows).toEqual([{ job_id: 'job-instance-9101', digest: expect.any(String) }]);
    expect(snapshot.schema_fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  }, 60_000);

  it('plans from the real catalog and applies one authoritative binding revision', async () => {
    const before = await readInstance();
    const plan = planRealMigration(before, instanceRequest());
    expect(plan.cutover_allowed).toBe(true);
    expect(plan.rows.map(row => row.disposition)).toEqual(expect.arrayContaining(['mapped', 'keep-legacy']));
    expect(plan.baseline?.payload_digest).toBe(before.binding_payload_digest);

    const result = await applyRealMigration(session, plan, before, { actor_id: 9001, at: AT });
    expect(result).toMatchObject({ outcome: 'applied', revision: 1, written: 1 });
    expect(result.preservation).toMatchObject({ ok: true, complete: true });
    expect(result.request_id).toBe(`max236-migrate:${plan.digest}`);

    const after = await readInstance();
    expect(after.binding).toMatchObject({ revision: 1, package: null, template_pins: PINS });
    const [raw] = await session.query<{ payload: string; group_id: string | null }>(
      'SELECT payload, group_id FROM metric_policy_bindings WHERE resource_key = ?', ['instance:9101']);
    const payload = typeof raw?.payload === 'string' ? JSON.parse(raw.payload) : raw?.payload;
    expect(payload.resolved).toBeNull();
    expect(payload.binding.template_pins).toHaveLength(2);
    expect(payload.binding.package).toBeNull();
    expect(raw?.group_id).toBeNull();
    const [audit] = await session.query<{ payload: string }>(
      "SELECT payload FROM metric_policy_audit WHERE target = 'instance:9101' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.request_id')) = ?",
      [result.request_id]);
    expect(audit).toBeDefined();
  }, 60_000);

  it('treats an exact replay as a no-op and writes nothing', async () => {
    const before = await readInstance();
    const plan = planRealMigration(before, instanceRequest());
    await applyRealMigration(session, plan, before, { actor_id: 9001, at: AT });
    const afterApply = await readInstance();
    const audits = await auditCount('instance:9101');
    const replay = await applyRealMigration(session, plan, afterApply, { actor_id: 9001, at: AT });
    expect(replay).toMatchObject({ outcome: 'noop', written: 0, revision: 1 });
    expect(await auditCount('instance:9101')).toBe(audits);
    expect((await readInstance()).binding?.revision).toBe(1);
  }, 60_000);

  it('refuses a same-revision override drift as an exact replay and leaves it untouched', async () => {
    const before = await readInstance();
    const plan = planRealMigration(before, instanceRequest());
    await applyRealMigration(session, plan, before, { actor_id: 9001, at: AT });
    await connection.query(
      "UPDATE metric_policy_bindings SET payload = JSON_SET(payload, '$.binding.overrides', JSON_OBJECT('chief_probe', 2)) WHERE resource_key = 'instance:9101'");
    const drifted = await readInstance();
    const audits = await auditCount('instance:9101');
    expect(await refusalCode(applyRealMigration(session, plan, drifted, { actor_id: 9001, at: AT })))
      .toBe('REAL_REPLAY_CONFLICT');
    expect(await auditCount('instance:9101')).toBe(audits);
    expect((await readInstance()).binding?.overrides).toEqual({ chief_probe: 2 });
  }, 60_000);

  it('refuses a plan whose baseline changed after planning (pre-write baseline check)', async () => {
    const before = await readInstance();
    const plan = planRealMigration(before, instanceRequest());
    await connection.query(
      "UPDATE metric_policy_bindings SET payload = JSON_SET(payload, '$.binding.overrides', JSON_OBJECT('late_drift', 1)) WHERE resource_key = 'instance:9101'");
    const drifted = await readInstance();
    const audits = await auditCount('instance:9101');
    expect(await refusalCode(applyRealMigration(session, plan, drifted, { actor_id: 9001, at: AT })))
      .toBe('REAL_BASELINE_DRIFT');
    expect(await auditCount('instance:9101')).toBe(audits);
    expect(await bindingRevision('instance:9101')).toBe(0);
  }, 60_000);

  it('refuses a drifted replay and leaves the drifted state untouched', async () => {
    const before = await readInstance();
    const plan = planRealMigration(before, instanceRequest());
    await applyRealMigration(session, plan, before, { actor_id: 9001, at: AT });
    const [raw] = await session.query<{ payload: string }>('SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', ['instance:9101']);
    const payload = typeof raw?.payload === 'string' ? JSON.parse(raw.payload) : raw?.payload;
    payload.binding.template_pins = [pin('tpl-a')];
    await session.query('UPDATE metric_policy_bindings SET payload = ? WHERE resource_key = ?', [JSON.stringify(payload), 'instance:9101']);
    const drifted = await readInstance();
    const audits = await auditCount('instance:9101');
    expect(await refusalCode(applyRealMigration(session, plan, drifted, { actor_id: 9001, at: AT })))
      .toBe('REAL_REPLAY_CONFLICT');
    expect(await auditCount('instance:9101')).toBe(audits);
    expect((await readInstance()).binding?.template_pins).toEqual([pin('tpl-a')]);
  }, 60_000);

  it('refuses a stale plan after another revision lands', async () => {
    const first = await readInstance();
    const planOne = planRealMigration(first, instanceRequest());
    await applyRealMigration(session, planOne, first, { actor_id: 9001, at: AT });
    const second = await readInstance();
    const planTwo = planRealMigration(second, { ...instanceRequest(), template_pins: [pin('tpl-a')] });
    await applyRealMigration(session, planTwo, second, { actor_id: 9001, at: AT });
    const third = await readInstance();
    expect((await applyRealMigration(session, planTwo, third, { actor_id: 9001, at: AT })).outcome).toBe('noop');
    expect(await refusalCode(applyRealMigration(session, planOne, third, { actor_id: 9001, at: AT })))
      .toBe('REAL_PLAN_STALE');
  }, 60_000);

  it('rolls back by appending a revision and keeps a multi-template target intact', async () => {
    const before = await readInstance();
    const multi = planRealMigration(before, instanceRequest());
    await applyRealMigration(session, multi, before, { actor_id: 9001, at: AT });
    const afterMulti = await readInstance();
    const single = planRealMigration(afterMulti, { ...instanceRequest(), template_pins: [pin('tpl-a')] });
    await applyRealMigration(session, single, afterMulti, { actor_id: 9001, at: AT });
    const beforeRollback = await readInstance();
    expect(beforeRollback.binding?.revision).toBe(2);

    const rollback = planRealRollback(beforeRollback, { target_revision: 1, expected_current_revision: 2 });
    const result = await applyRealRollback(session, rollback, beforeRollback, {
      target_revision: 1, expected_current_revision: 2, actor_id: 9001, at: AT,
    });
    expect(result).toMatchObject({ outcome: 'applied', revision: 3, written: 1 });
    expect(result.preservation.ok).toBe(true);
    const afterRollback = await readInstance();
    expect(afterRollback.binding).toMatchObject({ revision: 3, package: null, template_pins: PINS });
    expect(afterRollback.binding?.template_pins).toHaveLength(2);
  }, 60_000);

  it('rolls back to the seeded baseline, restoring the legacy package, group and overrides', async () => {
    const before = await readInstance();
    const plan = planRealMigration(before, instanceRequest());
    await applyRealMigration(session, plan, before, { actor_id: 9001, at: AT });
    // Drift a field the old rollback did not restore; rollback must restore the
    // complete target configuration and audit what was actually written.
    await connection.query(
      "UPDATE metric_policy_bindings SET payload = JSON_SET(payload, '$.binding.overrides', JSON_OBJECT('drift', 7)) WHERE resource_key = 'instance:9101'");
    const afterApply = await readInstance();
    const rollback = planRealRollback(afterApply, { target_revision: 0, expected_current_revision: 1 });
    const result = await applyRealRollback(session, rollback, afterApply, {
      target_revision: 0, expected_current_revision: 1, actor_id: 9001, at: AT,
    });
    expect(result.preservation.ok).toBe(true);
    const after = await readInstance();
    expect(after.binding).toMatchObject({ revision: 2, package: PACKAGE, template_pins: [], group_id: null, overrides: {} });
    const [stored] = await session.query<{ payload: string; group_id: string | null }>(
      'SELECT payload, group_id FROM metric_policy_bindings WHERE resource_key = ?', ['instance:9101']);
    const payload = typeof stored?.payload === 'string' ? JSON.parse(stored.payload) : stored?.payload;
    expect(payload.binding.template_pins).toBeUndefined();
    expect(payload.binding.package).toEqual(PACKAGE);
    expect(payload.binding.overrides).toEqual({});
    expect(stored?.group_id).toBeNull();
    const [audit] = await session.query<{ payload: string }>(
      "SELECT payload FROM metric_policy_audit WHERE target='instance:9101' ORDER BY id DESC LIMIT 1");
    const auditPayload = typeof audit?.payload === 'string' ? JSON.parse(audit.payload) : audit?.payload;
    expect(auditPayload.configuration.overrides).toEqual({});
    expect(auditPayload.configuration.group_id).toBeNull();
    for (const check of result.preservation.checks) expect(check.status).not.toBe('fail');
  }, 60_000);

  it('supports a legal rollback replay after the same rollback was applied', async () => {
    const before = await readInstance();
    const plan = planRealMigration(before, instanceRequest());
    await applyRealMigration(session, plan, before, { actor_id: 9001, at: AT });
    const afterApply = await readInstance();
    const rollback = planRealRollback(afterApply, { target_revision: 0, expected_current_revision: 1 });
    await applyRealRollback(session, rollback, afterApply, {
      target_revision: 0, expected_current_revision: 1, actor_id: 9001, at: AT,
    });
    const rolledBack = await readInstance();
    const replayPlan = planRealRollback(rolledBack, { target_revision: 0, expected_current_revision: 1 });
    expect(replayPlan.digest).toBe(rollback.digest);
    const audits = await auditCount('instance:9101');
    const result = await applyRealRollback(session, replayPlan, rolledBack, {
      target_revision: 0, expected_current_revision: 1, actor_id: 9001, at: AT,
    });
    expect(result).toMatchObject({ outcome: 'noop', written: 0, revision: 2 });
    expect(await auditCount('instance:9101')).toBe(audits);
    expect(await bindingRevision('instance:9101')).toBe(2);
  }, 60_000);

  it('detects a same-count history rewrite including a previously omitted column', async () => {
    const before = await readInstance();
    await connection.query('UPDATE metrics_history SET cpu_usage = 99.99 WHERE instance_id = 9101 AND cpu_usage = 42.50');
    expect(verifyPreservation(before, await readInstance()).ok).toBe(false);
    await connection.query('UPDATE metrics_history SET cpu_usage = 42.50 WHERE instance_id = 9101 AND cpu_usage = 99.99');
    expect(verifyPreservation(before, await readInstance()).ok).toBe(true);

    await connection.query('UPDATE metrics_history SET buffer_pool_hit_rate = 12.34 WHERE instance_id = 9101 AND cpu_usage = 42.50');
    const report = verifyPreservation(before, await readInstance());
    expect(report.ok).toBe(false);
    expect(report.checks.find(check => check.name === 'history-content')?.status).toBe('fail');
    await connection.query('UPDATE metrics_history SET buffer_pool_hit_rate = 99.10 WHERE instance_id = 9101 AND cpu_usage = 42.50');
    expect(verifyPreservation(before, await readInstance()).ok).toBe(true);
  }, 60_000);

  it('detects ACL grant-level and expiry changes that identity-only digests missed', async () => {
    const before = await readInstance();
    await connection.query("UPDATE instance_permissions SET access_level='read-only', grant_expiry='2001-01-01 00:00:00' WHERE instance_id = 9101");
    const report = verifyPreservation(before, await readInstance());
    expect(report.ok).toBe(false);
    expect(report.checks.find(check => check.name === 'acl')?.status).toBe('fail');
    await connection.query("UPDATE instance_permissions SET access_level='admin', grant_expiry='2027-01-01 00:00:00' WHERE instance_id = 9101");
    expect(verifyPreservation(before, await readInstance()).ok).toBe(true);
  }, 60_000);

  it('refuses a new apply plan when a pinned template version is retired', async () => {
    await connection.query("UPDATE metric_template_versions SET status='retired', retired_at='2026-10-27 12:03:00' WHERE template_id='tpl-a'");
    const plan = planRealMigration(await readInstance(), instanceRequest());
    expect(plan.cutover_allowed).toBe(false);
    expect(plan.blockers).toContain('TEMPLATE_VERSION_NOT_PUBLISHED:tpl-a@1:retired');
    expect(await refusalCode(applyRealMigration(session, plan, await readInstance(), { actor_id: 9001, at: AT })))
      .toBe('REAL_CUTOVER_BLOCKED');
    expect(await bindingRevision('instance:9101')).toBe(0);
  }, 60_000);

  it('binds the migration ledger into the schema fingerprint', async () => {
    const [row] = await session.query<{ migration_id: string; checksum: string }>(
      "SELECT migration_id, checksum FROM app_schema_migrations ORDER BY migration_id LIMIT 1");
    const before = await readInstance();
    await connection.query('UPDATE app_schema_migrations SET checksum = ? WHERE migration_id = ?', ['0'.repeat(64), row!.migration_id]);
    const after = await readInstance();
    expect(after.schema_fingerprint).not.toBe(before.schema_fingerprint);
    await connection.query('UPDATE app_schema_migrations SET checksum = ? WHERE migration_id = ?', [row!.checksum, row!.migration_id]);
    expect((await readInstance()).schema_fingerprint).toBe(before.schema_fingerprint);
  }, 60_000);

  it('rolls the binding write back when the audit write is injected to fail', async () => {
    const before = await readInstance();
    const plan = planRealMigration(before, instanceRequest());
    const audits = await auditCount('instance:9101');
    expect(await refusalCode(applyRealMigration(session, plan, before, { actor_id: 9001, at: AT, fail_at: 'after-binding' })))
      .toBe('REAL_INJECTED_FAILURE:after-binding');
    expect(await bindingRevision('instance:9101')).toBe(0);
    expect(await auditCount('instance:9101')).toBe(audits);
    expect((await readInstance()).binding?.template_pins).toEqual([]);
  }, 60_000);

  it('aborts before durable commit when preservation is corrupted after the binding update', async () => {
    const before = await readInstance();
    const plan = planRealMigration(before, instanceRequest());
    const audits = await auditCount('instance:9101');
    let committed = false, injected = false, failure = '';
    const corrupting: SqlSession = {
      ...session,
      query: async <R>(sql: string, values?: unknown[]) => {
        const result = await session.query<R>(sql, values);
        if (sql.startsWith('UPDATE metric_policy_bindings') && !injected) {
          injected = true;
          await connection.query('UPDATE metrics_history SET cpu_usage = cpu_usage + 1 WHERE instance_id = 9101');
        }
        return result;
      },
      commit: async () => { await session.commit(); committed = true; },
    };
    try {
      await applyRealMigration(corrupting, plan, before, { actor_id: 9001, at: AT });
    } catch (error) {
      failure = error instanceof RealRefusal ? error.code : String(error);
    }
    expect(failure).toBe('REAL_PRESERVATION_VIOLATION');
    expect(committed).toBe(false);
    // The corruption ran on the same transaction, so the rollback reverts both writes.
    expect(await bindingRevision('instance:9101')).toBe(0);
    expect(await auditCount('instance:9101')).toBe(audits);
  }, 60_000);

  it('refuses a rollback whose observed current revision is stale', async () => {
    const before = await readInstance();
    const plan = planRealMigration(before, instanceRequest());
    await applyRealMigration(session, plan, before, { actor_id: 9001, at: AT });
    const after = await readInstance();
    expect(refusalSync(() => planRealRollback(after, { target_revision: 0, expected_current_revision: 0 })))
      .toBe('REAL_ROLLBACK_CONFLICT');
    expect(await bindingRevision('instance:9101')).toBe(1);
  }, 60_000);

  it('keeps the device class blocked and unwritten: no device metric catalog exists', async () => {
    const before = await readRealSnapshot(session, { type: 'network_device', id: 9301 });
    const plan = planRealMigration(before, {
      resource: { type: 'network_device', id: 9301 },
      identities: identities('network_device', null),
      template_pins: [pin('tpl-a')],
    });
    expect(plan.cutover_allowed).toBe(false);
    expect(plan.rows.some(row => row.disposition === 'blocked')).toBe(true);
    expect(await refusalCode(applyRealMigration(session, plan, before, { actor_id: 9001, at: AT })))
      .toBe('REAL_CUTOVER_BLOCKED');
    expect(await bindingRevision('network_device:9301')).toBe(0);
    expect((await readRealSnapshot(session, { type: 'network_device', id: 9301 })).preservation.history.every(block => block.count > 0)).toBe(true);
  }, 60_000);

  it('migrates the server class with server-scoped catalog and its own history table', async () => {
    const before = await readRealSnapshot(session, { type: 'server', id: 9201 });
    const plan = planRealMigration(before, {
      resource: { type: 'server', id: 9201 },
      identities: identities('server', null).filter(identity => identity.target_metric_id !== 'retired_metric'),
      template_pins: [pin('tpl-a')],
    });
    expect(plan.cutover_allowed).toBe(true);
    expect(plan.rows.find(row => row.identity.includes('cpu_old'))?.disposition).toBe('mapped');
    const result = await applyRealMigration(session, plan, before, { actor_id: 9001, at: AT });
    expect(result).toMatchObject({ outcome: 'applied', revision: 1 });
    // No per-resource ACL table exists for servers: reported unsupported, not PASS.
    expect(result.preservation.complete).toBe(false);
    expect(result.preservation.checks.find(check => check.name === 'acl')?.status).toBe('unsupported');
    const after = await readRealSnapshot(session, { type: 'server', id: 9201 });
    expect(after.preservation.history.find(block => block.table === 'server_metrics')?.count).toBe(1);
    expect(after.preservation.credentials).toEqual([
      { ref: 'credential:server-9201:primary', present: true, digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
    ]);
  }, 60_000);

  it('confirms the live target facts and refuses any other database, owner, ID or resource', async () => {
    const [{ hostname }] = await session.query<{ hostname: string }>('SELECT @@hostname AS hostname');
    const handle = parseHandle(JSON.parse(readFileSync(handlePath as string, 'utf8')));
    const container = {
      id: handle.container_id,
      name: '/max236-reala-15coder1',
      image: handle.image,
      running: true,
      labels: { 'max236.owner': handle.owner, 'max236.phase': handle.phase },
      mounts: [{ type: 'volume', name: handle.volume, destination: '/var/lib/mysql' }],
      networks: [handle.network],
      network_ids: [handle.network_id],
      published: [{ host_ip: '127.0.0.1', host_port: handle.port, container_port: 3306 }],
    };
    const facts = await targetFacts(session, container);
    expect(facts.database).toBe(TEST_DB);
    expect(hostname.slice(0, 12)).toBe(handle.container_id.slice(0, 12));
    // The harness database is not the write target, even on the owned endpoint.
    expect(refusalSync(() => assertWritableTarget(facts, {
      handle, confirm: `${TEST_DB}@${hostname.slice(0, 12)}:instance:9101`, resource_key: 'instance:9101',
    }))).toBe('REAL_TARGET_DATABASE_REFUSED');
    const writable = {
      ...facts, database: handle.database, hostname: handle.container_id.slice(0, 12),
      container_id: handle.container_id,
    };
    expect(() => assertWritableTarget(writable, {
      handle, confirm: `${handle.database}@${handle.container_id.slice(0, 12)}:instance:9101`, resource_key: 'instance:9101',
    })).not.toThrow();
    expect(refusalSync(() => assertWritableTarget({ ...writable, database: 'slide' }, {
      handle, confirm: 'slide@x:instance:9101', resource_key: 'instance:9101',
    }))).toBe('REAL_TARGET_DATABASE_REFUSED');
    expect(refusalSync(() => assertWritableTarget({ ...writable, container_labels: { 'max236.owner': 'other', 'max236.phase': handle.phase } }, {
      handle, confirm: 'x', resource_key: 'instance:9101',
    }))).toBe('REAL_TARGET_OWNER_REFUSED');
    expect(refusalSync(() => assertWritableTarget({ ...writable, container_id: 'f'.repeat(64) }, {
      handle, confirm: 'x', resource_key: 'instance:9101',
    }))).toBe('REAL_TARGET_CONTAINER_ID_MISMATCH');
    expect(refusalSync(() => assertWritableTarget(writable, {
      handle, confirm: `${handle.database}@${handle.container_id.slice(0, 12)}:network_device:9301`, resource_key: 'network_device:9301',
    }))).toBe('REAL_TARGET_RESOURCE_REFUSED');
  }, 60_000);

  it('parses the shipped manifest shape without inventing identities', () => {
    const request = parseManifest({
      resource: { type: 'instance', id: 9101 },
      identities: identities('instance', 'mysql'),
      template_pins: PINS,
      object_blockers: [],
    });
    expect(request.identities).toHaveLength(3);
    expect(request.resource).toEqual({ type: 'instance', id: 9101 });
  });

  // ---------------------------------------------------------------- B2 counterexamples
  // Chief's independent counterexample: a same-revision overrides edit AFTER the
  // rollback plan was produced must be refused with zero writes.
  it('rejects same-revision rollback baseline configuration drift with zero writes', async () => {
    const before = await readInstance();
    const plan = planRealMigration(before, instanceRequest());
    await applyRealMigration(session, plan, before, { actor_id: 9001, at: AT });
    const prior = await readInstance();
    const rollback = planRealRollback(prior, { target_revision: 0, expected_current_revision: 1 });
    await connection.query(
      "UPDATE metric_policy_bindings SET payload=JSON_SET(payload,'$.binding.overrides',JSON_OBJECT('chief_drift',1)) WHERE resource_key='instance:9101'");
    const audits = await auditCount('instance:9101');
    let refused = false;
    try {
      await applyRealRollback(session, rollback, await readInstance(), {
        actor_id: 9001, at: AT, target_revision: 0, expected_current_revision: 1,
      });
    } catch (error) { refused = error instanceof RealRefusal; }
    expect({ refused, revision: await bindingRevision('instance:9101'), audits: await auditCount('instance:9101') })
      .toEqual({ refused: true, revision: 1, audits });
  }, 60_000);

  // Chief's independent counterexample: a saved plan re-submitted under a
  // manifest that adds an object blocker must exit 2 without writing.
  it('refuses a changed CLI manifest invocation when submitting an earlier plan', async () => {
    const before = await readInstance();
    const request = instanceRequest();
    const plan = planRealMigration(before, request);
    const handle = parseHandle(JSON.parse(readFileSync(handlePath as string, 'utf8')));
    const dir = mkdtempSync(join(tmpdir(), 'max236-cli-'));
    try {
      writeFileSync(join(dir, 'handle.json'), JSON.stringify({ ...handle, database: TEST_DB }));
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...request, object_blockers: ['BOUNDARY_NEW_BLOCKER'] }));
      writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
      const run = spawnSync(process.execPath, [
        join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), join(process.cwd(), 'scripts/max236-migrate.ts'),
        '--manifest', join(dir, 'manifest.json'), '--plan', join(dir, 'plan.json'), '--apply',
        '--confirm', `${TEST_DB}@${handle.container_id.slice(0, 12)}:instance:9101`, '--expect-digest', plan.digest,
      ], {
        env: {
          ...process.env,
          MAX236_REALA_DSN: `mysql://root@127.0.0.1:${handle.port}/${TEST_DB}`,
          MAX236_REALA_HANDLE: join(dir, 'handle.json'),
        },
        encoding: 'utf8',
      });
      expect({ exit: run.status, revision: await bindingRevision('instance:9101') }).toEqual({ exit: 2, revision: 0 });
      expect(run.stderr).toContain('REAL_PLAN_INVOCATION_MISMATCH');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // The same CLI invocation, unchanged, is still accepted (legal path preserved).
  it('accepts the exact CLI manifest invocation for the saved plan', async () => {
    const before = await readInstance();
    const request = instanceRequest();
    const plan = planRealMigration(before, request);
    const handle = parseHandle(JSON.parse(readFileSync(handlePath as string, 'utf8')));
    const dir = mkdtempSync(join(tmpdir(), 'max236-cli-'));
    try {
      writeFileSync(join(dir, 'handle.json'), JSON.stringify({ ...handle, database: TEST_DB }));
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...request, object_blockers: [] }));
      writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
      const run = spawnSync(process.execPath, [
        join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), join(process.cwd(), 'scripts/max236-migrate.ts'),
        '--manifest', join(dir, 'manifest.json'), '--plan', join(dir, 'plan.json'), '--apply',
        '--confirm', `${TEST_DB}@${handle.container_id.slice(0, 12)}:instance:9101`, '--expect-digest', plan.digest,
      ], {
        env: {
          ...process.env,
          MAX236_REALA_DSN: `mysql://root@127.0.0.1:${handle.port}/${TEST_DB}`,
          MAX236_REALA_HANDLE: join(dir, 'handle.json'),
        },
        encoding: 'utf8',
      });
      expect({ exit: run.status, revision: await bindingRevision('instance:9101') }).toEqual({ exit: 0, revision: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
