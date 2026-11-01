import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { dbConnection, decryptData, encryptData } from '../../db-connection.js';
import { databaseService } from '../../database-service.js';
import sshSessionPool from '../../ssh-session-pool.js';
import { configurationInventory } from './inventory.js';
import { createConfigurationRegistry } from './registry.js';
import { createTrialStore } from './routes.js';
import { MetricConfigurationService } from './service.js';
import { createAssetCollectorAccess } from './access.js';
import { configurationReader } from './status-store.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';
import { QualitySchema } from '../../contracts/metrics/observations.js';

/**
 * MAX-238 formal-partial-explanation package. The disposable schema (METRICS_TEST_MYSQL_PORT) is
 * published through the existing PolicyService.changeBinding for two real targets (instance 1
 * mysql3306 and server 3 192.168.49.130:22), then each resource runs the existing
 * MetricConfigurationService.trial (trialCurrent) through createAssetCollectorAccess(), the same
 * service construction as unified.real.test.ts without preserveDiscovery. No worker runs, nothing
 * is activated, and no collection is scheduled. Using existing fields, the test proves:
 *
 *   1. the two trials together return at least one truly non-good sample;
 *   2. every non-good sample is its own object with metric.id, quality.status
 *      (partial/unknown/invalid) and a non-empty quality.reason from the existing enum
 *      (never 'none'); duplicated metric ids keep their own quality, and good samples keep
 *      status 'good' with reason 'none';
 *   3. those explanations live in trial.samples: decision='attempted', persisted=false, no
 *      top-level error replaces an empty sample list;
 *   4. the disposable schema holds zero formal observations, publications, alerts and alert
 *      state/transition rows before and after both trials, and the existing status read still
 *      reports AWAITING_SAMPLE (not succeeded) for its own resource.
 *
 * Known non-good reasons from the previous trial-history package are recorded as evidence and
 * asserted when they are still non-good; a metric that becomes good is recorded, not failed.
 *
 * The source application database is read with SELECT only; credentials are decrypted from the
 * existing rows and re-encrypted into the disposable copy. Live binding and asset rows are never
 * written.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const envFile = process.env.SLIDE_DEBUG_ENV_FILE;
const database = `max238_formal_partial_explanation_${process.pid}`;
const instanceRef = { type: 'instance' as const, id: 1 };
const serverRef = { type: 'server' as const, id: 3 };
/** Migration 121 renames the metric v2 alert tables; count whichever name exists. */
const alertTableNames = [
  { requested: 'metric_v2_alert_state', renamed: 'metric_alert_state' },
  { requested: 'metric_v2_alert_transitions', renamed: 'metric_alert_transitions' },
] as const;
const formalTables = ['alerts', 'alert_events', 'notification_records', 'metric_publications'] as const;
/** Per-item explanations already observed for these targets by the previous package. */
const knownExplanations = [
  { resource: 'instance:1', metric: 'mysql.innodb.deadlocks_total', status: 'unknown', reason: 'source_error' },
  { resource: 'instance:1', metric: 'mysql.transaction_commands.commit_rate', status: 'unknown', reason: 'counter_baseline' },
  { resource: 'instance:1', metric: 'mysql.transaction_commands.rollback_rate', status: 'unknown', reason: 'counter_baseline' },
  { resource: 'instance:1', metric: 'mysql.transaction_commands.completed_rate', status: 'unknown', reason: 'counter_baseline' },
  { resource: 'instance:1', metric: 'mysql.queries.per_second', status: 'unknown', reason: 'counter_baseline' },
  { resource: 'server:3', metric: 'linux.filesystem.inode_used_percent', status: 'unknown', reason: 'not_applicable' },
  { resource: 'server:3', metric: 'linux.filesystem.used_ratio', status: 'partial', reason: 'precision_loss' },
] as const;
type Sample = { metric: { id: string; semantic_version: string }; value: unknown;
  quality: { status: 'good' | 'partial' | 'unknown' | 'invalid'; reason: string }; unit: string };

describe.skipIf(!port || !envFile)('MAX-238 trials explain partial failures per sample', () => {
  let root: Pool, pool: Pool, source: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let service: MetricConfigurationService;
  let configured: Record<string, string>;
  let alertTables: Record<string, string>;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const evidence: Record<string, unknown> = {};
  const query = async (target: Pool, sql: string, values: unknown[] = []) =>
    (await target.query<RowDataPacket[]>(sql, values as never))[0];
  const rows = (sql: string, values: unknown[] = []) => query(pool, sql, values);
  const one = async (sql: string, values: unknown[] = []) => (await rows(sql, values))[0];
  const tableExists = async (name: string) =>
    (await rows('SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name])).length > 0;
  const count = async (sql: string) => Number((await one(sql))!.n);

  /** Read-only snapshot of exactly the facts this package must not change on the source. */
  const liveSnapshot = async () => {
    const instances = await query(source, 'SELECT COUNT(*) AS n FROM database_instances');
    const servers = await query(source, 'SELECT COUNT(*) AS n FROM servers');
    const server3 = await query(source, 'SELECT id, collection_enabled, host, port FROM servers WHERE id = 3');
    const bindings = await query(source,
      "SELECT resource_key, JSON_EXTRACT(payload,'$.binding.revision') AS revision FROM metric_policy_bindings WHERE resource_key IN ('instance:1','server:3') ORDER BY resource_key");
    return {
      database_instances: Number(instances[0].n),
      servers: Number(servers[0].n),
      server3: { id: Number(server3[0]?.id ?? 0), collection_enabled: Number(server3[0]?.collection_enabled ?? -1),
        host: String(server3[0]?.host ?? ''), port: Number(server3[0]?.port ?? 0) },
      bindings: bindings.map(row => ({ resource_key: String(row.resource_key), revision: Number(row.revision) })),
    };
  };
  /** Formal history and alert rows the trial is not allowed to create. */
  const formalRows = async () => {
    const counts: Record<string, number> = {
      normalized_observations: await count("SELECT COUNT(*) AS n FROM metric_observations WHERE stage = 'normalized'") };
    for (const table of formalTables) counts[table] = await count(`SELECT COUNT(*) AS n FROM ${table}`);
    for (const { requested } of alertTableNames) counts[requested] = await count(`SELECT COUNT(*) AS n FROM ${alertTables[requested]}`);
    return counts;
  };
  const zero = Object.fromEntries([['normalized_observations', 0],
    ...formalTables.map(table => [table, 0]),
    ...alertTableNames.map(({ requested }) => [requested, 0])]) as Record<string, number>;

  beforeAll(async () => {
    configured = parse(readFileSync(envFile!));
    vi.stubEnv('ENCRYPTION_KEY', configured.ENCRYPTION_KEY);
    // Global collection is enabled so nothing hides behind a global switch.
    vi.stubEnv('METRICS_COLLECTION_ENABLED', 'true');
    // READ-ONLY source connection: every statement issued through it below is a SELECT.
    source = mysql.createPool({ host: configured.DB_HOST || '127.0.0.1', port: Number(configured.DB_PORT || 3306),
      user: configured.DB_USER || 'root', password: configured.DB_PASSWORD || '', database: configured.DB_NAME, connectionLimit: 4 });
    const [instance] = await query(source,
      'SELECT id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state FROM database_instances WHERE id = 1');
    const [server] = await query(source,
      'SELECT id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint,status,collection_enabled FROM servers WHERE id = 3');
    // Pin the authorized targets, including ports, before any copy or trial.
    expect(instance).toMatchObject({ id: 1, name: 'mysql3306', port: 3306 });
    expect(server).toMatchObject({ id: 3, host: '192.168.49.130', port: 22 });
    const instancePassword = decryptData(String(instance.password_encrypted), configured.ENCRYPTION_KEY);
    const serverCredentials = JSON.parse(decryptData(String(server.credential_encrypted), configured.ENCRYPTION_KEY)) as { username: string; password?: string; privateKey?: string };
    expect(serverCredentials.username).toBeTruthy();
    expect(serverCredentials.password || serverCredentials.privateKey).toBeTruthy();

    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 20, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);

    await pool.execute(`INSERT INTO database_instances
      (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
      VALUES (?,?,?,?,?,?,?,?,?,?,'active','available')`, [1, instance.name, instance.environment, instance.db_type,
      instance.host, instance.port, instance.username, encryptData(instancePassword, configured.ENCRYPTION_KEY),
      instance.database_name, instance.db_version]);
    await pool.execute(`INSERT INTO servers
      (id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint,status,collection_enabled)
      VALUES (?,?,?,?,?,?,?,?,'online',?)`, [3, server.host, server.port, server.label, server.os_type, server.credential_type,
      encryptData(JSON.stringify(serverCredentials), configured.ENCRYPTION_KEY), server.host_key_fingerprint, server.collection_enabled]);

    packages = createConfigurationRegistry();
    const policies = new PolicyService(new MysqlPolicyStore(() => pool), packages,
      { exists: async () => true, inventory: configurationInventory });
    const pinOf = (id: string) => {
      const release = packages.list().find(r => r.package.id === id && r.package.version === '1.1.0');
      expect(release, `${id}@1.1.0 must be installed`).toBeTruthy();
      return { id: release!.package.id, version: release!.package.version, digest: release!.package.digest };
    };
    // Publish the existing packages through the normal policy path; nothing is activated.
    await policies.changeBinding(admin, instanceRef, { expected_revision: 0, package: pinOf('mysql-diagnostics') }, true);
    await policies.changeBinding(admin, serverRef, { expected_revision: 0, package: pinOf('linux-host') }, true);
    // The trial transport reads through this asset connection, so open the authorized target once.
    expect(await databaseService.addConnection(1, 'MAX238 formal partial explanation', { host: instance.host, port: instance.port,
      user: instance.username, password: instancePassword, database: instance.database_name || 'mysql', db_type: 'mysql' })).toBe(true);

    alertTables = {};
    for (const { requested, renamed } of alertTableNames) {
      const resolved = await tableExists(requested) ? requested : await tableExists(renamed) ? renamed : null;
      expect(resolved, `${requested}/${renamed} must exist after migrations`).not.toBeNull();
      alertTables[requested] = resolved!;
    }
    for (const table of formalTables) expect(await tableExists(table), `${table} must exist after migrations`).toBe(true);

    service = new MetricConfigurationService(policies, packages, createTrialStore(() => pool, packages),
      createAssetCollectorAccess(), configurationReader(() => pool));
  }, 180000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    await databaseService.removeConnection(1);
    sshSessionPool.closeAll();
    await source?.end();
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
    vi.unstubAllEnvs();
  }, 60000);

  it('explains every non-good trial sample per item without formal history or a healthy status', async () => {
    const before = await liveSnapshot();
    // The authorized source baseline this package must leave untouched.
    expect(before).toEqual({ database_instances: 5, servers: 1,
      server3: { id: 3, collection_enabled: 1, host: '192.168.49.130', port: 22 },
      bindings: [{ resource_key: 'instance:1', revision: 4 }, { resource_key: 'server:3', revision: 3 }] });
    const rowsBefore = await formalRows();
    expect(rowsBefore).toEqual(zero);

    const resources = [
      { ref: instanceRef, package: 'mysql-diagnostics', expected: { type: 'instance', id: 1 } },
      { ref: serverRef, package: 'linux-host', expected: { type: 'server', id: 3 } },
    ] as const;
    const proof: Record<string, Record<string, unknown>> = {};
    const allSamples: { resource: string; sample: Sample }[] = [];
    for (const { ref, package: packageId, expected } of resources) {
      const key = `${ref.type}:${ref.id}`;
      const trial = await service.trialCurrent(admin, ref);
      // 3. A finished attempt that still keeps its explanations inside samples.
      expect(trial.persisted, `${key} trial must not persist`).toBe(false);
      expect(trial.decision, `${key} trial must be attempted, not an empty error`).toBe('attempted');
      expect('error' in trial ? trial.error ?? null : null, `${key} must not collapse into a top-level error`).toBeNull();
      expect(trial.samples.length, `${key} must return samples`).toBeGreaterThan(0);
      expect(trial.attempts.length, `${key} must return collector attempts`).toBeGreaterThan(0);

      // 2. Each sample carries its own quality from the existing contract enum.
      const nonGood: Sample[] = [];
      const duplicateMetrics: Record<string, Sample[]> = {};
      for (const sample of trial.samples as Sample[]) {
        expect(typeof sample.metric?.id, `${key} sample must name its metric`).toBe('string');
        expect(sample.metric.id.length).toBeGreaterThan(0);
        expect(() => QualitySchema.parse(sample.quality), `${key} ${sample.metric.id} quality must match the contract`).not.toThrow();
        if (sample.quality.status === 'good') {
          expect(sample.quality.reason, `${key} ${sample.metric.id} good sample keeps reason none`).toBe('none');
        } else {
          expect(['partial', 'unknown', 'invalid']).toContain(sample.quality.status);
          expect(sample.quality.reason, `${key} ${sample.metric.id} needs a per-item reason`).not.toBe('none');
          expect(sample.quality.reason.length).toBeGreaterThan(0);
          nonGood.push(sample);
        }
        (duplicateMetrics[sample.metric.id] ??= []).push(sample);
        allSamples.push({ resource: key, sample });
      }
      // Every non-good sample is its own object, never one shared explanation.
      expect(new Set(nonGood).size).toBe(nonGood.length);
      // A metric id repeated across series keeps a quality on every sample, not just the first.
      const duplicated = Object.entries(duplicateMetrics).filter(([, samples]) => samples.length > 1);
      for (const [metric, samples] of duplicated) {
        for (const sample of samples) expect(sample.quality, `${key} ${metric} repeated sample keeps its own quality`).toBeTruthy();
        expect(new Set(samples.map(sample => sample.quality)).size, `${key} ${metric} qualities must be per sample`).toBe(samples.length);
      }

      // 4. Nothing reached the formal history or alert tables, even between the two trials.
      const rowsAfterTrial = await formalRows();
      expect(rowsAfterTrial).toEqual(zero);
      // 4. The trial result is not a healthy formal sample.
      const status = await service.status(admin, ref);
      expect(status.formal_visibility.last_observed_at, `${key} must not report an observation time`).toBeNull();
      expect(status.formal_visibility.freshness).toBe('unknown');
      expect(status.blockers).toContain('AWAITING_SAMPLE');
      expect(status.collection.state).not.toBe('succeeded');
      expect(status.resource).toEqual(expected);

      proof[key] = {
        package: packageId,
        trial: { persisted: trial.persisted, decision: trial.decision, error: 'error' in trial ? trial.error ?? null : null,
          samples: trial.samples, attempts: trial.attempts.map(attempt => ({
            collector_id: attempt.collector_id, status: attempt.status, error: attempt.error,
            evidence_code: attempt.evidence_code ?? null, started_at: attempt.started_at, ended_at: attempt.ended_at ?? null })) },
        non_good: nonGood.map(sample => ({ metric: sample.metric.id, quality: sample.quality, value: sample.value, unit: sample.unit })),
        duplicate_metrics: Object.fromEntries(duplicated.map(([metric, samples]) => [metric, samples.length])),
        formal_rows_after_trial: rowsAfterTrial,
        resource: status.resource,
        collection: status.collection,
        formal_visibility: status.formal_visibility,
        blockers: status.blockers,
      };
    }
    // Distinct resources: one trial and one status per target, never the same object twice.
    expect(new Set(Object.values(proof).map(entry => JSON.stringify(entry.resource))).size).toBe(2);

    // 1. The two real trials together produced at least one genuinely non-good sample.
    const allNonGood = allSamples.filter(entry => entry.sample.quality.status !== 'good');
    expect(allNonGood.length, 'at least one non-good sample must be explained').toBeGreaterThan(0);

    // Known non-good items keep their per-item reason; one becoming good is evidence, not failure.
    const known: Record<string, unknown> = {};
    for (const entry of knownExplanations) {
      const samples = allSamples.filter(candidate => candidate.resource === entry.resource
        && candidate.sample.metric.id === entry.metric).map(candidate => candidate.sample);
      const bad = samples.filter(sample => sample.quality.status !== 'good');
      if (samples.length === 0) {
        known[`${entry.resource} ${entry.metric}`] = { expected: { status: entry.status, reason: entry.reason }, verdict: 'missing' };
        continue;
      }
      for (const sample of bad) {
        expect(sample.quality.status, `${entry.resource} ${entry.metric} keeps its status`).toBe(entry.status);
        expect(sample.quality.reason, `${entry.resource} ${entry.metric} keeps its reason`).toBe(entry.reason);
      }
      known[`${entry.resource} ${entry.metric}`] = { expected: { status: entry.status, reason: entry.reason },
        observed: samples.map(sample => ({ status: sample.quality.status, reason: sample.quality.reason, value: sample.value })),
        verdict: bad.length === 0 ? 'became_good' : 'matches' };
    }

    // 4. The final state is still empty; the reads never wrote a sample either.
    const rowsAfter = await formalRows();
    expect(rowsAfter).toEqual(zero);
    const schedules = Number((await one('SELECT COUNT(*) AS n FROM metric_schedule'))!.n);
    const attempts = Number((await one('SELECT COUNT(*) AS n FROM metric_attempts'))!.n);
    expect({ schedules, attempts }).toEqual({ schedules: 0, attempts: 0 });

    // Only the disposable schema held rows; the source stays identical.
    const after = await liveSnapshot();
    expect(after).toEqual(before);
    const totals = { samples: allSamples.length, good: allSamples.length - allNonGood.length,
      partial: allSamples.filter(entry => entry.sample.quality.status === 'partial').length,
      unknown: allSamples.filter(entry => entry.sample.quality.status === 'unknown').length,
      invalid: allSamples.filter(entry => entry.sample.quality.status === 'invalid').length,
      non_good: allNonGood.length };
    evidence.readonly = { pre: before, post: after, unchanged: true };
    evidence.results = proof;
    evidence.quality = { totals, non_good: allNonGood.map(entry => ({ resource: entry.resource,
      metric: entry.sample.metric.id, quality: entry.sample.quality, value: entry.sample.value, unit: entry.sample.unit })) };
    evidence.known = known;
    evidence.formal_rows = { before: rowsBefore, after_trials: rowsAfter, zero };
    evidence.tables = { alert_tables: alertTables, formal_tables: [...formalTables],
      note: 'migration 121 renames metric_v2_alert_state/metric_v2_alert_transitions; the resolved post-migration names were counted' };
    evidence.run = { branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), test: 'formal-partial-explanation.mysql.test.ts',
      disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll` };
    evidence.targets = { instance: { id: 1, name: 'mysql3306', host: 'localhost', port: 3306 },
      server: { id: 3, host: '192.168.49.130', port: 22 } };
    writeFileSync(new URL('../../../../../docs/slide/development/MAX-238/formal-partial-explanation-20261027.json', import.meta.url),
      JSON.stringify(evidence, null, 2) + '\n');
  }, 180000);
});
