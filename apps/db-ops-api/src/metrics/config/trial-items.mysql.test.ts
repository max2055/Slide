import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { dbConnection, decryptData, encryptData } from '../../db-connection.js';
import { databaseService } from '../../database-service.js';
import { configurationInventory } from './inventory.js';
import { createConfigurationRegistry } from './registry.js';
import { createTrialStore } from './routes.js';
import { MetricConfigurationService } from './service.js';
import { createAssetCollectorAccess } from './access.js';
import { configurationReader } from './status-store.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';

/**
 * MAX-238 trial-items package. On a disposable schema (METRICS_TEST_MYSQL_PORT) this publishes one
 * pin read from the existing recommendations for instance 1 (mysql3306) and runs one existing
 * MetricConfigurationService.trialCurrent, then checks the acceptance sentence "a test returns, item
 * by item, the read, the transform, the unit check, the value, the time, the duration and the
 * error".
 *
 * Every item is looked up in the trial response itself (samples and their collector attempts). The
 * test deliberately does not substitute quality.status/quality.reason for read/transform/unit-check,
 * does not count the unit string as a unit check, and invents no timer. An item with no field in the
 * existing response is recorded as missing and the test fails at that item instead of passing.
 *
 * No product code is changed: config/service.ts, policy/*, resolver.ts, access.ts, routes, registry,
 * builtins, migrations and the frontend keep their current shape. activate is never called, formal
 * history/alerts stay empty, and the application database is read with SELECT only.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const envFile = process.env.SLIDE_DEBUG_ENV_FILE;
const database = `max238_trial_items_${process.pid}`;
const ref = { type: 'instance' as const, id: 1 };
const evidencePath = fileURLToPath(new URL('../../../../../docs/slide/development/MAX-238/trial-items-20261028.json', import.meta.url));
const formalTables = ['metric_observations', 'metric_publications', 'alerts', 'alert_events', 'notification_records'] as const;
const itemOrder = ['读取', '转换', '单位校验', '值', '时间', '耗时', '错误'] as const;
type Item = (typeof itemOrder)[number];
type Sample = { metric: { id: string; semantic_version: string }; value: unknown;
  quality: { status: string; reason: string }; unit: string };
type Attempt = { collector_id: string; started_at: string; ended_at?: string; status: string;
  error: string | null; observation_ids: string[] };
type Trial = { persisted: boolean; decision: string; error?: string; samples: Sample[]; attempts: Attempt[] };
/** Where one item was read from in the existing trial response, or why no field exists. */
type ItemVerdict = { source: string | null; present: boolean; observed: unknown; reason: string };

describe.skipIf(!port || !envFile)('MAX-238 a trial returns read, transform, unit check, value, time, duration and error per item', () => {
  let root: Pool, pool: Pool, source: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let policies: PolicyService;
  let service: MetricConfigurationService;
  let configured: Record<string, string>;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  let target: { id: number; name: string; environment: string; db_type: string; host: string; port: number;
    username: string; database_name: string | null; db_version: string };
  let targetPassword = '';
  let targetVersion = '';
  const evidence: Record<string, unknown> = {};
  const query = async (target: Pool, sql: string, values: unknown[] = []) =>
    (await target.query<RowDataPacket[]>(sql, values as never))[0];
  const rows = (sql: string, values: unknown[] = []) => query(pool, sql, values);
  const one = async (sql: string, values: unknown[] = []) => (await rows(sql, values))[0];
  const count = async (sql: string) => Number((await one(sql))!.n);
  /** Formal history, publications and alert rows the trial may not create. */
  const formalRows = async () => {
    const counts: Record<string, number> = {};
    for (const table of formalTables) counts[table] = await count(`SELECT COUNT(*) AS n FROM ${table}`);
    return counts;
  };
  const zeroRows = Object.fromEntries(formalTables.map(table => [table, 0])) as Record<string, number>;
  /** Read-only snapshot of the facts this package must not change on the source database. */
  const liveSnapshot = async () => {
    const instances = await query(source, 'SELECT COUNT(*) AS n FROM database_instances');
    const servers = await query(source, 'SELECT COUNT(*) AS n FROM servers');
    const binding = await query(source,
      "SELECT resource_key, JSON_EXTRACT(payload,'$.binding.revision') AS revision FROM metric_policy_bindings WHERE resource_key = 'instance:1'");
    return {
      database_instances: Number(instances[0].n), servers: Number(servers[0].n),
      instance1_binding: binding.map(row => ({ resource_key: String(row.resource_key), revision: Number(row.revision) })),
    };
  };

  beforeAll(async () => {
    configured = parse(readFileSync(envFile!));
    vi.stubEnv('ENCRYPTION_KEY', configured.ENCRYPTION_KEY);
    // Collection enabled for this test process only; never written to a file or the application DB.
    vi.stubEnv('METRICS_COLLECTION_ENABLED', 'true');
    // READ-ONLY source connection: every statement issued through it below is a SELECT.
    source = mysql.createPool({ host: configured.DB_HOST || '127.0.0.1', port: Number(configured.DB_PORT || 3306),
      user: configured.DB_USER || 'root', password: configured.DB_PASSWORD || '', database: configured.DB_NAME, connectionLimit: 4 });
    const [row] = await query(source,
      'SELECT id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state FROM database_instances WHERE id = 1');
    target = row as typeof target;
    // The authorized managed target, pinned before any copy or connection.
    expect(target).toMatchObject({ id: 1, name: 'mysql3306', port: 3306, status: 'active', lifecycle_state: 'available' });
    const [version] = await query(source, 'SELECT VERSION() AS version');
    targetVersion = String(version.version);
    // Copy the credential into this package's disposable row only; never print or store it.
    targetPassword = decryptData(String(row.password_encrypted), configured.ENCRYPTION_KEY);
    expect(typeof targetPassword === 'string' && targetPassword.length > 0).toBe(true);

    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 20, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);

    await pool.execute(`INSERT INTO database_instances
      (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
      VALUES (1,'mysql3306',?,?,?,3306,?,?,?,?, 'active','available')`,
      [target.environment, target.db_type, target.host, target.username,
        encryptData(targetPassword, configured.ENCRYPTION_KEY), target.database_name || 'mysql', target.db_version]);

    packages = createConfigurationRegistry();
    policies = new PolicyService(new MysqlPolicyStore(() => pool), packages,
      { exists: async () => true, inventory: configurationInventory });
    service = new MetricConfigurationService(policies, packages, createTrialStore(() => pool, packages),
      createAssetCollectorAccess(), configurationReader(() => pool));
    // The trial transport reads through this asset connection; the target only receives the existing
    // collector's read-only statements.
    expect(await databaseService.addConnection(1, 'MAX238 trial items', { host: target.host, port: target.port,
      user: target.username, password: targetPassword, database: target.database_name || 'mysql', db_type: 'mysql' })).toBe(true);
  }, 180000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    await databaseService.removeConnection(1);
    await source?.end();
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
    vi.unstubAllEnvs();
  }, 60000);

  it('exposes each of the seven requested items in one existing trial response', async () => {
    const sourceBefore = await liveSnapshot();
    const rowsBefore = await formalRows();
    let trial: Trial | null = null;
    const itemProof: Record<string, unknown> = {};
    try {
      // 1. Bind a pin read from the existing recommendations; nothing is written by hand.
      const recommendations = await service.recommendations(admin, ref);
      const compatible = recommendations.packages.filter(entry => entry.compatibility === 'compatible');
      expect(compatible.length, 'instance:1 must have at least one compatible published release').toBeGreaterThan(0);
      const release = compatible[0].release;
      const pin = { id: release.package.id, version: release.package.version, digest: release.package.digest };
      expect(packages.list().some(entry => entry.package.id === pin.id
        && entry.package.version === pin.version && entry.package.digest === pin.digest)).toBe(true);
      const published = await policies.changeBinding(admin, ref, { expected_revision: 0, package: pin }, true);
      expect(published.published).toBe(true);
      const revision = published.resources[0].binding.revision;

      // 2. One existing trial through trialCurrent. activate is never called.
      trial = await service.trialCurrent(admin, ref) as Trial;
      const samples = trial.samples;
      const attempts = trial.attempts;
      const sampleKeys = [...new Set(samples.flatMap(sample => Object.keys(sample)))].sort();
      const attemptKeys = [...new Set(attempts.flatMap(attempt => Object.keys(attempt)))].sort();
      const topKeys = Object.keys(trial).sort();

      // 3. Pair each sample with the collector attempt that produced its metric, using the installed
      // package's own mappings (not a field added for this test).
      const definition = packages.list().find(entry => entry.package.id === pin.id
        && entry.package.version === pin.version && entry.package.digest === pin.digest)!.package;
      const collectorOf = new Map<string, string>();
      for (const collector of definition.collectors) for (const mapping of collector.mappings)
        collectorOf.set(`${mapping.metric.id}@${mapping.metric.semantic_version}`, collector.id);

      const duration = (attempt: Attempt) => attempt.ended_at
        ? Date.parse(attempt.ended_at) - Date.parse(attempt.started_at) : null;
      /** Read the seven items from the sample and its attempt; null source means no such field. */
      const verdicts = (sample: Sample, attempt: Attempt | undefined): Record<Item, ItemVerdict> => ({
        读取: { source: null, present: false, observed: null,
          reason: 'trial.samples/samples[].attempt 没有逐项读取结果字段；attempt.status 只是采集器级状态，不是该样本的读取结果' },
        转换: { source: null, present: false, observed: null,
          reason: '返回值没有 transform_version、预处理阶段或 raw→normalized 链路字段' },
        单位校验: { source: null, present: false, observed: null,
          reason: `samples[].unit 只是单位字符串（${sample.unit}），不是单位校验结果；返回值没有校验通过/失败字段` },
        值: { source: 'samples[].value', present: 'value' in sample, observed: sample.value,
          reason: '来自样本自身的 value' },
        时间: { source: attempt ? 'attempts[].started_at' : null, present: Boolean(attempt?.started_at),
          observed: attempt?.started_at ?? null, reason: '来自该样本对应采集 attempt 的开始时间（采集器粒度）' },
        耗时: { source: attempt ? 'attempts[].ended_at - attempts[].started_at' : null,
          present: attempt ? duration(attempt) !== null : false, observed: attempt ? duration(attempt) : null,
          reason: '只用现有 attempt 已带的可相减时间戳，没有另造计时' },
        错误: { source: attempt ? 'attempts[].error' : null, present: attempt ? 'error' in attempt : false,
          observed: attempt?.error ?? null, reason: '来自该样本对应采集 attempt 的 error（可为空）' },
      });

      const perSample: Record<string, unknown>[] = [];
      for (const sample of samples) {
        const key = `${sample.metric.id}@${sample.metric.semantic_version}`;
        const collectorId = collectorOf.get(key);
        const attempt = attempts.find(candidate => candidate.collector_id === collectorId);
        const items = verdicts(sample, attempt);
        perSample.push({ metric: sample.metric.id, collector_id: collectorId ?? null,
          attempt_status: attempt?.status ?? null, quality: sample.quality, unit: sample.unit,
          items: Object.fromEntries(itemOrder.map(item => [item, items[item]])) });
      }
      // Aggregate per item: present only when every sample's item is readable.
      for (const item of itemOrder) {
        const entries = perSample.map(entry => (entry.items as Record<string, ItemVerdict>)[item]);
        itemProof[item] = {
          present: entries.length > 0 && entries.every(entry => entry.present),
          sources: [...new Set(entries.map(entry => entry.source))],
          sample_value: entries[0]?.observed ?? null,
          reason: entries[0]?.reason ?? '没有样本可核对',
        };
      }
      const missing = itemOrder.filter(item => (itemProof[item] as { present: boolean }).present === false);

      const rowsAfter = await formalRows();
      const sourceAfter = await liveSnapshot();
      evidence.target = { id: target.id, name: target.name, host: target.host, port: target.port, server_version: targetVersion };
      evidence.pin = pin;
      evidence.trial_call = { method: 'MetricConfigurationService.trialCurrent', expected_revision: revision,
        persisted: trial.persisted, decision: trial.decision, error: trial.error ?? null,
        sample_count: samples.length, attempt_count: attempts.length };
      evidence.response_shape = { top_level_keys: topKeys, sample_keys: sampleKeys, attempt_keys: attemptKeys };
      evidence.items = itemProof;
      evidence.missing_items = missing;
      evidence.samples = samples.slice(0, 20).map(sample => ({ metric: sample.metric.id,
        value: sample.value, quality: sample.quality, unit: sample.unit }));
      evidence.attempts = attempts.map(attempt => ({ collector_id: attempt.collector_id, status: attempt.status,
        error: attempt.error, started_at: attempt.started_at, ended_at: attempt.ended_at ?? null,
        duration_ms: duration(attempt), observation_count: attempt.observation_ids.length }));
      evidence.per_sample_items = perSample;
      evidence.formal_rows = { before: rowsBefore, after: rowsAfter, zero: zeroRows };
      evidence.readonly = { pre: sourceBefore, post: sourceAfter,
        unchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter) };
      evidence.boundaries = { activate_called: false, service_ts_changed: false,
        activation_predicate_changed: false, required_metric_list_added: false,
        target_writes: 'SELECT only; no INSERT/UPDATE/DELETE on the application database',
        stop_write_copy_switch_rollback_unbind: false };

      // 4. A trial that returned nothing proves nothing.
      expect(samples.length, 'at least one sample must be returned by the existing trial').toBeGreaterThan(0);
      expect(attempts.length, 'at least one collection attempt must be returned by the existing trial').toBeGreaterThan(0);
      expect(trial.persisted, 'trial must not persist').toBe(false);
      expect(rowsAfter, 'the trial must not write formal history or alerts').toEqual(zeroRows);
      // 5. Every one of the seven items must be readable from this response. This package stops at
      // the first missing item instead of treating it as passed.
      expect(missing, `items with no field in the existing trial response: ${missing.join('、')}`).toEqual([]);
    } catch (error) {
      const caught = error as { name?: string; message?: string };
      evidence.error = { name: caught.name ?? 'Error', message: String(caught.message ?? error) };
      throw error;
    } finally {
      evidence.run = {
        branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        test: 'trial-items.mysql.test.ts',
        disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll`,
        source_selected: 'SELECT only; no INSERT/UPDATE/DELETE on the application database',
        formal_tables: [...formalTables],
      };
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    }
  }, 180000);
});
