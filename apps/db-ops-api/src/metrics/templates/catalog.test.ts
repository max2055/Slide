import { describe, expect, it } from 'vitest';
import type { MetricDefinition } from '../../contracts/metrics/index.js';
import { canonicalDefinitions, createBuiltinRegistry, builtinReleases } from '../packages/builtins.js';
import { PackageRegistry, sealRelease, type ImplementationSpec, type PackageRelease } from '../packages/model.js';
import { RegisteredCapabilityCatalog } from './catalog.js';
import { TemplateError } from './errors.js';

const pinOf = (release: PackageRelease) => ({
  id: release.package.id, version: release.package.version, digest: release.package.digest,
});
const mysql = () => pinOf(builtinReleases().find(release => release.package.id === 'mysql-basic')!);
const builtinCatalog = () => new RegisteredCapabilityCatalog(createBuiltinRegistry());

function expectTemplateError(run: () => unknown, code: string) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateError);
    expect((error as TemplateError).code).toBe(code);
    return error as TemplateError;
  }
  throw new Error(`expected ${code}`);
}

const extension = (id: string, overrides: Partial<MetricDefinition> = {}): MetricDefinition => ({
  category: 'extension', namespace: 'acme', id, semantic_version: '1.0.0', meaning: `${id} fixture semantics`,
  unit: '1', resource_type: 'server', scope: 'resource', kind: 'gauge', roles: ['diagnostic'],
  temporality: 'instant', monotonic: false, value_type: 'float64',
  dimensions: { keys: [], max_series_per_resource: 10, max_value_length: 64, overflow: 'reject' },
  aggregation: { time: ['last'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' },
  lifecycle: 'active', ...overrides,
} as MetricDefinition);

/** One isolated release whose collector maps a deprecated definition. */
function deprecatedRegistry(): PackageRegistry {
  const deprecated = extension('acme.legacy_gauge', { lifecycle: 'deprecated', replacement_id: 'acme.current_gauge' });
  const current = extension('acme.current_gauge');
  const implementation: ImplementationSpec = {
    id: 'acme.inspect.v1', method: 'ssh', resource_type: 'server',
    applicability: [{ attribute: 'os.family', values: ['linux'] }],
    outputs: [{ raw_field: 'legacy_value', definition: deprecated, input_unit: '1' }],
    permissions: ['SSH login'], discovery: 'fixed /proc fixture read',
  };
  const registry = new PackageRegistry(canonicalDefinitions, [implementation]);
  registry.install(sealRelease({
    package: {
      id: 'acme-test', version: '1.0.0', contract_version: '1.0.0', digest: `sha256:${'0'.repeat(64)}`,
      resource_type: 'server', applicability: [{ attribute: 'os.family', values: ['linux'] }],
      collectors: [{
        id: 'acme-legacy', method: 'ssh', implementation_ref: 'acme.inspect.v1', timeout_ms: 5000, estimated_cost: 'low',
        mappings: [{
          metric: { id: 'acme.legacy_gauge', semantic_version: '1.0.0' }, raw_field: 'legacy_value',
          input_unit: '1', output_unit: '1', transform_version: '1.0.0', steps: ['decode', 'normalize'],
        }],
      }],
    },
    extensions: [deprecated, current] as never, derived: [], transforms: [{ id: 'normalize', version: '1.0.0' }],
    recommendations: { interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000, max_counter_gap_ms: 300000, max_rows: 100, enabled: true },
    documentation: [{ collector_id: 'acme-legacy', permissions: ['SSH login'], discovery: 'fixed /proc fixture read' }],
  }));
  return registry;
}

describe('registered capability selection', () => {
  it('offers only metrics a collector really maps, with pin, raw field and cadence', () => {
    const candidates = builtinCatalog().candidates();
    const uptime = candidates.find(candidate => candidate.metric.id === 'db.uptime_seconds'
      && candidate.package_release.startsWith('mysql-basic@1.0.0'));
    expect(uptime).toBeDefined();
    expect(uptime!.unit).toBe('s');
    expect(uptime!.raw_field).toBe('Uptime');
    expect(uptime!.implementation_id).toBe('builtin:mysql.status.v1');
    expect(uptime!.collector_id).toBe('mysql-status');
    expect(uptime!.default_interval_ms).toBe(60000);
    expect(uptime!.package_release).toMatch(/^mysql-basic@1\.0\.0#sha256:[a-f0-9]{64}$/);
    for (const candidate of candidates) {
      expect(candidate.steps).toEqual(expect.arrayContaining(['decode', 'normalize']));
      expect(candidate.transform_version).toBe('1.0.0');
    }
  });

  it('never lists a derived metric as directly selectable and says why', () => {
    const catalog = builtinCatalog();
    expect(catalog.candidates().some(candidate => candidate.metric.id === 'mysql.queries.per_second')).toBe(false);
    const state = catalog.explain({ id: 'mysql.queries.per_second', semantic_version: '1.0.0' });
    expect(state.available).toBe(false);
    expect(state.code).toBe('TEMPLATE_METRIC_NOT_COLLECTABLE');
    expect(state.reason).toContain('derived');
    const unavailable = catalog.unavailable();
    expect(unavailable.map(entry => entry.id).sort()).toEqual(['linux.filesystem.used_ratio', 'mysql.queries.per_second']);
  });

  it('autofills unit, dimensions, cadence and the explicit implementation pin', () => {
    const candidate = builtinCatalog().autofill({
      package: mysql(), metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' },
    });
    expect(candidate.unit).toBe('s');
    expect(candidate.value_type).toBe('float64');
    expect(candidate.kind).toBe('gauge');
    expect(candidate.dimensions).toEqual([]);
    expect(candidate.implementation_id).toBe('builtin:mysql.status.v1');
    expect(candidate.default_interval_ms).toBe(60000);
    expect(candidate.display_name_default).toBe('db.uptime_seconds');
  });

  it('rejects an unknown pin, an unknown metric and a derived metric with distinct codes', () => {
    const catalog = builtinCatalog();
    expectTemplateError(() => catalog.autofill({
      package: { ...mysql(), digest: `sha256:${'f'.repeat(64)}` },
      metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' },
    }), 'TEMPLATE_PIN_NOT_FOUND');
    expectTemplateError(() => catalog.autofill({
      package: mysql(), metric: { id: 'db.not_a_metric', semantic_version: '1.0.0' },
    }), 'TEMPLATE_METRIC_UNKNOWN');
    expectTemplateError(() => catalog.autofill({
      package: mysql(), metric: { id: 'mysql.queries.per_second', semantic_version: '1.0.0' },
    }), 'TEMPLATE_METRIC_NOT_COLLECTABLE');
  });

  it('rejects a deprecated definition and never offers it', () => {
    const registry = deprecatedRegistry();
    const catalog = new RegisteredCapabilityCatalog(registry);
    const pin = pinOf(registry.list()[0]!);
    expect(catalog.candidates()).toEqual([]);
    const error = expectTemplateError(
      () => catalog.autofill({ package: pin, metric: { id: 'acme.legacy_gauge', semantic_version: '1.0.0' } }),
      'TEMPLATE_METRIC_DEPRECATED',
    );
    expect(error.message).toContain('acme.current_gauge');
    expect(catalog.explain({ id: 'acme.current_gauge', semantic_version: '1.0.0' }).code)
      .toBe('TEMPLATE_METRIC_NOT_COLLECTABLE');
  });

  it('orders candidates deterministically by release then metric', () => {
    const catalog = builtinCatalog();
    const first = catalog.candidates().map(candidate => `${candidate.package_release}|${candidate.metric.id}`);
    const second = new RegisteredCapabilityCatalog(createBuiltinRegistry())
      .candidates().map(candidate => `${candidate.package_release}|${candidate.metric.id}`);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
  });
});
