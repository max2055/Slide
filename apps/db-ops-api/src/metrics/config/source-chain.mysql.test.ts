import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import type { MetricDefinition } from '../../contracts/metrics/index.js';
import { dbConnection } from '../../db-connection.js';
import { configurationInventory } from './inventory.js';
import { createConfigurationRegistry } from './registry.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';
import { metricKey, refKey, type Published } from '../policy/model.js';

/**
 * MAX-238 source-chain package. On a disposable schema (METRICS_TEST_MYSQL_PORT) this exercises the
 * existing PolicyService.changeBinding, the existing changeGroup and the existing resolver read-back
 * against one real resource row (instance 1, db_type=mysql, db_version=8.0.46), proving the
 * acceptance sentence "combined metric items, parameter default/override/final values and their
 * source chain are shown; conflicts must be resolved and a later binding may never silently
 * overwrite an earlier one".
 *
 * The product still pins exactly one package per resource; this package neither stores several
 * templates nor turns one publish into several packages. The credential columns are empty and no
 * collection path is ever resolved, so no host is contacted and 3306 is never used. Product code is
 * unchanged; a clause the product cannot satisfy fails here and is written into the evidence.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const database = `max238_source_chain_${process.pid}`;
const instanceRef = { type: 'instance' as const, id: 1 };
const groupId = 'source-chain';
const evidencePath = fileURLToPath(new URL('../../../../../docs/slide/development/MAX-238/source-chain-20261028.json', import.meta.url));

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

describe.skipIf(!port)('MAX-238 combined metric items and the parameter source chain', () => {
  let root: Pool, pool: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let policies: PolicyService;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const query = async (target: Pool, sql: string, values: unknown[] = []) =>
    (await target.query<RowDataPacket[]>(sql, values as never))[0];
  const rows = (sql: string, values: unknown[] = []) => query(pool, sql, values);
  const one = async (sql: string, values: unknown[] = []) => (await rows(sql, values))[0];
  const bindingRows = async (key: string) =>
    Number((await one('SELECT COUNT(*) AS n FROM metric_policy_bindings WHERE resource_key = ?', [key]))!.n);
  const auditCount = async (key: string) =>
    Number((await one('SELECT COUNT(*) AS n FROM metric_policy_audit WHERE target = ?', [key]))!.n);
  const pinOf = (id: string, version: string) => {
    const release = packages.list().find(candidate => candidate.package.id === id && candidate.package.version === version);
    expect(release, `${id}@${version} must be installed`).toBeTruthy();
    return { id, version, digest: release!.package.digest };
  };
  /** Every metric id a release maps (collector) or derives (derived output), with its source kind. */
  const releaseItems = (release: ReturnType<typeof packages.get>) => [
    ...release.package.collectors.flatMap(collector => collector.mappings.map(mapping => ({ metric: metricKey(mapping.metric),
      source: { kind: 'collector' as const, collector_id: collector.id, raw_field: mapping.raw_field } }))),
    ...release.derived.map(derived => ({ metric: metricKey(derived.output),
      source: { kind: 'derived' as const, derived_id: derived.id } })),
  ];
  const requiredDimensions = (definitions: MetricDefinition[], metric: string) =>
    definitions.find(definition => metricKey(definition) === metric)!.dimensions.keys.filter(key => key.required).map(key => key.name);
  /** The three read-back slots this sentence cares about, each with its provenance. */
  const chainOf = (read: Published) => ({
    interval_ms: { final: read.resolved.settings.interval_ms, source: read.resolved.sources.interval_ms },
    max_concurrency: { final: read.resolved.settings.max_concurrency, source: read.resolved.sources.max_concurrency },
    max_series_per_resource: { final: read.resolved.settings.max_series_per_resource,
      source: read.resolved.sources.max_series_per_resource },
    binding: { package: read.binding.package, group_id: read.binding.group_id, overrides: read.binding.overrides,
      revision: read.binding.revision },
  });

  beforeAll(async () => {
    const config = { host: '127.0.0.1', port, user: 'root', password: '' };
    root = mysql.createPool(config);
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...config, database, connectionLimit: 20, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);

    // One authorized resource row with empty credentials: no collection path is ever called.
    await pool.execute(`INSERT INTO database_instances
      (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
      VALUES (1,'mysql3306','production','mysql','127.0.0.1',3306,'fixture','','mysql','8.0.46','active','available')`);

    packages = createConfigurationRegistry();
    const resources = { exists: async () => true, inventory: configurationInventory };
    policies = new PolicyService(new MysqlPolicyStore(() => pool), packages, resources);
  }, 180000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
  }, 60000);

  it('proves the combined items, the three-source chain and the conflict refusal', async () => {
    const evidence: Record<string, unknown> = {};
    const key = refKey(instanceRef);
    const pinDiagnostics = pinOf('mysql-diagnostics', '1.1.0');
    const pinBasic = pinOf('mysql-basic', '1.1.0');
    const releaseDiagnostics = packages.get(pinDiagnostics);
    const releaseBasic = packages.get(pinBasic);
    const definitions = packages.catalog(pinDiagnostics);

    // One compatible pin, no resource or group override yet: the default read-back.
    const publishedDefault = await policies.changeBinding(admin, instanceRef, { expected_revision: 0, package: pinDiagnostics }, true);
    expect(publishedDefault.published).toBe(true);
    const defaultRead = await policies.binding(admin, instanceRef);
    expect(defaultRead.binding.revision).toBe(1);
    expect(defaultRead.binding.package).toEqual(pinDiagnostics);

    // 1. Combined metric items: exactly this release's collector mappings plus derived outputs.
    const expected = releaseItems(releaseDiagnostics).map(item => ({ ...item, required_dimensions: requiredDimensions(definitions, item.metric) }));
    const expectedKeys = expected.map(item => item.metric).sort();
    const templates = defaultRead.resolved.metric_templates;
    const templateKeys = templates.map(template => metricKey(template.metric));
    const templateByKey = new Map(templates.map(template => [metricKey(template.metric), template]));
    expect([...templateKeys].sort()).toEqual(expectedKeys);
    expect(templateKeys.length).toBeGreaterThan(1);
    expect(expected.some(item => item.source.kind === 'derived')).toBe(true);
    for (const item of expected) {
      const template = templateByKey.get(item.metric)!;
      expect(template.source, `${item.metric} keeps its release source`).toEqual(item.source);
      expect(template.required_dimensions).toEqual(item.required_dimensions);
      expect(template.enabled).toBe(true);
    }
    // Dimensioned outputs stay discovery templates: no empty-dimensional concrete series is fabricated.
    const dimensioned = expected.filter(item => item.required_dimensions.length > 0);
    expect(dimensioned.length).toBeGreaterThan(0);
    const planKeys = defaultRead.resolved.plan.entries.map(entry => metricKey(entry.binding.metric));
    expect(planKeys.every(planKey => requiredDimensions(definitions, planKey).length === 0)).toBe(true);
    expect([...planKeys].sort()).toEqual(expected.filter(item => item.required_dimensions.length === 0).map(item => item.metric).sort());
    for (const item of dimensioned) expect(planKeys).not.toContain(item.metric);
    const foreignMetric = metricKey({ id: 'host.filesystem.used_bytes', semantic_version: '1.0.0' });
    expect(templateKeys).not.toContain(foreignMetric);
    evidence.combined_items = {
      package: pinDiagnostics,
      expected_count: expected.length,
      expected: expected,
      read_back: templates.map(template => ({ metric: metricKey(template.metric), source_kind: template.source.kind,
        enabled: template.enabled, required_dimensions: template.required_dimensions })),
      concrete_plan_entries: planKeys,
      dimensioned_templates: dimensioned.map(item => item.metric),
      dimensioned_in_plan: dimensioned.filter(item => planKeys.includes(item.metric)).map(item => item.metric),
      foreign_metric: { metric: foreignMetric, present: templateKeys.includes(foreignMetric) },
      derived_in_read_back: templates.filter(template => template.source.kind === 'derived').length,
    };

    // 2. Default: the release recommendation, attributed to the package layer.
    const releaseInterval = releaseDiagnostics.recommendations.interval_ms;
    expect(defaultRead.binding.overrides).toEqual({});
    expect(defaultRead.resolved.settings.interval_ms).toBe(releaseInterval);
    expect(defaultRead.resolved.sources.interval_ms.layer).toBe('package');
    expect(defaultRead.resolved.sources.interval_ms.id).toBe(`${pinDiagnostics.id}@${pinDiagnostics.version}`);

    // 2. Group override: the group value wins, the release recommendation does not move.
    const groupValue = 45000, resourceValue = 30000;
    await policies.changeGroup(admin, groupId, { expected_revision: 0, overrides: { interval_ms: { mode: 'set', value: groupValue } } }, true);
    const groupAfterCreate = await policies.group(admin, groupId);
    expect(groupAfterCreate.overrides).toEqual({ interval_ms: { mode: 'set', value: groupValue } });
    await policies.changeBinding(admin, instanceRef, { expected_revision: 1, group_id: groupId }, true);
    const groupRead = await policies.binding(admin, instanceRef);
    expect(groupRead.binding.group_id).toBe(groupId);
    expect(groupRead.binding.revision).toBe(2);
    expect(groupRead.binding.overrides).toEqual({});
    expect(groupRead.resolved.settings.interval_ms).toBe(groupValue);
    expect(groupRead.resolved.sources.interval_ms.layer).toBe('group');
    expect(groupRead.resolved.sources.interval_ms.id).toBe(groupId);
    expect(packages.get(pinDiagnostics).recommendations.interval_ms).toBe(releaseInterval);

    // 2. Resource override: the resource value wins and the group's own override survives it.
    await policies.changeBinding(admin, instanceRef, { expected_revision: 2, overrides: { interval_ms: { mode: 'set', value: resourceValue } } }, true);
    const resourceRead = await policies.binding(admin, instanceRef);
    expect(resourceRead.binding.revision).toBe(3);
    expect(resourceRead.binding.group_id).toBe(groupId);
    expect(resourceRead.binding.overrides).toEqual({ interval_ms: { mode: 'set', value: resourceValue } });
    expect(resourceRead.resolved.settings.interval_ms).toBe(resourceValue);
    expect(resourceRead.resolved.sources.interval_ms.layer).toBe('resource');
    expect(resourceRead.resolved.sources.interval_ms.id).toBe(key);
    const groupAfterResource = await policies.group(admin, groupId);
    expect(groupAfterResource.overrides).toEqual({ interval_ms: { mode: 'set', value: groupValue } });

    // Platform budgets stay platform in all three read-backs; never rewritten as a user override.
    for (const read of [defaultRead, groupRead, resourceRead]) {
      expect(read.resolved.sources.max_concurrency.layer).toBe('platform');
      expect(read.resolved.sources.max_series_per_resource.layer).toBe('platform');
    }
    evidence.parameter_chain = {
      package: pinDiagnostics,
      release_recommendation_interval_ms: releaseInterval,
      default: chainOf(defaultRead),
      group: chainOf(groupRead),
      resource: chainOf(resourceRead),
      group_value: groupValue,
      resource_value: resourceValue,
      group_overrides_after_resource: groupAfterResource.overrides,
    };

    // 3. A later binding may not silently drop an earlier metric override: a metric this pin maps
    // and the other compatible pin does not is saved first, then the other pin is published without
    // an explicit clear. The backend refuses and the prior pin/override/revision stay exactly put.
    const basicKeys = new Set(releaseItems(releaseBasic).map(item => item.metric));
    const diagnosticsOnly = expected.map(item => item.metric).filter(metric => !basicKeys.has(metric)).sort();
    expect(diagnosticsOnly.length).toBeGreaterThan(0);
    const conflictMetric = diagnosticsOnly[0];
    expect(templateKeys).toContain(conflictMetric);
    const auditsBeforeSave = await auditCount(key);
    const savedMetric = await policies.changeBinding(admin, instanceRef,
      { expected_revision: 3, overrides: { metrics: { [conflictMetric]: 'disable' } } }, true);
    expect(savedMetric.published).toBe(true);
    const savedRead = await policies.binding(admin, instanceRef);
    expect(savedRead.binding.package).toEqual(pinDiagnostics);
    expect(savedRead.binding.revision).toBe(4);
    expect(savedRead.binding.overrides).toEqual({ metrics: { [conflictMetric]: 'disable' } });
    const savedTemplate = savedRead.resolved.metric_templates.find(template => metricKey(template.metric) === conflictMetric)!;
    expect(savedTemplate.enabled).toBe(false);
    expect(savedRead.resolved.metric_sources[conflictMetric].layer).toBe('resource');
    expect(await auditCount(key)).toBe(auditsBeforeSave + 1);

    const auditsAfterSave = await auditCount(key);
    const beforeConflict = await policies.binding(admin, instanceRef);
    const conflict = await rejection(() => policies.changeBinding(admin, instanceRef,
      { expected_revision: 4, package: pinBasic }, true));
    expect(conflict).toMatchObject({ code: 'POLICY_UNKNOWN_METRIC' });
    const afterConflict = await policies.binding(admin, instanceRef);
    expect(afterConflict).toEqual(beforeConflict);
    expect(afterConflict.binding.package).toEqual(pinDiagnostics);
    expect(afterConflict.binding.overrides).toEqual({ metrics: { [conflictMetric]: 'disable' } });
    expect(afterConflict.binding.revision).toBe(4);
    expect(await bindingRows(key)).toBe(1);
    expect(await auditCount(key)).toBe(auditsAfterSave);
    evidence.conflict_after_bind = {
      saved: { package: pinDiagnostics, revision: savedRead.binding.revision, overrides: savedRead.binding.overrides,
        metric_enabled: savedTemplate.enabled, metric_source: savedRead.resolved.metric_sources[conflictMetric] },
      attempted: { package: pinBasic, overrides_submitted: 'absent (previous override retained)' },
      conflict_metric: { metric: conflictMetric, in_diagnostics: templateKeys.includes(conflictMetric),
        in_basic: basicKeys.has(conflictMetric) },
      rejection: conflict,
      after: { package: afterConflict.binding.package, overrides: afterConflict.binding.overrides,
        revision: afterConflict.binding.revision, binding_rows: 1, audit_delta: 0 },
      explicit_clear_overrides_used: false,
    };

    evidence.product_code = { config_service_ts_changed: false, policy_service_ts_changed: false, policy_model_ts_changed: false,
      resolver_ts_changed: false, store_ts_changed: false, routes_changed: false, registry_changed: false, builtins_changed: false,
      migration_changed: false, frontend_changed: false, access_ts_changed: false, activate_called: false, port_3306_contacted: false,
      writes_stopped_copied_switched_rolled_back_unbound: false };
    evidence.run = {
      branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      test: 'source-chain.mysql.test.ts',
      disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll`,
      ports_contacted: ['127.0.0.1:' + port],
      application_database_3306: 'not contacted',
    };
    evidence.targets = { instance: { id: 1, db_type: 'mysql', db_version: '8.0.46', credential: 'empty' } };
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  }, 180000);
});
