import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { admin } from '../policy/test-support.js';

/**
 * MAX-238 apply-failure-retains package. On a disposable schema (METRICS_TEST_MYSQL_PORT) this
 * publishes one enabled compatible pin through the existing PolicyService.changeBinding, records
 * the existing MysqlPolicyStore.reportApplied result, and reads the existing
 * MetricConfigurationService.status. The stored "last valid configuration" is the revision that
 * reportApplied(..., 'applied') acknowledged, i.e. binding.applied_revision. A later publish resets
 * binding.application to 'pending' and leaves applied_revision where it was; reporting that new
 * revision as 'failed' must therefore leave applied_revision on the earlier, previously applied
 * revision. No history snapshot is invented, activate is never called, no worker runs and no
 * attempt, observation or publication is inserted.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const database = `max238_apply_failure_${process.pid}`;
const ref = { type: 'instance' as const, id: 1 };
const evidencePath = fileURLToPath(new URL('../../../../../docs/slide/development/MAX-238/apply-failure-retains-20261028.json', import.meta.url));
type Status = Awaited<ReturnType<MetricConfigurationService['status']>>;
type Pin = { id: string; version: string; digest: string };

/** The keys this package reads from one actual status response. */
const observed = (status: Status) => ({
  resource: status.resource,
  binding: status.binding,
  blockers: status.blockers,
  effective_enabled: status.effective_enabled,
  formal_visibility: status.formal_visibility,
  collection: status.collection,
  keys: {
    'binding.published_revision': status.binding.published_revision,
    'binding.application': status.binding.application,
    'binding.applied_revision': status.binding.applied_revision,
    'binding.package': status.binding.package,
    blockers: status.blockers,
    'effective_enabled.policy_enabled': status.effective_enabled.policy_enabled,
    'collection.state': status.collection.state,
  },
});

describe.skipIf(!port)('MAX-238 a failed application keeps the previously applied revision', () => {
  let root: Pool, pool: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let policies: PolicyService;
  let store: MysqlPolicyStore;
  let service: MetricConfigurationService;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const evidence: Record<string, unknown> = {};
  const rows = async (sql: string, values: unknown[] = []) =>
    (await pool.query<RowDataPacket[]>(sql, values as never))[0];
  const count = async (sql: string) => Number((await rows(sql))[0]!.n);
  /** Formal history and attempts that this package may not create. */
  const formalRows = async () => ({
    metric_observations: await count('SELECT COUNT(*) AS n FROM metric_observations'),
    metric_publications: await count('SELECT COUNT(*) AS n FROM metric_publications'),
    metric_attempts: await count('SELECT COUNT(*) AS n FROM metric_attempts'),
  });
  /** A pin read from this resource's own recommended compatible published release. */
  const pinFor = async (): Promise<Pin> => {
    const recommendations = await service.recommendations(admin, ref);
    const compatible = recommendations.packages.filter(entry => entry.compatibility === 'compatible');
    expect(compatible.length, `${ref.type}:${ref.id} must have a compatible published release`).toBeGreaterThan(0);
    const release = compatible[0].release.package;
    expect(packages.list().some(entry => entry.package.id === release.id
      && entry.package.version === release.version && entry.package.digest === release.digest)).toBe(true);
    return { id: release.id, version: release.version, digest: release.digest };
  };

  beforeAll(async () => {
    // Global collection enabled for this test process only; never written to a file or the application DB.
    vi.stubEnv('METRICS_COLLECTION_ENABLED', 'true');
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 20, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    // One disposable asset row only: active + available, no target connection is opened.
    await pool.execute(`INSERT INTO database_instances
      (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
      VALUES (?,?,?,?,?,3306,'fixture','','fixture','8.0.46','active','available')`,
      [ref.id, 'apply-failure-retains-1', 'production', 'mysql', '127.0.0.1']);

    packages = createConfigurationRegistry();
    store = new MysqlPolicyStore(() => pool);
    policies = new PolicyService(store, packages, { exists: async () => true, inventory: configurationInventory });
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

  it('leaves applied_revision on the last applied revision when the new publish fails', async () => {
    const rowsBefore = await formalRows();
    let current = 'publish the first enabled pin';
    try {
      // 1. An enabled compatible pin is published and acknowledged as applied. This revision is the
      //    previously valid configuration for the rest of the test.
      const pin = await pinFor();
      current = 'publish the first enabled pin';
      const firstPublish = await policies.changeBinding(admin, ref, { expected_revision: 0, package: pin }, true);
      const firstRevision = firstPublish.resources[0].binding.revision;
      expect(firstPublish.published).toBe(true);
      expect(firstRevision).toBe(1);
      expect(firstPublish.resources[0].resolved.settings.enabled).toBe(true);
      const firstReportedAt = new Date(Date.parse(firstPublish.resources[0].published_at) + 1000).toISOString();
      current = 'reportApplied applied on the first revision';
      await store.reportApplied(ref, firstRevision, firstReportedAt, 'applied');

      const applied = await service.status(admin, ref);
      current = 'assert the first revision is applied';
      expect(applied.binding.application).toBe('applied');
      expect(applied.binding.published_revision).toBe(firstRevision);
      expect(applied.binding.applied_revision).toBe(firstRevision);
      expect(applied.binding.package).toEqual(pin);

      // 2. The same pin is published again with an explicit disable override. The publish resets the
      //    application to pending but must not advance applied_revision.
      current = 'publish the second revision with enabled=disable';
      const secondPublish = await policies.changeBinding(admin, ref,
        { expected_revision: firstRevision, package: pin, overrides: { enabled: 'disable' } }, true);
      const secondRevision = secondPublish.resources[0].binding.revision;
      expect(secondPublish.published).toBe(true);
      expect(secondRevision).toBe(firstRevision + 1);
      expect(secondPublish.resources[0].resolved.settings.enabled).toBe(false);

      const pending = await service.status(admin, ref);
      current = 'assert the pending publish kept the applied revision';
      expect(pending.binding.published_revision).toBe(secondRevision);
      expect(pending.binding.application).toBe('pending');
      expect(pending.binding.applied_revision).toBe(firstRevision);
      expect(pending.blockers).toContain('APPLICATION_PENDING');
      expect(pending.effective_enabled.policy_enabled).toBe(false);
      expect(pending.binding.package).toEqual(pin);

      // 3. Reporting the new revision as failed keeps the previously applied revision untouched.
      const failedReportedAt = new Date(Math.max(Date.parse(secondPublish.resources[0].published_at),
        Date.parse(firstReportedAt)) + 1000).toISOString();
      current = 'reportApplied failed on the second revision';
      await store.reportApplied(ref, secondRevision, failedReportedAt, 'failed');

      const failed = await service.status(admin, ref);
      current = 'assert the failed application kept the applied revision';
      expect(failed.binding.application).toBe('failed');
      expect(failed.blockers).toContain('APPLICATION_FAILED');
      expect(failed.binding.published_revision).toBe(secondRevision);
      expect(failed.binding.applied_revision).toBe(firstRevision);
      expect(failed.binding.package).toEqual(pin);

      // No attempt, observation or publication was inserted, and none of the reads claim success.
      expect(applied.collection.state).not.toBe('succeeded');
      expect(pending.collection.state).not.toBe('succeeded');
      expect(failed.collection.state).not.toBe('succeeded');
      const rowsAfter = await formalRows();
      expect(rowsAfter).toEqual(rowsBefore);
      expect(rowsAfter).toEqual({ metric_observations: 0, metric_publications: 0, metric_attempts: 0 });

      evidence.last_applied = {
        pin, revision: firstRevision, reported_at: firstReportedAt, application: 'applied',
      };
      evidence.publishes = {
        first: { revision: firstRevision, published_at: firstPublish.resources[0].published_at,
          package: firstPublish.resources[0].binding.package, settings_enabled: firstPublish.resources[0].resolved.settings.enabled },
        second: { revision: secondRevision, published_at: secondPublish.resources[0].published_at,
          package: secondPublish.resources[0].binding.package, overrides: secondPublish.resources[0].binding.overrides,
          settings_enabled: secondPublish.resources[0].resolved.settings.enabled },
      };
      evidence.reports = {
        first: { revision: firstRevision, status: 'applied', reported_at: firstReportedAt },
        second: { revision: secondRevision, status: 'failed', reported_at: failedReportedAt },
      };
      evidence.statuses = { applied: observed(applied), pending: observed(pending), failed: observed(failed) };
      evidence.formal_rows = { before: rowsBefore, after: rowsAfter };
    } catch (error) {
      const caught = error as { name?: string; message?: string };
      evidence.error = { at: current, name: caught.name ?? 'Error', message: String(caught.message ?? error) };
      throw error;
    } finally {
      evidence.run = {
        branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        test: 'apply-failure-retains.mysql.test.ts',
        disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll`,
        boundaries: { activate_called: false, worker_started: false, attempt_inserted: false,
          source_tables_written: 'disposable schema only; no 3306 statements', config_files_changed: false },
      };
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    }
  }, 180000);
});
