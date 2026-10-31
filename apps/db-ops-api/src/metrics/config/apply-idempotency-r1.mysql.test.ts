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
import { PolicyService, intentFingerprint } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { refKey, type Ref } from '../policy/model.js';
import { admin } from '../policy/test-support.js';

/**
 * MAX238-APPLY-IDEMPOTENCY-R1 persistence evidence. On a disposable schema
 * (METRICS_TEST_MYSQL_PORT, never 3306) this exercises only the real
 * MysqlPolicyStore and the additive migration chain: a keyed intent is reserved
 * before its trial and survives a new process as pending, its commit lands in the
 * same transaction as the binding/revision/audit, a replay recovers the recorded
 * publication after a later intent moved the binding, and a failed transaction
 * leaves no publication, audit or journal row. No target connection is opened,
 * no trial runs against a real target, no worker starts.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const database = `max238_apply_idempotency_r1_${process.pid}`;
const refs: Ref[] = [1, 2, 3, 4, 5, 6].map(id => ({ type: 'instance' as const, id }));
const [reserveRef, replayRef, collisionRef, concurrentRef, rollbackRef, revokedRef] = refs;
const evidencePath = fileURLToPath(new URL('../../../../../docs/slide/development/MAX-238/apply-idempotency-r1-20261028.json', import.meta.url));
type Pin = { id: string; version: string; digest: string };

describe.skipIf(!port)('MAX-238 R1 keyed intent lifecycle on a disposable MySQL schema', () => {
  let root: Pool, pool: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let pin: Pin;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const evidence: Record<string, unknown> = {};
  const rows = async (sql: string, values: unknown[] = []) =>
    (await pool.query<RowDataPacket[]>(sql, values as never))[0];
  const count = async (sql: string, values: unknown[] = []) => Number((await rows(sql, values))[0]!.n);
  const audits = (ref: Ref) => count('SELECT COUNT(*) AS n FROM metric_policy_audit WHERE target = ?', [refKey(ref)]);
  const journal = async (key: string) => (await rows(`SELECT operation_key, resource_key, actor_id, target_revision,
    intent_digest, configuration_digest, state, claimed_at, committed_at FROM metric_policy_apply_operations
    WHERE operation_key = ?`, [key]))[0] ?? null;
  const bindingRevision = async (ref: Ref) => {
    const payload = (await rows('SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]))[0]?.payload;
    if (payload === undefined) return null;
    const value = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return Number((value as { binding: { revision: number } }).binding.revision);
  };
  const capture = async (action: () => Promise<unknown>) => {
    try { await action(); }
    catch (error) {
      const caught = error as { name?: string; message?: string; code?: unknown; status?: unknown };
      return { name: caught.name ?? 'Error', code: typeof caught.code === 'string' ? caught.code : null,
        status: typeof caught.status === 'number' ? caught.status : null, message: String(caught.message ?? error) };
    }
    return null;
  };
  const policyFor = () => new PolicyService(new MysqlPolicyStore(() => pool), packages,
    { exists: async () => true, inventory: configurationInventory });
  const readOnly = (ref: Ref): ActorContext => ({ userId: 2, username: 'reader', roles: [], permissions: ['instance:view'],
    instanceScopes: { [ref.id]: 'read-only' }, sessionVersion: 1, requestId: 'test-read-only' });
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
    for (const ref of refs) {
      await pool.execute(`INSERT INTO database_instances
        (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
        VALUES (?,?,?,?,?,3306,'fixture','','fixture','8.0.46','active','available')`,
        [ref.id, `idempotency-r1-${ref.id}`, 'production', 'mysql', '127.0.0.1']);
    }
    packages = createConfigurationRegistry();
    const recommendations = await new MetricConfigurationService(policyFor(), packages,
      createTrialStore(() => pool, packages), { resolve: async () => { throw new Error('status must not collect'); } },
      configurationReader(() => pool)).recommendations(admin, reserveRef);
    const release = recommendations.packages.find(entry => entry.compatibility === 'compatible')?.release.package;
    expect(release, 'the reserve resource must have a compatible published release').toBeDefined();
    pin = { id: release!.id, version: release!.version, digest: release!.digest };
    // Both additive migrations must be in the real chain, not a candidate document.
    expect(await count(`SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ?
      AND table_name = 'metric_policy_apply_operations' AND column_name IN ('intent_digest','state','claimed_at')`, [database])).toBe(3);
  }, 180000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
    vi.unstubAllEnvs();
    writeFileSync(evidencePath, `${JSON.stringify({ ...evidence, run: {
      branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      test: 'apply-idempotency-r1.mysql.test.ts',
      disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll`,
      boundaries: { activate_called: false, trial_called: false, worker_started: false, target_connection_opened: false },
    } }, null, 2)}\n`);
  }, 60000);

  it('reserves the intent before its trial and keeps it pending across a restart', () => step('reserve and restart', async () => {
    const input = { expected_revision: 0, package: pin, overrides: { enabled: 'disable' as const }, operation_key: 'r1-reserve' };
    expect(await policyFor().beginOperation(admin, reserveRef, input)).toEqual({ claimed: true });
    const reserved = await journal('r1-reserve');
    expect(reserved).toMatchObject({ resource_key: refKey(reserveRef), target_revision: 1, state: 'pending',
      configuration_digest: null, committed_at: null, intent_digest: intentFingerprint(input) });
    expect(await bindingRevision(reserveRef)).toBeNull();
    // A new process (new store instance over the same schema) cannot mistake the
    // unknown remote outcome for an absent, safely retryable key.
    const restarted = policyFor();
    expect(await restarted.operation(admin, reserveRef, 'r1-reserve')).toMatchObject({ state: 'pending',
      operation: { target_revision: 1, configuration_digest: null, committed_at: null } });
    expect((await capture(() => restarted.beginOperation(admin, reserveRef, input)))?.code).toBe('POLICY_OPERATION_PENDING');
    expect((await capture(() => restarted.changeBinding(admin, reserveRef, input, true)))?.code).toBe('POLICY_OPERATION_PENDING');
    expect(await bindingRevision(reserveRef)).toBeNull(); expect(await audits(reserveRef)).toBe(0);
    evidence.reserve_restart = { reserved, lookup: await restarted.operation(admin, reserveRef, 'r1-reserve'),
      binding_revision: await bindingRevision(reserveRef), audits: await audits(reserveRef) };
  }));

  it('commits the journal with the binding and audit, and replays it after a later intent moved the binding', () => step('commit and replay', async () => {
    const original = { expected_revision: 0, package: pin, overrides: { enabled: 'disable' as const }, operation_key: 'r1-reserve' };
    const published = await policyFor().changeBinding(admin, reserveRef, original, true, undefined, true);
    expect(published.resources[0].binding.revision).toBe(1);
    expect(await bindingRevision(reserveRef)).toBe(1);
    expect(await audits(reserveRef)).toBe(1);
    expect(await journal('r1-reserve')).toMatchObject({ state: 'committed', target_revision: 1, committed_at: expect.any(String) });
    expect(String((await journal('r1-reserve'))!.configuration_digest)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect((await journal('r1-reserve'))!.claimed_at).not.toBe('');
    expect(await count(`SELECT COUNT(*) AS n FROM metric_policy_apply_operations WHERE operation_key = 'r1-reserve'`)).toBe(1);
    expect((await policyFor().operation(admin, reserveRef, 'r1-reserve')).state).toBe('committed');
    // A later intent moves the binding; the original request must still recover
    // its own recorded publication, never be re-resolved against revision 2.
    await policyFor().changeBinding(admin, reserveRef, { expected_revision: 1, package: pin,
      overrides: { enabled: 'enable' as const }, operation_key: 'r1-later' }, true);
    expect(await bindingRevision(reserveRef)).toBe(2);
    const replay = await policyFor().changeBinding(admin, reserveRef, original, true);
    expect(replay.resources[0].binding.revision).toBe(1);
    expect(replay.resources[0].published_at).toBe(published.resources[0].published_at);
    expect(await bindingRevision(reserveRef)).toBe(2);
    expect(await audits(reserveRef)).toBe(2);
    evidence.commit_replay = { published_revision: 1, journal: await journal('r1-reserve'),
      later_revision: await bindingRevision(reserveRef), replayed_revision: replay.resources[0].binding.revision,
      replayed_published_at: replay.resources[0].published_at, audits: await audits(reserveRef) };
  }));

  it('rejects a different payload under a committed key without touching the publication', () => step('reject a different payload', async () => {
    const before = { revision: await bindingRevision(reserveRef), audits: await audits(reserveRef),
      journal: await journal('r1-reserve') };
    const different = await capture(() => policyFor().changeBinding(admin, reserveRef,
      { expected_revision: 0, package: pin, operation_key: 'r1-reserve' }, true));
    expect(different?.code).toBe('POLICY_OPERATION_CONFLICT');
    expect(await bindingRevision(reserveRef)).toBe(before.revision);
    expect(await audits(reserveRef)).toBe(before.audits);
    expect(await journal('r1-reserve')).toEqual(before.journal);
    evidence.payload_collision = { error: different, audits: await audits(reserveRef) };
  }));

  it('lets exactly one of two concurrent same-key claims proceed', async () => step('concurrent claims', async () => {
    const input = { expected_revision: 0, package: pin, overrides: { enabled: 'disable' as const }, operation_key: 'r1-concurrent' };
    const outcomes = await Promise.allSettled([policyFor().beginOperation(admin, concurrentRef, input),
      policyFor().beginOperation(admin, concurrentRef, input)]);
    const fulfilled = outcomes.filter(o => o.status === 'fulfilled');
    const rejected = outcomes.filter(o => o.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1); expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as { code?: string }).code).toBe('POLICY_OPERATION_PENDING');
    expect(await count(`SELECT COUNT(*) AS n FROM metric_policy_apply_operations WHERE operation_key = 'r1-concurrent'`)).toBe(1);
    // The one winner can still commit its own claim.
    const published = await policyFor().changeBinding(admin, concurrentRef, input, true, undefined, true);
    expect(published.resources[0].binding.revision).toBe(1);
    evidence.concurrent_claims = { fulfilled: fulfilled.length, rejected: rejected.length,
      rejected_code: (rejected[0]!.reason as { code?: string }).code,
      journal_rows: await count(`SELECT COUNT(*) AS n FROM metric_policy_apply_operations WHERE operation_key = 'r1-concurrent'`) };
  }));

  it('leaves no publication, audit or journal row when the journal write fails inside the transaction', () => step('rollback a failed publication', async () => {
    const input = { expected_revision: 0, package: pin, overrides: { enabled: 'disable' as const }, operation_key: 'r1-rollback' };
    await pool.query(`CREATE TRIGGER r1_block_journal BEFORE INSERT ON metric_policy_apply_operations
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'blocked journal write'`);
    const failed = await capture(() => policyFor().changeBinding(admin, rollbackRef, input, true));
    expect(failed).not.toBeNull();
    expect(await bindingRevision(rollbackRef)).toBeNull();
    expect(await audits(rollbackRef)).toBe(0);
    expect(await journal('r1-rollback')).toBeNull();
    await pool.query('DROP TRIGGER r1_block_journal');
    // The same key was never recorded, so it remains a fresh intent.
    expect((await policyFor().operation(admin, rollbackRef, 'r1-rollback')).state).toBe('absent');
    const published = await policyFor().changeBinding(admin, rollbackRef, input, true);
    expect(published.resources[0].binding.revision).toBe(1);
    expect(await audits(rollbackRef)).toBe(1);
    expect(await journal('r1-rollback')).toMatchObject({ state: 'committed', target_revision: 1 });
    evidence.rollback = { failed_error: failed, binding_after_failure: null, audits_after_failure: 0,
      journal_after_failure: null, published_revision: 1, audits: await audits(rollbackRef) };
  }));

  it('re-verifies live authorization for reserving, replaying and reading an intent', async () => step('live authorization', async () => {
    const committed = await policyFor().changeBinding(admin, revokedRef,
      { expected_revision: 0, package: pin, overrides: { enabled: 'disable' as const }, operation_key: 'r1-owned' }, true);
    expect(committed.resources[0].binding.revision).toBe(1);
    const claim = await capture(() => policyFor().beginOperation(readOnly(revokedRef), revokedRef,
      { expected_revision: 1, package: pin, operation_key: 'r1-forbidden' }));
    const replay = await capture(() => policyFor().changeBinding(readOnly(revokedRef), revokedRef,
      { expected_revision: 0, package: pin, overrides: { enabled: 'disable' }, operation_key: 'r1-owned' }, true));
    expect(claim?.code).toBe('POLICY_FORBIDDEN'); expect(replay?.code).toBe('POLICY_FORBIDDEN');
    expect(await journal('r1-forbidden')).toBeNull();
    expect(await policyFor().operation(readOnly(revokedRef), revokedRef, 'r1-owned')).toMatchObject({ state: 'committed' });
    const unscoped = await capture(() => policyFor().operation({ ...readOnly(revokedRef), instanceScopes: {} }, revokedRef, 'r1-owned'));
    expect(unscoped?.code).toBe('POLICY_FORBIDDEN');
    evidence.authorization = { claim_error: claim, replay_error: replay,
      read_only_lookup: await policyFor().operation(readOnly(revokedRef), revokedRef, 'r1-owned'),
      unscoped_error: unscoped };
  }));

  it('does not replay or disclose another resource key', async () => step('cross-resource isolation', async () => {
    await policyFor().changeBinding(admin, replayRef,
      { expected_revision: 0, package: pin, overrides: { enabled: 'disable' as const }, operation_key: 'r1-resource-owner' }, true);
    expect(await policyFor().operation(admin, collisionRef, 'r1-resource-owner')).toEqual({ state: 'absent', operation: null });
    const other = await capture(() => policyFor().changeBinding(admin, collisionRef,
      { expected_revision: 0, package: pin, overrides: { enabled: 'disable' }, operation_key: 'r1-resource-owner' }, true));
    expect(other?.code).toBe('POLICY_OPERATION_CONFLICT');
    expect(await bindingRevision(collisionRef)).toBeNull();
    evidence.cross_resource = { other_resource_error: other, collision_binding: await bindingRevision(collisionRef) };
  }));
});
