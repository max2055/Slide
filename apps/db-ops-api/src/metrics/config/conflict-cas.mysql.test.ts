import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { dbConnection } from '../../db-connection.js';
import type { ActorContext } from '../../auth/actor-context.js';
import { configurationInventory } from './inventory.js';
import { createConfigurationRegistry } from './registry.js';
import { MetricConfigurationService, type ActivationGuard, type TrialStore } from './service.js';
import { configurationReader } from './status-store.js';
import type { CollectorAccess } from '../scheduler/service.js';
import { PolicyService, candidateFingerprint } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';

/**
 * MAX-238 conflict/CAS package. On a disposable schema (METRICS_TEST_MYSQL_PORT) this exercises the
 * existing PolicyService.changeBinding and the existing MetricConfigurationService trial
 * revalidation against one real resource row (instance 1, db_type=mysql, db_version=8.0.46),
 * proving the acceptance sentence "conflict, concurrent revision update, stale test and permission
 * change are all refused by the backend, and a failure keeps the prior effective version".
 *
 * Two independent pools give the concurrent publish and the "another connection advances the
 * revision" step their own connection and their own admission queue. The credential columns are
 * empty and the trial runs with collection disabled, so the fake collector access is never asked
 * for a transport: no host is contacted and 3306 is never used. Product code is unchanged; a
 * clause the product cannot satisfy fails here and is written into the evidence.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const database = `max238_conflict_cas_${process.pid}`;
const instanceRef = { type: 'instance' as const, id: 1 };
const incompatibleCodes = ['PACKAGE_INCOMPATIBLE', 'POLICY_PACKAGE_RESOURCE'];
const evidencePath = fileURLToPath(new URL('../../../../../docs/slide/development/MAX-238/conflict-cas-20261028.json', import.meta.url));

/** Capture the existing rejection contract instead of assuming one error type. */
const rejection = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return null;
  } catch (error) {
    const caught = error as { code?: string; message?: string; status?: number };
    return { code: caught.code ?? null, message: caught.message ?? String(error), status: caught.status ?? null };
  }
};
/** Promise.settled rejection flattened to the same shape as `rejection`. */
const settledError = (result: PromiseSettledResult<unknown>) => {
  if (result.status === 'fulfilled') return null;
  const caught = result.reason as { code?: string; message?: string; status?: number };
  return { code: caught.code ?? null, message: caught.message ?? String(caught), status: caught.status ?? null };
};

describe.skipIf(!port)('MAX-238 conflict, concurrent revision, stale test and permission change are refused', () => {
  let root: Pool, pool: Pool, pool2: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let policies: PolicyService;
  let policies2: PolicyService;
  let service: MetricConfigurationService;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const query = async (target: Pool, sql: string, values: unknown[] = []) =>
    (await target.query<RowDataPacket[]>(sql, values as never))[0];
  const rows = (sql: string, values: unknown[] = []) => query(pool, sql, values);
  const one = async (sql: string, values: unknown[] = []) => (await rows(sql, values))[0];
  const bindingRows = async (key: string) =>
    Number((await one('SELECT COUNT(*) AS n FROM metric_policy_bindings WHERE resource_key = ?', [key]))!.n);
  const storedRevision = async (key: string) =>
    Number((await one("SELECT JSON_EXTRACT(payload, '$.binding.revision') AS revision FROM metric_policy_bindings WHERE resource_key = ?", [key]))!.revision);
  const auditCount = async (key: string) =>
    Number((await one('SELECT COUNT(*) AS n FROM metric_policy_audit WHERE target = ?', [key]))!.n);
  /** Migration 121 renames the metric v2 alert tables; count whichever name exists. */
  const alertTableNames = [
    { requested: 'metric_v2_alert_state', renamed: 'metric_alert_state' },
    { requested: 'metric_v2_alert_transitions', renamed: 'metric_alert_transitions' },
  ] as const;
  const formalTables = ['alerts', 'alert_events', 'notification_records', 'metric_publications'] as const;
  const tableExists = async (name: string) =>
    (await rows('SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name])).length > 0;
  /** Formal history and alert rows a trial is not allowed to create. */
  const formalRows = async () => {
    const counts: Record<string, number> = {
      normalized_observations: Number((await one("SELECT COUNT(*) AS n FROM metric_observations WHERE stage = 'normalized'"))!.n),
    };
    for (const table of formalTables) counts[table] = Number((await one(`SELECT COUNT(*) AS n FROM ${table}`))!.n);
    for (const { requested, renamed } of alertTableNames) {
      counts[requested] = await tableExists(renamed) ? Number((await one(`SELECT COUNT(*) AS n FROM ${renamed}`))!.n) : 0;
    }
    return counts;
  };
  const pinOf = (id: string, version: string) => {
    const release = packages.list().find(candidate => candidate.package.id === id && candidate.package.version === version);
    expect(release, `${id}@${version} must be installed`).toBeTruthy();
    return { id, version, digest: release!.package.digest };
  };

  beforeAll(async () => {
    const config = { host: '127.0.0.1', port, user: 'root', password: '' };
    root = mysql.createPool(config);
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...config, database, connectionLimit: 20, timezone: 'Z' });
    pool2 = mysql.createPool({ ...config, database, connectionLimit: 20, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);

    // One authorized resource row with empty credentials: no collection path is ever called.
    await pool.execute(`INSERT INTO database_instances
      (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
      VALUES (1,'mysql3306','production','mysql','127.0.0.1',3306,'fixture','','mysql','8.0.46','active','available')`);

    packages = createConfigurationRegistry();
    const resources = { exists: async () => true, inventory: configurationInventory };
    policies = new PolicyService(new MysqlPolicyStore(() => pool), packages, resources);
    policies2 = new PolicyService(new MysqlPolicyStore(() => pool2), packages, resources);
    const trialStore: TrialStore = {
      reserve: async () => ({ release: async () => undefined, connection: { ping: async () => true } }),
      attempts: async () => [],
    };
    // Collection-disabled trials never resolve a transport; this seam refuses loudly if they do.
    const trialAccess: CollectorAccess = {
      resolve: async ref => ({
        resource: { type: ref.type, id: String(ref.id), attributes: {} },
        credential_ref: 'credential:conflict-cas-fixture',
        evidence: {},
        resolve: async () => { throw new Error('conflict cas must not collect'); },
      }),
    };
    service = new MetricConfigurationService(policies, packages, trialStore, trialAccess, configurationReader(() => pool));
  }, 180000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    await pool2?.end();
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
  }, 60000);

  it('proves the four conflict clauses on the disposable schema', async () => {
    const evidence: Record<string, unknown> = {};
    const key = 'instance:1';

    // Baseline "prior effective version": one compatible pin, published through the existing service.
    const basePin = pinOf('mysql-basic', '1.1.0');
    const published = await policies.changeBinding(admin, instanceRef, { expected_revision: 0, package: basePin }, true);
    expect(published.published).toBe(true);
    const base = await policies.binding(admin, instanceRef);
    const baseRevision = base.binding.revision;
    expect(base.binding.package).toEqual(basePin);
    expect(await storedRevision(key)).toBe(baseRevision);
    expect(await bindingRows(key)).toBe(1);
    evidence.baseline = { revision: baseRevision, package: base.binding.package, binding_rows: 1 };

    // 1. Conflict: a server pin on the instance is refused and the prior pin/revision stay put.
    const conflictPin = pinOf('linux-host', '1.1.0');
    const conflict = await rejection(() => policies.changeBinding(admin, instanceRef,
      { expected_revision: baseRevision, package: conflictPin }, true));
    expect(conflict).not.toBeNull();
    expect(incompatibleCodes).toContain(conflict!.code);
    const afterConflict = await policies.binding(admin, instanceRef);
    expect(afterConflict.binding.revision).toBe(baseRevision);
    expect(afterConflict.binding.package).toEqual(basePin);
    expect(await storedRevision(key)).toBe(baseRevision);
    expect(await bindingRows(key)).toBe(1);
    evidence.conflict = { submitted: conflictPin, error: conflict, revision_before: baseRevision,
      revision_after: afterConflict.binding.revision, remaining_package: afterConflict.binding.package };

    // 2. Concurrent revision: two independent connections publish different compatible pins with
    // the same expected_revision; exactly one wins, the other is a 409 and leaves no half-write.
    const raceBase = afterConflict.binding.revision;
    const pinA = pinOf('mysql-diagnostics', '1.1.0');
    const pinB = pinOf('mysql-diagnostics', '1.0.0');
    const auditsBeforeRace = await auditCount(key);
    const [resultA, resultB] = await Promise.allSettled([
      policies.changeBinding(admin, instanceRef, { expected_revision: raceBase, package: pinA }, true),
      policies2.changeBinding(admin, instanceRef, { expected_revision: raceBase, package: pinB }, true),
    ]);
    const settled = [resultA, resultB];
    const winners = settled.map((result, index) => ({ index, result })).filter(entry => entry.result.status === 'fulfilled');
    const losers = settled.map((result, index) => ({ index, result })).filter(entry => entry.result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loserError = settledError(losers[0].result);
    expect(loserError).toMatchObject({ code: 'POLICY_REVISION_CONFLICT', status: 409 });
    const winnerPin = winners[0].index === 0 ? pinA : pinB;
    const loserPin = winners[0].index === 0 ? pinB : pinA;
    const afterRace = await policies.binding(admin, instanceRef);
    expect(afterRace.binding.revision).toBe(raceBase + 1);
    expect(afterRace.binding.package).toEqual(winnerPin);
    expect(await storedRevision(key)).toBe(raceBase + 1);
    expect(await bindingRows(key)).toBe(1);
    expect(await auditCount(key)).toBe(auditsBeforeRace + 1);
    evidence.concurrent_revision = { expected_revision: raceBase, submitted: [pinA, pinB],
      winner: { connection: winners[0].index === 0 ? 'pool' : 'pool2', package: winnerPin },
      loser: { connection: losers[0].index === 0 ? 'pool' : 'pool2', package: loserPin, error: loserError },
      revision_before: raceBase, revision_after: afterRace.binding.revision,
      remaining_package: afterRace.binding.package, binding_rows: 1, audit_delta: 1 };

    // 3. Stale test: a trial is previewed at the current revision, another connection advances the
    // revision inside the revalidation window, and the publish built from the stale expectation is
    // refused. The trial itself is persisted=false and writes no formal history or alerts.
    const beforeTrial = await policies.binding(admin, instanceRef);
    const trialRevision = beforeTrial.binding.revision;
    const trialPin = beforeTrial.binding.package;
    const preview = await policies.changeBinding(admin, instanceRef, { expected_revision: trialRevision, overrides: { enabled: 'disable' } }, false);
    const staleCandidate = candidateFingerprint(preview.resources[0]);
    const formalBefore = await formalRows();
    const auditsBeforeTrial = await auditCount(key);
    let advancedRevision: number | null = null;
    let guardChecks = 0;
    let trialOutcome: Awaited<ReturnType<MetricConfigurationService['trial']>> | null = null;
    const originalTrial = service.trial.bind(service);
    const trialSpy = vi.spyOn(service, 'trial').mockImplementation(async (...args) => {
      const outcome = await originalTrial(...args);
      trialOutcome = outcome;
      return outcome;
    });
    // The trial finishes (persisted=false) before the pre-publish currentActor revalidation; the
    // other connection advances the revision exactly there, so only the publish can be refused.
    const guard: ActivationGuard = {
      async check() {
        guardChecks += 1;
        if (guardChecks === 6 && advancedRevision === null) {
          const advanced = await policies2.changeBinding(admin, instanceRef,
            { expected_revision: trialRevision, overrides: { interval_ms: { mode: 'set', value: 45000 } } }, true);
          advancedRevision = advanced.resources[0].binding.revision;
        }
        return admin;
      },
    };
    const staleActivate = await rejection(() => service.activate(admin, instanceRef,
      { expected_revision: trialRevision, overrides: { enabled: 'disable' } }, guard));
    expect(staleActivate).toMatchObject({ code: 'POLICY_REVISION_CONFLICT', status: 409 });
    expect(advancedRevision).toBe(trialRevision + 1);
    expect(trialSpy).toHaveBeenCalledTimes(1);
    expect(trialOutcome).not.toBeNull();
    expect(trialOutcome!.persisted).toBe(false);
    expect(trialOutcome!.decision).toBe('disabled');
    expect(trialOutcome!.attempts).toEqual([]);
    expect(trialOutcome!.samples).toEqual([]);
    trialSpy.mockRestore();
    const formalAfter = await formalRows();
    expect(formalAfter).toEqual(formalBefore);
    const afterTrial = await policies.binding(admin, instanceRef);
    expect(afterTrial.binding.revision).toBe(advancedRevision);
    expect(afterTrial.binding.package).toEqual(trialPin);
    expect(afterTrial.binding.overrides).toEqual({ interval_ms: { mode: 'set', value: 45000 } });
    expect(await storedRevision(key)).toBe(advancedRevision);
    expect(await auditCount(key)).toBe(auditsBeforeTrial + 1);
    // The stale candidate fingerprint is equally refused even when the revision CAS matches.
    const staleCandidatePublish = await rejection(() => policies.changeBinding(admin, instanceRef,
      { expected_revision: afterTrial.binding.revision, overrides: { enabled: 'disable' } }, true, staleCandidate));
    expect(staleCandidatePublish).toMatchObject({ code: 'POLICY_REVISION_CONFLICT', status: 409 });
    const afterStaleCandidate = await policies.binding(admin, instanceRef);
    expect(afterStaleCandidate.binding.revision).toBe(advancedRevision);
    expect(afterStaleCandidate.binding.package).toEqual(trialPin);
    expect(afterStaleCandidate.binding.overrides).toEqual({ interval_ms: { mode: 'set', value: 45000 } });
    expect(await auditCount(key)).toBe(auditsBeforeTrial + 1);
    evidence.stale_trial = { expected_revision: trialRevision, trial: { persisted: trialOutcome!.persisted,
      decision: trialOutcome!.decision, attempts: trialOutcome!.attempts.length, samples: trialOutcome!.samples.length },
      guard_checks: guardChecks, advanced_revision: advancedRevision,
      publish: staleActivate, stale_candidate_publish: staleCandidatePublish,
      revision_before: trialRevision, revision_after: afterStaleCandidate.binding.revision,
      remaining_package: afterStaleCandidate.binding.package, remaining_overrides: afterStaleCandidate.binding.overrides,
      formal_rows_before: formalBefore, formal_rows_after: formalAfter, audit_delta: 1 };

    // 4. Permission change: a direct publish without manage rights is 403, and a trial whose
    // second currentActor revalidation loses manage rights refuses the activation.
    const beforePermission = await policies.binding(admin, instanceRef);
    const permissionRevision = beforePermission.binding.revision;
    const readonly: ActorContext = { userId: 2, username: 'readonly', roles: [], permissions: ['instance:view'],
      instanceScopes: { 1: 'read-only' }, sessionVersion: 1, requestId: 'test-conflict-cas-readonly' };
    const auditsBeforePermission = await auditCount(key);
    const forbiddenPublish = await rejection(() => policies.changeBinding(readonly, instanceRef,
      { expected_revision: permissionRevision, overrides: { enabled: 'enable' } }, true));
    expect(forbiddenPublish).toMatchObject({ code: 'POLICY_FORBIDDEN', status: 403 });
    let activationChecks = 0;
    const readonlyGuard: ActivationGuard = {
      async check() { activationChecks += 1; return activationChecks === 1 ? admin : readonly; },
    };
    const forbiddenActivate = await rejection(() => service.activate(admin, instanceRef,
      { expected_revision: permissionRevision, overrides: { enabled: 'disable' } }, readonlyGuard));
    expect(forbiddenActivate).toMatchObject({ code: 'POLICY_FORBIDDEN', status: 403 });
    const afterPermission = await policies.binding(admin, instanceRef);
    expect(afterPermission.binding.revision).toBe(permissionRevision);
    expect(afterPermission.binding.package).toEqual(beforePermission.binding.package);
    expect(await storedRevision(key)).toBe(permissionRevision);
    expect(await bindingRows(key)).toBe(1);
    expect(await auditCount(key)).toBe(auditsBeforePermission);
    expect(await formalRows()).toEqual(formalBefore);
    evidence.permission_change = { publish: forbiddenPublish, activate: forbiddenActivate,
      activation_checks: activationChecks, revision_before: permissionRevision,
      revision_after: afterPermission.binding.revision, remaining_package: afterPermission.binding.package,
      audit_delta: 0 };

    evidence.product_code = { service_ts_changed: false, policy_service_ts_changed: false,
      store_ts_changed: false, activate_predicate_changed: false, required_metrics_list_changed: false };
    evidence.run = {
      branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      test: 'conflict-cas.mysql.test.ts',
      disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll`,
      ports_contacted: ['127.0.0.1:' + port],
      application_database_3306: 'not contacted',
    };
    evidence.targets = { instance: { id: 1, db_type: 'mysql', db_version: '8.0.46', credential: 'empty' } };
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  }, 180000);
});
