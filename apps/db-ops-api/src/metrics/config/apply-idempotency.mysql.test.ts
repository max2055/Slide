import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../auth/actor-context.js';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { dbConnection } from '../../db-connection.js';
import { configurationInventory } from './inventory.js';
import { createConfigurationRegistry } from './registry.js';
import { createTrialStore } from './routes.js';
import { MetricConfigurationService } from './service.js';
import { configurationReader } from './status-store.js';
import { PolicyService, candidateFingerprint, configurationDigest } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { type Ref, refKey } from '../policy/model.js';
import { admin } from '../policy/test-support.js';

/**
 * MAX-238 application-idempotency package. On a disposable schema
 * (METRICS_TEST_MYSQL_PORT) this uses the existing PolicyService.changeBinding,
 * PolicyService.operation and MysqlPolicyStore persistence only. A client
 * operation key binds the authorized resource, target revision and canonical
 * configuration digest: the same intent replays its recorded publication with no
 * second revision, publication or audit row; a different resource, revision or
 * configuration is rejected; concurrent duplicates and a fresh store (restart)
 * both replay; a revoked actor is refused before any stored result is returned.
 * No target connection is opened, no trial runs, no worker starts.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const database = `max238_apply_idempotency_${process.pid}`;
const ref1: Ref = { type: 'instance', id: 1 };
const ref2: Ref = { type: 'instance', id: 2 };
const evidencePath = fileURLToPath(new URL('../../../../../docs/slide/development/MAX-238/apply-idempotency-20261028.json', import.meta.url));
type Status = Awaited<ReturnType<MetricConfigurationService['status']>>;
type Pin = { id: string; version: string; digest: string };

/** The keys this package reads from one actual status response. */
const observed = (status: Status) => ({
  'binding.published_revision': status.binding.published_revision,
  'binding.package': status.binding.package,
  'binding.application': status.binding.application,
  'effective_enabled.policy_enabled': status.effective_enabled.policy_enabled,
});

describe.skipIf(!port)('MAX-238 operation keys bind one intent and replay without a second publication', () => {
  let root: Pool, pool: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let policies: PolicyService;
  let service: MetricConfigurationService;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  let pin: Pin;
  const evidence: Record<string, unknown> = {};
  const rows = async (sql: string, values: unknown[] = []) =>
    (await pool.query<RowDataPacket[]>(sql, values as never))[0];
  const count = async (sql: string, values: unknown[] = []) => Number((await rows(sql, values))[0]!.n);
  const audits = (ref: Ref) => count('SELECT COUNT(*) AS n FROM metric_policy_audit WHERE target = ?', [refKey(ref)]);
  const operations = () => count('SELECT COUNT(*) AS n FROM metric_policy_apply_operations');
  const bindingPayload = async (ref: Ref) => String((await rows('SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]))[0]?.payload ?? '');
  const operationRow = async (key: string) => (await rows(`SELECT operation_key, resource_key, actor_id, target_revision,
    configuration_digest, committed_at FROM metric_policy_apply_operations WHERE operation_key = ?`, [key]))[0] ?? null;
  /** The actual code a rejected call reports; never assumed to be the expected one. */
  const capture = async (action: () => Promise<unknown>) => {
    try { await action(); }
    catch (error) {
      const caught = error as { name?: string; message?: string; code?: unknown; status?: unknown };
      return { name: caught.name ?? 'Error', code: typeof caught.code === 'string' ? caught.code : null,
        status: typeof caught.status === 'number' ? caught.status : null, message: String(caught.message ?? error) };
    }
    return null;
  };
  const readOnly = (ref: Ref): ActorContext => ({ userId: 2, username: 'reader', roles: [], permissions: ['instance:view'],
    instanceScopes: { [ref.id]: 'read-only' }, sessionVersion: 1, requestId: 'test-read-only' });

  /** Record which step failed so the evidence names the actual stopping point. */
  const step = async (name: string, run: () => Promise<void>) => {
    try { await run(); }
    catch (error) {
      const caught = error as { name?: string; message?: string };
      evidence.error = { at: name, name: caught.name ?? 'Error', message: String(caught.message ?? error) };
      throw error;
    }
  };

  beforeAll(async () => {
    vi.stubEnv('METRICS_COLLECTION_ENABLED', 'true');
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 20, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    for (const [id, name] of [[ref1.id, 'apply-idempotency-1'], [ref2.id, 'apply-idempotency-2']] as const) {
      await pool.execute(`INSERT INTO database_instances
        (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
        VALUES (?,?,?,?,?,3306,'fixture','','fixture','8.0.46','active','available')`,
        [id, name, 'production', 'mysql', '127.0.0.1']);
    }
    packages = createConfigurationRegistry();
    policies = new PolicyService(new MysqlPolicyStore(() => pool), packages,
      { exists: async () => true, inventory: configurationInventory });
    service = new MetricConfigurationService(policies, packages, createTrialStore(() => pool, packages),
      { resolve: async () => { throw new Error('status must not collect'); } }, configurationReader(() => pool));
    const recommendations = await service.recommendations(admin, ref1);
    const release = recommendations.packages.find(entry => entry.compatibility === 'compatible')?.release.package;
    expect(release, 'resource 1 must have a compatible published release').toBeDefined();
    pin = { id: release!.id, version: release!.version, digest: release!.digest };
    // The additive migration must exist in the real chain, not just in a candidate document.
    expect(await count(`SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'metric_policy_apply_operations'`, [database])).toBe(1);
  }, 180000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
    vi.unstubAllEnvs();
  }, 60000);

  it('records the first keyed publication with its resource, target revision and configuration digest', () => step('record the first keyed publication', async () => {
    const input = { expected_revision: 0, package: pin, operation_key: 'apply-intent-1' };
    const preview = await policies.changeBinding(admin, ref1, input, false);
    const testedDigest = configurationDigest(preview.resources[0]);
    const published = await policies.changeBinding(admin, ref1, input, true);
    expect(published.published).toBe(true); expect(published.resources[0].binding.revision).toBe(1);
    expect(configurationDigest(published.resources[0])).toBe(testedDigest);
    expect(await audits(ref1)).toBe(1);
    const stored = await operationRow('apply-intent-1');
    expect(stored).toMatchObject({ resource_key: refKey(ref1), actor_id: admin.userId, target_revision: 1,
      configuration_digest: testedDigest });
    const status = await service.status(admin, ref1);
    expect(status.binding.published_revision).toBe(1); expect(status.binding.application).toBe('pending');
    evidence.first_publish = { pin, tested_digest: testedDigest, stored_operation: stored, audits: await audits(ref1),
      status: observed(status) };
  }));

  it('replays the same intent without a second revision, publication or audit row', () => step('replay the same intent', async () => {
    const input = { expected_revision: 0, package: pin, operation_key: 'apply-intent-1' };
    const before = { payload: await bindingPayload(ref1), publishedAt: await count('SELECT COUNT(*) AS n FROM metric_policy_audit WHERE target = ?', [refKey(ref1)]) };
    const replay = await policies.changeBinding(admin, ref1, input, true);
    const first = await operationRow('apply-intent-1');
    expect(replay.published).toBe(true); expect(replay.resources[0].binding.revision).toBe(1);
    expect(replay.resources[0].published_at).toBe(first!.committed_at);
    expect(await bindingPayload(ref1)).toBe(before.payload);
    expect(await audits(ref1)).toBe(before.publishedAt);
    expect(await operations()).toBe(1);
    evidence.replay = { replay_revision: replay.resources[0].binding.revision, replay_published_at: replay.resources[0].published_at,
      binding_unchanged: true, audits: await audits(ref1), operation_rows: await operations() };
  }));

  it('rejects the same key for another resource, target revision or configuration', () => step('reject key reuse for another intent', async () => {
    const before = { payload: await bindingPayload(ref1), audits: await audits(ref1), operations: await operations() };
    const otherResource = await capture(() => policies.changeBinding(admin, ref2,
      { expected_revision: 0, package: pin, operation_key: 'apply-intent-1' }, true));
    const otherRevision = await capture(() => policies.changeBinding(admin, ref1,
      { expected_revision: 1, package: pin, operation_key: 'apply-intent-1' }, true));
    const otherConfiguration = await capture(() => policies.changeBinding(admin, ref1,
      { expected_revision: 0, package: pin, overrides: { enabled: 'disable' }, operation_key: 'apply-intent-1' }, true));
    for (const rejected of [otherResource, otherRevision, otherConfiguration]) {
      expect(rejected, 'a collision must be rejected').not.toBeNull();
      expect(rejected!.code).toBe('POLICY_OPERATION_CONFLICT');
    }
    expect(await bindingPayload(ref1)).toBe(before.payload);
    expect(await audits(ref1)).toBe(before.audits);
    expect(await operations()).toBe(before.operations);
    expect(await rows('SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref2)])).toHaveLength(0);
    evidence.collisions = { other_resource: otherResource, other_revision: otherRevision, other_configuration: otherConfiguration,
      binding_unchanged: true, audits: await audits(ref1), operation_rows: await operations() };
  }));

  it('publishes once for concurrent duplicates of one key', () => step('publish once for concurrent duplicates', async () => {
    const input = { expected_revision: 0, package: pin, operation_key: 'apply-intent-2' };
    const results = await Promise.all([policies.changeBinding(admin, ref2, input, true),
      new PolicyService(new MysqlPolicyStore(() => pool), packages,
        { exists: async () => true, inventory: configurationInventory }).changeBinding(admin, ref2, input, true)]);
    expect(results.map(result => result.resources[0].binding.revision)).toEqual([1, 1]);
    expect(results[0].resources[0].published_at).toBe(results[1].resources[0].published_at);
    expect(await audits(ref2)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM metric_policy_apply_operations WHERE operation_key = ?`, ['apply-intent-2'])).toBe(1);
    evidence.concurrent_duplicates = { revisions: results.map(result => result.resources[0].binding.revision),
      same_published_at: true, audits: await audits(ref2) };
  }));

  it('replays after a restart from persisted state and exposes an authoritative lookup', () => step('replay after a restart and look up the operation', async () => {
    const restarted = new PolicyService(new MysqlPolicyStore(() => pool), packages,
      { exists: async () => true, inventory: configurationInventory });
    const restartedService = new MetricConfigurationService(restarted, packages, createTrialStore(() => pool, packages),
      { resolve: async () => { throw new Error('status must not collect'); } }, configurationReader(() => pool));
    const before = { payload: await bindingPayload(ref1), audits: await audits(ref1) };
    const replay = await restarted.changeBinding(admin, ref1, { expected_revision: 0, package: pin, operation_key: 'apply-intent-1' }, true);
    expect(replay.resources[0].binding.revision).toBe(1);
    expect(await bindingPayload(ref1)).toBe(before.payload);
    expect(await audits(ref1)).toBe(before.audits);
    const committed = await restartedService.operation(admin, ref1, 'apply-intent-1');
    const absent = await restartedService.operation(admin, ref1, 'never-sent');
    expect(committed).toMatchObject({ state: 'committed', operation: { target_revision: 1 } });
    expect(absent).toEqual({ state: 'absent', operation: null });
    evidence.restart = { replay_revision: replay.resources[0].binding.revision, lookup: committed, absent_lookup: absent,
      audits: await audits(ref1) };
  }));

  it('revalidates live permission before returning a stored result', () => step('revalidate live permission before replay', async () => {
    const before = { payload: await bindingPayload(ref1), audits: await audits(ref1) };
    const replay = await capture(() => policies.changeBinding(readOnly(ref1), ref1,
      { expected_revision: 0, package: pin, operation_key: 'apply-intent-1' }, true));
    const replayActivation = await capture(() => policies.replay(readOnly(ref1), ref1,
      { expected_revision: 0, package: pin, operation_key: 'apply-intent-1' }));
    expect(replay!.code).toBe('POLICY_FORBIDDEN'); expect(replayActivation!.code).toBe('POLICY_FORBIDDEN');
    expect(await bindingPayload(ref1)).toBe(before.payload); expect(await audits(ref1)).toBe(before.audits);
    // Read-only scope may read the lookup; no scope at all may not.
    expect(await policies.operation(readOnly(ref1), ref1, 'apply-intent-1')).toMatchObject({ state: 'committed' });
    const unscoped = await capture(() => policies.operation({ ...readOnly(ref1), instanceScopes: {} }, ref1, 'apply-intent-1'));
    expect(unscoped!.code).toBe('POLICY_FORBIDDEN');
    evidence.revoked = { replay, replay_activation: replayActivation, unscoped_lookup: unscoped, audits: await audits(ref1) };
  }));

  it('writes no journal row when a keyed publication is rejected', () => step('write no journal row for a rejected keyed publication', async () => {
    const before = { payload: await bindingPayload(ref1), audits: await audits(ref1), operations: await operations() };
    const stale = await capture(() => policies.changeBinding(admin, ref1,
      { expected_revision: 0, package: pin, operation_key: 'apply-intent-rejected' }, true));
    expect(stale!.code).toBe('POLICY_REVISION_CONFLICT');
    expect(await bindingPayload(ref1)).toBe(before.payload);
    expect(await audits(ref1)).toBe(before.audits);
    expect(await operations()).toBe(before.operations);
    expect(await policies.operation(admin, ref1, 'apply-intent-rejected')).toEqual({ state: 'absent', operation: null });
    evidence.rejected_intent = { error: stale, audits: await audits(ref1), operation_rows: await operations(),
      lookup: 'absent' };
  }));

  it('keeps legacy callers without an operation key working', () => step('keep legacy callers without a key working', async () => {
    const operationsBefore = await operations();
    const auditsBefore = await audits(ref2);
    const published = await policies.changeBinding(admin, ref2, { expected_revision: 1, package: pin, overrides: { enabled: 'disable' } }, true);
    expect(published.resources[0].binding.revision).toBe(2);
    expect(await audits(ref2)).toBe(auditsBefore + 1);
    expect(await operations()).toBe(operationsBefore);
    const stale = await capture(() => policies.changeBinding(admin, ref2, { expected_revision: 1, package: pin }, true));
    expect(stale!.code).toBe('POLICY_REVISION_CONFLICT');
    const status = await service.status(admin, ref2);
    expect(status.binding.published_revision).toBe(2); expect(status.effective_enabled.policy_enabled).toBe(false);
    evidence.legacy = { revision: published.resources[0].binding.revision, audits: await audits(ref2),
      operation_rows: await operations(), stale_error: stale, status: observed(status) };
  }));
  afterAll(() => {
    writeFileSync(evidencePath, `${JSON.stringify({ ...evidence, run: {
      branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      test: 'apply-idempotency.mysql.test.ts',
      disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll`,
      boundaries: { activate_called: false, trial_called: false, worker_started: false, target_connection_opened: false },
    } }, null, 2)}\n`);
  });
});
