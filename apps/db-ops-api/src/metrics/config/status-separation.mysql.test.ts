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
 * MAX-238 status-separation package. On a disposable schema (METRICS_TEST_MYSQL_PORT) this publishes
 * one compatible pin per resource through the existing PolicyService.changeBinding, reports the
 * application result through the existing MysqlPolicyStore.reportApplied, and reads the existing
 * MetricConfigurationService.status. It proves that, inside one status read, the four existing
 * positions are independent:
 *
 *   - publishing is binding.published_revision (revision 1, application 'pending');
 *   - applying is binding.application/applied_revision;
 *   - waiting for the first sample is the AWAITING_SAMPLE blocker with a null last_observed_at;
 *   - a successful formal collection is collection.state === 'succeeded', which needs a succeeded
 *     attempt on the current revision and is therefore never reached here.
 *
 * Instance 1 is published (never activated) and then reports 'applied'; instance 2 is published and
 * reports 'failed'. No worker runs, no attempt or observation is inserted, and activate is never
 * called. status.ts, config/service.ts, policy/service.ts, policy/model.ts and store.ts keep their
 * current shape.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const database = `max238_status_separation_${process.pid}`;
const firstRef = { type: 'instance' as const, id: 1 };
const secondRef = { type: 'instance' as const, id: 2 };
const evidencePath = fileURLToPath(new URL('../../../../../docs/slide/development/MAX-238/status-separation-20261028.json', import.meta.url));
const separatedKeys = ['binding.published_revision', 'binding.application', 'binding.applied_revision',
  'blockers', 'formal_visibility.last_observed_at', 'formal_visibility.freshness', 'collection.state'] as const;
type Status = Awaited<ReturnType<MetricConfigurationService['status']>>;
type Pin = { id: string; version: string; digest: string };

describe.skipIf(!port)('MAX-238 publish, application, awaiting sample and formal success stay separate status keys', () => {
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
  /** The seven keys this package separates, read from one actual status response. */
  const separation = (status: Status) => ({
    resource: status.resource,
    binding: status.binding,
    blockers: status.blockers,
    effective_enabled: status.effective_enabled,
    formal_visibility: status.formal_visibility,
    collection: status.collection,
    separated_keys: {
      'binding.published_revision': status.binding.published_revision,
      'binding.application': status.binding.application,
      'binding.applied_revision': status.binding.applied_revision,
      blockers: status.blockers,
      'formal_visibility.last_observed_at': status.formal_visibility.last_observed_at,
      'formal_visibility.freshness': status.formal_visibility.freshness,
      'collection.state': status.collection.state,
    } as Record<(typeof separatedKeys)[number], unknown>,
  });
  /** A pin read from this resource's own recommended compatible published release. */
  const pinFor = async (ref: typeof firstRef | typeof secondRef): Promise<Pin> => {
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
    // Disposable asset rows only: active + available, no target connection is opened.
    for (const id of [1, 2]) await pool.execute(`INSERT INTO database_instances
      (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
      VALUES (?,?,?,?,?,3306,'fixture','','fixture','8.0.46','active','available')`,
      [id, `status-separation-${id}`, 'production', 'mysql', '127.0.0.1']);

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

  it('keeps publishing, application, awaiting sample and formal success on separate keys', async () => {
    const rowsBefore = await formalRows();
    let current = 'publish instance:1';
    try {
      // 1. Publishing is not applying and not a successful collection.
      const firstPin = await pinFor(firstRef);
      current = 'publish instance:1';
      const firstPublish = await policies.changeBinding(admin, firstRef, { expected_revision: 0, package: firstPin }, true);
      const firstRevision = firstPublish.resources[0].binding.revision;
      expect(firstPublish.published).toBe(true);
      expect(firstRevision).toBe(1);
      expect(firstPublish.resources[0].resolved.settings.enabled).toBe(true);

      const published = await service.status(admin, firstRef);
      current = 'assert published status';
      expect(published.binding.published_revision).toBe(firstRevision);
      expect(published.binding.application).toBe('pending');
      expect(published.binding.applied_revision).toBeNull();
      expect(published.blockers).toContain('APPLICATION_PENDING');
      expect(published.blockers).toContain('AWAITING_SAMPLE');
      expect(published.formal_visibility.last_observed_at).toBeNull();
      expect(published.formal_visibility.freshness).toBe('unknown');
      expect(published.collection.state).not.toBe('succeeded');

      // 2. The existing reportApplied marks this revision applied; the first sample is still missing
      //    and no collection has succeeded.
      const firstReportedAt = new Date(Date.parse(firstPublish.resources[0].published_at) + 1000).toISOString();
      current = 'reportApplied applied instance:1';
      await store.reportApplied(firstRef, firstRevision, firstReportedAt, 'applied');
      const applied = await service.status(admin, firstRef);
      current = 'assert applied status';
      expect(applied.binding.application).toBe('applied');
      expect(applied.binding.applied_revision).toBe(applied.binding.published_revision);
      expect(applied.blockers).toContain('AWAITING_SAMPLE');
      expect(applied.formal_visibility.last_observed_at).toBeNull();
      expect(applied.formal_visibility.freshness).toBe('unknown');
      expect(applied.collection.state).not.toBe('succeeded');

      // 3. A failed application on another resource is neither applied nor a successful collection.
      const secondPin = await pinFor(secondRef);
      current = 'publish instance:2';
      const secondPublish = await policies.changeBinding(admin, secondRef, { expected_revision: 0, package: secondPin }, true);
      const secondRevision = secondPublish.resources[0].binding.revision;
      expect(secondPublish.published).toBe(true);
      expect(secondRevision).toBe(1);
      const secondReportedAt = new Date(Date.parse(secondPublish.resources[0].published_at) + 1000).toISOString();
      current = 'reportApplied failed instance:2';
      await store.reportApplied(secondRef, secondRevision, secondReportedAt, 'failed');
      const failed = await service.status(admin, secondRef);
      current = 'assert failed status';
      expect(failed.binding.application).toBe('failed');
      expect(failed.binding.applied_revision).toBeNull();
      expect(failed.blockers).toContain('APPLICATION_FAILED');
      expect(failed.blockers).toContain('AWAITING_SAMPLE');
      expect(failed.collection.state).not.toBe('succeeded');

      // Each status names its own resource and its own published pin: configurations are not shared.
      expect(published.resource).toEqual({ type: 'instance', id: 1 });
      expect(failed.resource).toEqual({ type: 'instance', id: 2 });
      expect(published.binding.package).toEqual(firstPin);
      expect(failed.binding.package).toEqual(secondPin);

      // No attempt, observation or publication was inserted to reach 'succeeded'.
      const rowsAfter = await formalRows();
      expect(rowsAfter).toEqual({ metric_observations: 0, metric_publications: 0, metric_attempts: 0 });
      expect(rowsBefore).toEqual(rowsAfter);

      evidence.pins = { 'instance:1': firstPin, 'instance:2': secondPin };
      evidence.reports = { 'instance:1': { revision: firstRevision, status: 'applied', reported_at: firstReportedAt },
        'instance:2': { revision: secondRevision, status: 'failed', reported_at: secondReportedAt } };
      evidence.statuses = { 'instance:1.published': separation(published),
        'instance:1.applied': separation(applied), 'instance:2.failed': separation(failed) };
      evidence.separated_keys = [...separatedKeys];
      evidence.formal_rows = { before: rowsBefore, after: rowsAfter };
    } catch (error) {
      const caught = error as { name?: string; message?: string };
      evidence.error = { at: current, name: caught.name ?? 'Error', message: String(caught.message ?? error) };
      throw error;
    } finally {
      evidence.run = {
        branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        test: 'status-separation.mysql.test.ts',
        disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll`,
        boundaries: { activate_called: false, worker_started: false, attempt_inserted: false,
          source_tables_written: 'disposable schema only; no 3306 statements', config_files_changed: false },
      };
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    }
  }, 180000);
});
