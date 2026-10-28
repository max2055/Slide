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
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { refKey } from '../policy/model.js';
import { admin } from '../policy/test-support.js';

/**
 * MAX-238 publish-rejections package. On a disposable schema (METRICS_TEST_MYSQL_PORT) this uses
 * the existing PolicyService.changeBinding and MetricConfigurationService.status only. It shows
 * that a stale revision, a read-only actor, a stale candidate fingerprint and an incompatible
 * published release are all rejected without moving the already published revision or pin, and
 * that publishing resource 2 does not touch resource 1's binding or enabled override. activate is
 * never called, reportApplied is never called, no worker runs, and no attempt, observation or
 * publication is inserted.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const database = `max238_publish_rejections_${process.pid}`;
const ref1 = { type: 'instance' as const, id: 1 };
const ref2 = { type: 'instance' as const, id: 2 };
const evidencePath = fileURLToPath(new URL('../../../../../docs/slide/development/MAX-238/publish-rejections-20261028.json', import.meta.url));
type Status = Awaited<ReturnType<MetricConfigurationService['status']>>;
type Pin = { id: string; version: string; digest: string };

/** The keys this package reads from one actual status response. */
const observed = (status: Status) => ({
  resource: status.resource,
  'binding.published_revision': status.binding.published_revision,
  'binding.package': status.binding.package,
  'binding.application': status.binding.application,
  'binding.applied_revision': status.binding.applied_revision,
  'effective_enabled.policy_enabled': status.effective_enabled.policy_enabled,
  'effective_enabled.source': status.effective_enabled.source,
  blockers: status.blockers,
});

describe.skipIf(!port)('MAX-238 publish rejections keep the published revision and do not cross resources', () => {
  let root: Pool, pool: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let policies: PolicyService;
  let service: MetricConfigurationService;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const evidence: Record<string, unknown> = {};
  const rows = async (sql: string, values: unknown[] = []) =>
    (await pool.query<RowDataPacket[]>(sql, values as never))[0];
  const count = async (sql: string, values: unknown[] = []) => Number((await rows(sql, values))[0]!.n);
  const audits = (ref: { type: 'instance'; id: number }) =>
    count('SELECT COUNT(*) AS n FROM metric_policy_audit WHERE target = ?', [refKey(ref)]);
  /** A pin read from this resource's own recommended compatible published release. */
  const pinFor = async (): Promise<Pin> => {
    const recommendations = await service.recommendations(admin, ref1);
    const compatible = recommendations.packages.filter(entry => entry.compatibility === 'compatible');
    expect(compatible.length, `${ref1.type}:${ref1.id} must have a compatible published release`).toBeGreaterThan(0);
    const release = compatible[0].release.package;
    expect(packages.list().some(entry => entry.package.id === release.id
      && entry.package.version === release.version && entry.package.digest === release.digest)).toBe(true);
    return { id: release.id, version: release.version, digest: release.digest };
  };
  /** The actual code a rejected publish reports; never assumed to be the expected one. */
  const capture = async (action: () => Promise<unknown>) => {
    try { await action(); }
    catch (error) {
      const caught = error as { name?: string; message?: string; code?: unknown; status?: unknown };
      return { name: caught.name ?? 'Error', code: typeof caught.code === 'string' ? caught.code : null,
        status: typeof caught.status === 'number' ? caught.status : null, message: String(caught.message ?? error) };
    }
    return null;
  };

  beforeAll(async () => {
    // Global collection enabled for this test process only; never written to a file or the application DB.
    vi.stubEnv('METRICS_COLLECTION_ENABLED', 'true');
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 20, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    // Two disposable asset rows only: active + available, no target connection is opened.
    for (const [id, name] of [[ref1.id, 'publish-rejections-1'], [ref2.id, 'publish-rejections-2']] as const) {
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

  it('rejects stale revision, read-only actor, stale candidate and incompatible release; resource 2 stays separate', async () => {
    let current = 'read the recommended compatible pin';
    try {
      const pin = await pinFor();

      // 1. Resource 1 publishes one enabled compatible pin at expected_revision 0.
      current = 'publish the first enabled pin on resource 1';
      const first = await policies.changeBinding(admin, ref1, { expected_revision: 0, package: pin }, true);
      expect(first.published).toBe(true);
      expect(first.resources[0].binding.revision).toBe(1);
      expect(first.resources[0].binding.package).toEqual(pin);
      expect(first.resources[0].resolved.settings.enabled).toBe(true);
      current = 'read status after the first publish';
      const published = await service.status(admin, ref1);
      expect(published.binding.published_revision).toBe(1);
      expect(published.binding.package).toEqual(pin);
      expect(published.effective_enabled.policy_enabled).toBe(true);
      evidence.step1_publish = { pin, revision: first.resources[0].binding.revision,
        published_at: first.resources[0].published_at, status: observed(published) };

      // 2. The same pin at the already-consumed expected_revision 0 is a revision conflict.
      current = 'publish with a stale expected_revision';
      const staleRevision = await capture(() => policies.changeBinding(admin, ref1, { expected_revision: 0, package: pin }, true));
      expect(staleRevision, 'stale expected_revision must be rejected').not.toBeNull();
      expect(staleRevision!.code).toBe('POLICY_REVISION_CONFLICT');
      current = 'read status after the stale revision rejection';
      const afterStaleRevision = await service.status(admin, ref1);
      expect(afterStaleRevision.binding.published_revision).toBe(1);
      expect(afterStaleRevision.binding.package).toEqual(pin);
      expect(afterStaleRevision.binding.application).toBe('pending');
      evidence.step2_stale_revision = { error: staleRevision, status: observed(afterStaleRevision) };

      // 3. A read-only actor cannot publish; the rejection writes no audit row.
      const readOnly: ActorContext = { userId: 2, username: 'reader', roles: [], permissions: ['instance:view'],
        instanceScopes: { [ref1.id]: 'read-only' }, sessionVersion: 1, requestId: 'test-read-only' };
      const auditsBefore = await audits(ref1);
      current = 'publish as the read-only actor';
      const forbidden = await capture(() => policies.changeBinding(readOnly, ref1, { expected_revision: 1, package: pin }, true));
      const auditsAfter = await audits(ref1);
      expect(forbidden, 'a read-only actor must be rejected').not.toBeNull();
      expect(forbidden!.code).toBe('POLICY_FORBIDDEN');
      expect(auditsAfter).toBe(auditsBefore);
      current = 'read status after the forbidden publish';
      const afterForbidden = await service.status(admin, ref1);
      expect(afterForbidden.binding.published_revision).toBe(1);
      expect(afterForbidden.binding.package).toEqual(pin);
      expect(afterForbidden.effective_enabled.policy_enabled).toBe(true);
      evidence.step3_forbidden = { actor: { permissions: readOnly.permissions, instanceScopes: readOnly.instanceScopes },
        audits_before: auditsBefore, audits_after: auditsAfter, error: forbidden, status: observed(afterForbidden) };

      // 4. A stale candidate fingerprint is rejected even with a current expected_revision.
      current = 'publish with a stale candidate fingerprint';
      const staleCandidate = await capture(() => policies.changeBinding(admin, ref1,
        { expected_revision: 1, package: pin }, true, 'stale-candidate-fingerprint'));
      expect(staleCandidate, 'a stale candidate fingerprint must be rejected').not.toBeNull();
      expect(staleCandidate!.code).toBe('POLICY_REVISION_CONFLICT');
      current = 'read status after the stale candidate rejection';
      const afterStaleCandidate = await service.status(admin, ref1);
      expect(afterStaleCandidate.binding.published_revision).toBe(1);
      expect(afterStaleCandidate.binding.package).toEqual(pin);
      expect(afterStaleCandidate.effective_enabled.policy_enabled).toBe(true);
      evidence.step4_stale_candidate = { error: staleCandidate, status: observed(afterStaleCandidate) };

      // 5. Switching to a published release this resource is not compatible with is rejected.
      current = 'read recommendations for an incompatible published release';
      const recommendations = await service.recommendations(admin, ref1);
      const compatibility = recommendations.packages.map(entry => ({ id: entry.release.package.id,
        version: entry.release.package.version, compatibility: entry.compatibility }));
      evidence.recommendations_compatibility = compatibility;
      const incompatible = recommendations.packages.find(entry => entry.compatibility !== 'compatible');
      if (incompatible) {
        const switchPin = incompatible.release.package;
        expect(packages.list().some(entry => entry.package.id === switchPin.id
          && entry.package.version === switchPin.version && entry.package.digest === switchPin.digest)).toBe(true);
        current = `publish the ${incompatible.compatibility} release ${switchPin.id}@${switchPin.version}`;
        const incompatibleError = await capture(() => policies.changeBinding(admin, ref1, { expected_revision: 1,
          package: { id: switchPin.id, version: switchPin.version, digest: switchPin.digest } }, true));
        expect(incompatibleError, 'an incompatible published release must be rejected').not.toBeNull();
        current = 'read status after the incompatible release rejection';
        const afterIncompatible = await service.status(admin, ref1);
        expect(afterIncompatible.binding.published_revision).toBe(1);
        expect(afterIncompatible.binding.package).toEqual(pin);
        expect(afterIncompatible.effective_enabled.policy_enabled).toBe(true);
        evidence.step5_incompatible = { candidate: { id: switchPin.id, version: switchPin.version,
          digest: switchPin.digest, compatibility: incompatible.compatibility }, error: incompatibleError,
          status: observed(afterIncompatible) };
      } else {
        // No non-compatible published release exists: this step does not fail and no package is invented.
        evidence.step5_incompatible = { candidate: null, note: 'no published release with compatibility other than compatible' };
      }

      // Resource 2 publishes the same compatible pin with an explicit disable override.
      current = 'publish resource 2 with enabled=disable';
      const second = await policies.changeBinding(admin, ref2, { expected_revision: 0, package: pin,
        overrides: { enabled: 'disable' } }, true);
      expect(second.published).toBe(true);
      expect(second.resources[0].binding.revision).toBe(1);
      expect(second.resources[0].binding.package).toEqual(pin);
      expect(second.resources[0].resolved.settings.enabled).toBe(false);
      current = 'read status for both resources after the resource 2 publish';
      const status1After = await service.status(admin, ref1);
      const status2 = await service.status(admin, ref2);
      expect(status2.binding.published_revision).toBe(1);
      expect(status2.binding.package).toEqual(pin);
      expect(status2.effective_enabled.policy_enabled).toBe(false);
      // Resource 1 keeps its pin, revision and enabled override: no configuration crossed resources.
      expect(status1After.binding.published_revision).toBe(1);
      expect(status1After.binding.package).toEqual(pin);
      expect(status1After.effective_enabled.policy_enabled).toBe(true);
      expect(status1After.binding.application).toBe('pending');
      evidence.resource2_publish = { pin, revision: second.resources[0].binding.revision,
        published_at: second.resources[0].published_at, overrides: second.resources[0].binding.overrides,
        settings_enabled: second.resources[0].resolved.settings.enabled };
      evidence.status_after_resource2 = { resource1: observed(status1After), resource2: observed(status2) };
    } catch (error) {
      const caught = error as { name?: string; message?: string };
      evidence.error = { at: current, name: caught.name ?? 'Error', message: String(caught.message ?? error) };
      throw error;
    } finally {
      evidence.run = {
        branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        test: 'publish-rejections.mysql.test.ts',
        disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll`,
        boundaries: { activate_called: false, report_applied_called: false, worker_started: false,
          attempt_inserted: false, source_tables_written: 'disposable schema only; no 3306 statements',
          config_files_changed: false },
      };
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    }
  }, 180000);
});
