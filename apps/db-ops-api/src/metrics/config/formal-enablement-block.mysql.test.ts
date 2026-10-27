import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * MAX-238 formal-enablement-block package. On a disposable schema (METRICS_TEST_MYSQL_PORT) the
 * existing PolicyService.changeBinding publishes the installed packages for the two real targets
 * (instance 1 mysql3306 and server 3 192.168.49.130:22). Each resource then runs one existing
 * MetricConfigurationService.trialCurrent to observe at least one non-good sample and one existing
 * MetricConfigurationService.activate with the current binding revision.
 *
 * The acceptance sentence under test is "untested or required-item failure blocks enablement": while
 * a non-good sample remains and no explicit exemption parameter exists, activate must not publish.
 * The test records the observed decision, revisions, error code and status for both targets before
 * asserting, so a publish is reported as a missing condition with evidence rather than hidden.
 *
 * No collector, status, scheduler, worker, route, template, binding, policy, migration or frontend
 * source is changed. Nothing is activated on the application database; the source is read with
 * SELECT only and its credentials are re-encrypted into the disposable copy.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const envFile = process.env.SLIDE_DEBUG_ENV_FILE;
const database = `max238_formal_enablement_block_${process.pid}`;
const instanceRef = { type: 'instance' as const, id: 1 };
const serverRef = { type: 'server' as const, id: 3 };
/** Migration 121 renames the metric v2 alert tables; count whichever name exists. */
const alertTableNames = [
  { requested: 'metric_v2_alert_state', renamed: 'metric_alert_state' },
  { requested: 'metric_v2_alert_transitions', renamed: 'metric_alert_transitions' },
] as const;
const formalTables = ['alerts', 'alert_events', 'notification_records', 'metric_publications'] as const;
/** Non-good reasons already observed for these targets by the previous package. */
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
type Trial = { persisted: boolean; decision: string; error?: string; samples: Sample[];
  attempts: { collector_id: string; status: string; error: string | null }[] };
const evidencePath = fileURLToPath(new URL('../../../../../docs/slide/development/MAX-238/formal-enablement-block-20261027.json', import.meta.url));

describe.skipIf(!port || !envFile)('MAX-238 non-good trial samples block enablement', () => {
  let root: Pool, pool: Pool, source: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let policies: PolicyService;
  let service: MetricConfigurationService;
  let configured: Record<string, string>;
  let alertTables: Record<string, string>;
  let poolSpy: ReturnType<typeof vi.spyOn>;
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
  /** Formal history and alert rows neither the trial nor a failed activation may create. */
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
  const revisionOf = async (ref: typeof instanceRef | typeof serverRef) =>
    (await policies.effective(admin, ref)).published_revision;

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
    // Pin the authorized targets, including ports, before any copy or activation.
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
    policies = new PolicyService(new MysqlPolicyStore(() => pool), packages,
      { exists: async () => true, inventory: configurationInventory });
    const pinOf = (id: string) => {
      const release = packages.list().find(r => r.package.id === id && r.package.version === '1.1.0');
      expect(release, `${id}@1.1.0 must be installed`).toBeTruthy();
      return { id: release!.package.id, version: release!.package.version, digest: release!.package.digest };
    };
    // Publish the existing packages through the normal policy path on the disposable schema only.
    await policies.changeBinding(admin, instanceRef, { expected_revision: 0, package: pinOf('mysql-diagnostics') }, true);
    await policies.changeBinding(admin, serverRef, { expected_revision: 0, package: pinOf('linux-host') }, true);
    // The trial transport reads through this asset connection, so open the authorized target once.
    expect(await databaseService.addConnection(1, 'MAX238 formal enablement block', { host: instance.host, port: instance.port,
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

  it('does not publish while a non-good sample remains and records the observed decision', async () => {
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
    const evidence: Record<string, unknown> = {};

    try {
      for (const { ref, package: packageId, expected } of resources) {
        const key = `${ref.type}:${ref.id}`;
        // 1. One existing trial on the real target, with its per-sample quality preserved.
        const trial = await service.trialCurrent(admin, ref) as Trial;
        const nonGood = trial.samples.filter(sample => sample.quality.status !== 'good')
          .map(sample => ({ metric: sample.metric.id, quality: sample.quality, value: sample.value, unit: sample.unit }));
        for (const sample of trial.samples) allSamples.push({ resource: key, sample });

        // 2. One existing activate call with the resource's current binding revision.
        const revisionBefore = await revisionOf(ref);
        const pin = { id: packageId, version: '1.1.0', digest: packages.list()
          .find(r => r.package.id === packageId && r.package.version === '1.1.0')!.package.digest };
        let activate: Record<string, unknown>;
        try {
          const result = await service.activate(admin, ref, { expected_revision: revisionBefore, package: pin });
          activate = { outcome: 'returned', published: result.published,
            revision: result.resources[0].binding.revision, error_code: null, error_message: null };
        } catch (error) {
          activate = { outcome: 'threw', published: null, revision: null,
            error_code: (error as { code?: string }).code ?? null, error_message: (error as Error).message ?? null };
        }
        const revisionAfter = await revisionOf(ref);
        const status = await service.status(admin, ref);
        const rowsAfter = await formalRows();

        proof[key] = {
          package: packageId,
          trial: { persisted: trial.persisted, decision: trial.decision, error: trial.error ?? null,
            samples: trial.samples.length, non_good: nonGood,
            attempts: trial.attempts.map(attempt => ({ collector_id: attempt.collector_id, status: attempt.status, error: attempt.error })) },
          binding: { revision_before: revisionBefore, revision_after: revisionAfter,
            changed: revisionAfter !== revisionBefore, activate },
          status: { resource: status.resource, collection: status.collection, formal_visibility: status.formal_visibility,
            blockers: status.blockers },
          formal_rows_after: rowsAfter,
        };
        // Every activation attempt was already recorded above; the evidence file is written before
        // any assertion so a publish is reported with the facts that produced it.
      }

      const after = await liveSnapshot();
      const rowsAfter = await formalRows();
      const allNonGood = allSamples.filter(entry => entry.sample.quality.status !== 'good');
      const known: Record<string, unknown> = {};
      for (const entry of knownExplanations) {
        const samples = allSamples.filter(candidate => candidate.resource === entry.resource
          && candidate.sample.metric.id === entry.metric).map(candidate => candidate.sample);
        known[`${entry.resource} ${entry.metric}`] = { expected: { status: entry.status, reason: entry.reason },
          observed: samples.map(sample => ({ status: sample.quality.status, reason: sample.quality.reason, value: sample.value })),
          verdict: samples.length === 0 ? 'missing' : samples.every(sample => sample.quality.status === 'good') ? 'became_good' : 'non_good_present' };
      }
      evidence.run = { branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), test: 'formal-enablement-block.mysql.test.ts',
        disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll` };
      evidence.targets = { instance: { id: 1, name: 'mysql3306', host: 'localhost', port: 3306 },
        server: { id: 3, host: '192.168.49.130', port: 22 } };
      evidence.results = proof;
      evidence.known = known;
      evidence.formal_rows = { before: rowsBefore, after: rowsAfter, zero };
      evidence.readonly = { pre: before, post: after, unchanged: JSON.stringify(before) === JSON.stringify(after) };
      evidence.tables = { alert_tables: alertTables, formal_tables: [...formalTables],
        note: 'migration 121 renames metric_v2_alert_state/metric_v2_alert_transitions; the resolved post-migration names were counted' };
      evidence.totals = { samples: allSamples.length, good: allSamples.length - allNonGood.length,
        partial: allNonGood.filter(entry => entry.sample.quality.status === 'partial').length,
        unknown: allNonGood.filter(entry => entry.sample.quality.status === 'unknown').length,
        invalid: allNonGood.filter(entry => entry.sample.quality.status === 'invalid').length, non_good: allNonGood.length };
      evidence.blocking = Object.fromEntries(Object.entries(proof).map(([key, entry]) => {
        const binding = entry.binding as { revision_before: number; revision_after: number; changed: boolean;
          activate: { outcome: string; error_code: string | null; published: unknown; revision: unknown } };
        return [key, { non_good_observed: (entry.trial as { non_good: unknown[] }).non_good.length,
          revision_before: binding.revision_before, revision_after: binding.revision_after,
          activate_error: binding.activate.error_code, published: !binding.changed ? false : true,
          blocked: binding.activate.error_code === 'CONFIGURATION_TRIAL_FAILED' && !binding.changed }];
      }));
      evidence.requirement = { sentence: 'untested or required-item failure blocks enablement',
        satisfied: Object.values(evidence.blocking as Record<string, { blocked: boolean }>)
          .every(entry => entry.blocked) };
    } finally {
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    }

    // A non-good sample must actually be present for this package to prove anything.
    const allNonGood = allSamples.filter(entry => entry.sample.quality.status !== 'good');
    expect(allNonGood.length, 'at least one non-good sample must remain').toBeGreaterThan(0);
    for (const { resource, sample } of allNonGood) {
      expect(typeof sample.metric?.id, `${resource} sample must name its metric`).toBe('string');
      expect(() => QualitySchema.parse(sample.quality), `${resource} ${sample.metric.id} quality must match the contract`).not.toThrow();
      expect(['partial', 'unknown', 'invalid']).toContain(sample.quality.status);
      expect(sample.quality.reason.length, `${resource} ${sample.metric.id} needs its own reason`).toBeGreaterThan(0);
      expect(sample.quality.reason, `${resource} ${sample.metric.id} reason must not be none`).not.toBe('none');
    }
    for (const { resource, sample } of allSamples.filter(entry => entry.sample.quality.status === 'good')) {
      expect(sample.quality.reason, `${resource} ${sample.metric.id} good sample keeps reason none`).toBe('none');
    }

    // Required proof: a remaining non-good sample, with no explicit exemption parameter, blocks enablement.
    for (const [key, entry] of Object.entries(proof)) {
      const binding = entry.binding as { revision_before: number; revision_after: number; changed: boolean;
        activate: { outcome: string; error_code: string | null } };
      const trial = entry.trial as { non_good: unknown[] };
      if (trial.non_good.length === 0) continue;
      expect(binding.activate.error_code, `${key} must be blocked by CONFIGURATION_TRIAL_FAILED while non-good samples remain`)
        .toBe('CONFIGURATION_TRIAL_FAILED');
      expect(binding.activate.outcome, `${key} activate must throw, not return a publication`).toBe('threw');
      expect(binding.changed, `${key} binding revision must not move`).toBe(false);
      expect(binding.revision_after, `${key} revision after activation`).toBe(binding.revision_before);
      const status = entry.status as { collection: { state: string }; formal_visibility: { last_observed_at: string | null } };
      expect(status.collection.state, `${key} must not report a succeeded collection`).not.toBe('succeeded');
      expect(status.formal_visibility.last_observed_at, `${key} must not report a formal observation`).toBeNull();
      expect(entry.formal_rows_after, `${key} must not write formal history or alerts`).toEqual(zero);
    }
  }, 300000);
});
