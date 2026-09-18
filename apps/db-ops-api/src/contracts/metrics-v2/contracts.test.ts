import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as schema from './index.js';
import * as f from './fixtures.js';
import { exportSchemas } from './schema.js';

const clone = <T>(v: T): T => structuredClone(v);
const config = () => ({ collections: [clone(f.collection)], metrics: [clone(f.metricBinding)], policies: [clone(f.policy)], packages: [clone(f.collectorPackage)], derived: [clone(f.derived)] });
const definition = (id = 'db.uptime_seconds') => clone(f.definitions.find(d => d.id === id)!);
const query = () => ({ resource_type: 'instance', resource_id: 'db-1', dimensions: {}, metric: f.metricBinding.metric, operation: 'mean', input: 'samples', from: '2026-09-01T00:00:00Z', to: f.fixtureTime, missing: 'preserve_null' });

describe('Metric Architecture V2 contract 1.0.0', () => {
  it('validates three resources, canonical/extension, inventory, exact derived and estimated gauge', () => {
    expect(f.resources.map(r => schema.ResourceSchema.parse(r).type)).toEqual(['instance', 'server', 'network_device']);
    schema.validateCatalog(f.definitions);
    schema.validateProfile(f.profile, f.definitions);
    schema.validateBindings(config(), f.definitions);
    schema.validateObservationBatch(f.observations, f.definitions);
    schema.validateObservation(f.rawObservation, definition());
    expect(f.observations.find(o => o.metric.id === 'mysql.cpu.heuristic_percent')).toMatchObject({ accuracy: 'estimated', production: 'measured' });
    expect(f.observations[7]).toMatchObject({ accuracy: 'exact', production: 'derived', value: { value: 0.25 } });
    schema.validateLineage(f.observations[7], f.observations.slice(1, 3));
  });
  it('exports reproducible schemas and portable synthetic fixtures', () => {
    expect(JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/contracts/schemas.json', import.meta.url), 'utf8'))).toEqual(exportSchemas());
    const fixtures = JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/contracts/fixtures.json', import.meta.url), 'utf8'));
    expect(fixtures.definitions).toEqual(f.definitions);
    expect(fixtures.observations).toEqual(f.observations);
    expect(fixtures.invalidExamples).toEqual(f.invalidExamples);
    schema.validateObservationBatch(fixtures.observations, fixtures.definitions);
    for (const r of fixtures.resources) schema.ResourceSchema.parse(r);
  });
  it.each(f.invalidExamples)('rejects portable invalid fixture $name', example => {
    const check = () => example.validator === 'definition' ? schema.validateDefinition(example.input) : example.validator === 'catalog' ? schema.validateCatalog(example.input as unknown[]) : schema.validateObservation(example.input, definition());
    if (example.expected === 'schema') expect(check).toThrow();
    else expect(check).toThrow(example.expected);
  });
  it.each(['By', 's', 'ms', '%', '1', 'bit/s', 'By/s', 'count', 'count/s'])('accepts declared unit %s', unit => {
    expect(schema.UnitSchema.safeParse(unit).success).toBe(true);
  });
  it.each(['bytes', 'GB', 'seconds', 'percentage', 'bps', 'rpm', ''])('rejects ambiguous/unknown unit %s', unit => {
    expect(schema.UnitSchema.safeParse(unit).success).toBe(false);
  });
  it('rejects kind/role/accuracy conflation', () => {
    expect(schema.MetricKindSchema.safeParse('estimated').success).toBe(false);
    expect(schema.MetricRoleSchema.safeParse('counter').success).toBe(false);
    expect(schema.MetricKindSchema.safeParse('derived').success).toBe(false);
  });
  it.each(['unit', 'meaning', 'temporality', 'scope', 'dimensions', 'aggregation'])('rejects same canonical ID with changed %s', field => {
    const a = definition(), b = clone(a); b.semantic_version = '2.0.0';
    const changes: Record<string, unknown> = { unit: 'ms', meaning: 'management agent uptime', temporality: 'cumulative', scope: 'database', dimensions: { ...a.dimensions, max_series_per_resource: 200 }, aggregation: { ...a.aggregation, min_coverage: 0.5 } };
    Object.assign(b, { [field]: changes[field] });
    expect(() => schema.validateCatalog([a, b])).toThrow();
  });
  it('allows metadata evolution but refuses duplicate exact revisions', () => {
    const d = definition(), next = { ...d, semantic_version: '1.1.0', roles: ['diagnostic'] };
    expect(schema.validateCatalog([d, next])).toHaveLength(2);
    expect(() => schema.validateCatalog([d, d])).toThrow('DUPLICATE_DEFINITION');
  });
  it('keeps aliases direct and collision-free', () => {
    const alias = { alias: 'legacy.uptime', target: f.metricBinding.metric, reason: 'same seconds and scope' };
    schema.validateCatalog(f.definitions, [alias]);
    expect(() => schema.validateCatalog(f.definitions, [alias, alias])).toThrow('ALIAS_CONFLICT');
    expect(() => schema.validateCatalog(f.definitions, [{ ...alias, alias: 'db.uptime_seconds' }])).toThrow('ALIAS_CONFLICT');
    expect(() => schema.validateCatalog(f.definitions, [{ ...alias, target: { ...alias.target, id: 'legacy.other' } }])).toThrow('ALIAS_TARGET');
  });
  it('rejects attribute metrics, identity dimensions and namespace impersonation', () => {
    expect(() => schema.validateDefinition({ ...definition(), id: 'db.version' })).toThrow('ATTRIBUTE_NOT_METRIC');
    const d = definition(); d.dimensions.keys = [{ name: 'version', meaning: 'db version', required: true }];
    expect(() => schema.validateDefinition(d)).toThrow('ATTRIBUTE_NOT_DIMENSION');
    expect(() => schema.validateDefinition({ ...definition(), category: 'extension', namespace: 'db' })).toThrow('EXTENSION_NAMESPACE');
  });
  it('freezes package and product profile revisions and rejects template column overrides', () => {
    expect(() => schema.validatePackage({ ...f.collectorPackage, applicability: [{ attribute: 'db.engine', values: ['oracle'] }] }, f.definitions, f.collectorPackage)).toThrow('IMMUTABLE_PACKAGE');
    expect(() => schema.validateProfile({ ...f.profile, columns: [{ ...f.profile.columns[0], label: 'changed' }] }, f.definitions, f.profile)).toThrow('IMMUTABLE_PROFILE');
    expect(schema.CollectorPackageSchema.safeParse({ ...f.collectorPackage, columns: [] }).success).toBe(false);
  });
  it.each([
    ['1.0.0', '1.0.0', true], ['1.2.0', '1.1.9', true], ['1.0.0', '1.1.0', false],
    ['1.0.0', '2.0.0', false], ['2.0.0', '1.0.0', false], ['1.0.1', '1.0.2', false],
  ])('reader %s writer %s compatibility %s', (reader, writer, expected) => expect(schema.acceptsVersion(reader, writer)).toBe(expected));
  it('does not accept legacy-unversioned or prerelease by guessing', () => {
    expect(() => schema.acceptsVersion('1.0.0', 'legacy-unversioned')).toThrow();
    expect(schema.VersionSchema.safeParse('1.0.0-candidate.1').success).toBe(false);
  });
  it('rejects duplicate enabled sources across packages/bindings', () => {
    const c = config(); c.collections.push({ ...f.collection, id: 'cb-other' });
    c.metrics.push({ ...f.metricBinding, id: 'mb-other', collection_binding_id: 'cb-other' });
    expect(() => schema.validateBindings(c, f.definitions)).toThrow('DUPLICATE_SOURCE');
    c.metrics[1].enabled = false; schema.validateBindings(c, f.definitions);
  });
  it('requires immutable package digest and policy revision pins', () => {
    const c = config(); c.collections[0].package.digest = `sha256:${'b'.repeat(64)}`;
    expect(() => schema.validateBindings(c, f.definitions)).toThrow('PACKAGE_PIN');
    c.collections[0] = { ...f.collection, policy_revision: 2 };
    expect(() => schema.validateBindings(c, f.definitions)).toThrow('POLICY_PIN');
  });
  it('validates collector mappings and transform order', () => {
    const p = clone(f.collectorPackage); p.collectors[0].mappings[0].output_unit = 'By';
    expect(() => schema.validatePackage(p, f.definitions)).toThrow('MAPPING_UNIT');
    p.collectors[0].mappings[0].output_unit = 's'; p.collectors[0].mappings[0].steps = ['normalize', 'decode'];
    expect(() => schema.validatePackage(p, f.definitions)).toThrow('TRANSFORM_ORDER');
    p.collectors[0].mappings[0].steps = ['decode', 'normalize']; p.collectors[0].mappings[0].input_unit = 'By';
    expect(() => schema.validatePackage(p, f.definitions)).toThrow('UNIT_CONVERSION');
  });
  it('rejects derived cycles, self-reference and invalid dimensions/units', () => {
    const d = definition(), other = { ...d, id: 'db.other_seconds' };
    const node = { ...f.derived, id: 'a', output: { id: d.id, semantic_version: '1.0.0' }, inputs: [{ id: other.id, semantic_version: '1.0.0' }], operation: 'sum' };
    expect(() => schema.validateDerived([node, { ...node, id: 'b', output: node.inputs[0], inputs: [node.output] }], [d, other])).toThrow('DERIVED_CYCLE');
    expect(() => schema.validateDerived([{ ...node, inputs: [node.output] }], [d])).toThrow('DERIVED_CYCLE');
    expect(() => schema.validateDerived([{ ...f.derived, operation: 'sum' }], f.definitions)).toThrow('DERIVED_UNIT');
  });
  it('preserves Counter64 precision and detects invalid encodings/ranges', () => {
    const d = definition('host.network.bytes_total'), o = f.sample(d.id);
    expect(schema.validateObservation(o, d).value).toEqual({ encoding: 'uint64', value: '9007199254746993' });
    for (const value of ['18446744073709551616', '-1', '01', Number('9007199254746993')]) {
      expect(() => schema.validateObservation({ ...o, value: { encoding: 'uint64', value } }, d)).toThrow();
    }
    const maximum = f.identify({ ...o, value: { encoding: 'uint64' as const, value: '18446744073709551615' } });
    schema.validateObservation(maximum, d);
    expect(() => schema.validateObservation({ ...o, counter: undefined }, d)).toThrow('COUNTER_EVIDENCE');
  });
  it('rejects unit, resource identity and semantic version conflicts', () => {
    const o = f.sample('db.uptime_seconds');
    expect(() => schema.validateObservation({ ...o, unit: 'ms' }, definition())).toThrow('UNIT_CONFLICT');
    expect(() => schema.validateObservation({ ...o, resource_type: 'server' }, definition())).toThrow('OBSERVATION_IDENTITY');
    expect(() => schema.validateObservation({ ...o, metric: { ...o.metric, semantic_version: '2.0.0' } }, definition())).toThrow('OBSERVATION_IDENTITY');
  });
  it('rejects unknown quality enumerants, missing-as-zero and invented legacy quality', () => {
    const o = f.sample('db.uptime_seconds');
    expect(() => schema.validateObservation({ ...o, quality: { status: 'perfect', reason: 'none' } }, definition())).toThrow();
    expect(() => schema.validateObservation({ ...o, quality: { status: 'unknown', reason: 'missing_input' }, value: { encoding: 'float64', value: 0 } }, definition())).toThrow('QUALITY_VALUE');
    expect(() => schema.validateObservation({ ...o, quality: { status: 'good', reason: 'legacy_unknown' } }, definition())).toThrow('QUALITY_REASON');
    schema.validateObservation(f.identify({ ...o, quality: { status: 'unknown', reason: 'legacy_unknown' }, accuracy: 'unknown', value: null }), definition());
  });
  it('propagates least-certain accuracy without treating derived as estimated', () => {
    expect(schema.propagateQuality(f.observations.slice(1, 3))).toEqual({ quality: { status: 'good', reason: 'none' }, accuracy: 'exact' });
    expect(schema.propagateQuality([f.observations[6], f.observations[0]]).accuracy).toBe('estimated');
    expect(schema.propagateQuality([])).toMatchObject({ quality: { status: 'unknown' }, accuracy: 'unknown' });
    const output = clone(f.observations[7]); const inputs = clone(f.observations.slice(1, 3));
    inputs[0].quality = { status: 'unknown', reason: 'legacy_unknown' }; inputs[0].accuracy = 'unknown';
    expect(() => schema.validateLineage(output, inputs)).toThrow('QUALITY_UPGRADE');
  });
  it('keeps capability supported after timeout and resolves enablement/freshness independently', () => {
    const before = clone(f.capability); schema.validateAttempt(f.timeoutAttempt);
    expect(schema.resolveDecision(f.collection, f.policy, f.metricBinding, f.capability, f.fixtureTime)).toBe('collect');
    expect(f.capability).toEqual(before);
    expect(schema.resolveDecision({ ...f.collection, enabled: false }, f.policy, f.metricBinding, f.capability, f.fixtureTime)).toBe('disabled');
    expect(schema.resolveDecision(f.collection, f.policy, f.metricBinding, f.capability, '2026-09-03T00:00:00Z')).toBe('capability_unknown');
    expect(schema.freshness(f.fixtureTime, '2026-09-01T00:04:00Z', 120000)).toBe('stale');
    expect(schema.freshness(null, f.fixtureTime, 120000)).toBe('unknown');
    expect(() => schema.validateAttempt({ ...f.timeoutAttempt, observation_ids: ['invented-zero'] })).toThrow('FAILED_ATTEMPT_OBSERVATIONS');
  });
  it('canonicalizes dimension order, keeps direction identity, and rejects changed retry payload', () => {
    const o = f.sample('host.network.bytes_total'), reverse = { ...o, dimensions: { direction: 'in', interface: 'fixture0' } };
    expect(schema.observationIdentity(o)).toBe(schema.observationIdentity(reverse));
    expect(schema.observationIdentity(o)).toBe(schema.observationIdentity({ ...o, observed_at: '2026-09-01T00:01:00.000Z' }));
    expect(schema.seriesIdentity(o)).not.toBe(schema.seriesIdentity({ ...o, dimensions: { ...o.dimensions, direction: 'out' } }));
    expect(schema.observationIdentity(o)).toBe(schema.observationIdentity({ ...o, stored_at: '2026-09-01T00:02:00Z' }));
    schema.validateObservationBatch([o, o], f.definitions);
    schema.validateObservationBatch([o, { ...o, observed_at: '2026-09-01T00:01:00.000Z' }], f.definitions);
    expect(schema.TimestampSchema.safeParse('2026-09-01T00:01:00.0001Z').success).toBe(false);
    expect(() => schema.validateObservationBatch([o, { ...o, value: { encoding: 'uint64', value: '2' } }], f.definitions)).toThrow('IDEMPOTENCY_PAYLOAD_CONFLICT');
  });
  it('enforces dimensions and per-resource cardinality', () => {
    const d = definition('host.network.bytes_total'), o = f.sample(d.id); d.dimensions.max_series_per_resource = 1;
    expect(() => schema.validateObservation({ ...o, dimensions: {} }, d)).toThrow('MISSING_DIMENSION');
    expect(() => schema.validateObservation({ ...o, dimensions: { ...o.dimensions, version: '8' } }, d)).toThrow('UNKNOWN_DIMENSION');
    expect(() => schema.validateObservationBatch([o, f.identify({ ...o, dimensions: { ...o.dimensions, direction: 'out' } })], [d])).toThrow('CARDINALITY_LIMIT');
  });
  it('forbids avg(p95), cumulative sum and zero fill', () => {
    schema.validateAggregation(query(), definition());
    expect(() => schema.validateAggregation({ ...query(), input: 'summary_quantile' }, definition())).toThrow('AVG_P95_FORBIDDEN');
    expect(() => schema.validateAggregation({ ...query(), missing: 'zero' }, definition())).toThrow();
    const counter = definition('host.network.bytes_total'); counter.aggregation.time.push('sum');
    expect(() => schema.validateDefinition(counter)).toThrow('SUM_CUMULATIVE_COUNTER');
  });
  it('validates histogram counts/bounds and summary non-mergeability', () => {
    const d = { ...definition(), id: 'db.latency', kind: 'histogram', temporality: 'delta', value_type: 'histogram', aggregation: { time: ['last', 'merge', 'quantile'], space: ['merge'], missing: 'preserve_null', min_coverage: 1, quantiles: 'from_merged_histogram' } };
    const parsed = schema.validateDefinition(d);
    const o = f.identify({ ...f.sample('db.uptime_seconds'), metric: { id: d.id, semantic_version: '1.0.0' }, value: { encoding: 'histogram' as const, count: '2', sum: 3, buckets: [{ upper_bound: 1, count: '1' }, { upper_bound: '+Inf' as const, count: '2' }] } });
    schema.validateObservation(o, parsed);
    expect(() => schema.validateObservation({ ...o, value: { ...o.value!, count: '3' } }, parsed)).toThrow('HISTOGRAM_TOTAL');
    expect(() => schema.validateDefinition({ ...d, kind: 'summary', value_type: 'summary' })).toThrow('SUMMARY_NON_MERGEABLE');
  });
  it('keeps raw unit conversion explicit and validates observation time and lineage', () => {
    schema.validateObservation({ ...f.rawObservation, unit: 'ms' }, definition());
    expect(() => schema.validateObservation({ ...f.observations[0], stored_at: '2026-09-01T00:00:00Z' }, definition())).toThrow('OBSERVATION_TIME');
    expect(() => schema.validateObservation({ ...f.observations[0], lineage: [{ id: f.observations[0].id, stage: 'normalized' }] }, definition())).toThrow('LINEAGE_IDENTITY');
    expect(() => schema.validateLineage(f.observations[7], [])).toThrow('LINEAGE_MISSING');
  });
  it('validates promotion without renaming history or accepting different meaning', () => {
    const e = definition('linux.filesystem.used_ratio');
    const { namespace: _namespace, ...base } = e as schema.ExtensionMetricDefinition;
    const c = { ...base, id: 'host.filesystem.used_ratio', category: 'canonical' };
    schema.validatePromotion(e, c);
    expect(() => schema.validatePromotion(e, { ...c, meaning: 'used over available capacity' })).toThrow('PROMOTION_SEMANTICS');
  });
  it('rejects cross-resource derived joins and terminal attempt rewrites', () => {
    schema.validateDerivedObservation(f.observations[7], f.observations.slice(1, 3), f.derived);
    expect(() => schema.validateDerivedObservation(f.observations[7], f.observations.slice(1, 3).map(o => ({ ...o, resource_id: 'other-host' })), f.derived)).toThrow('DERIVED_JOIN');
    const running = { ...f.timeoutAttempt, status: 'running', error: null, ended_at: undefined };
    schema.validateAttemptTransition(running, f.timeoutAttempt);
    schema.validateAttemptTransition(f.timeoutAttempt, f.timeoutAttempt);
    expect(() => schema.validateAttemptTransition(f.timeoutAttempt, { ...f.timeoutAttempt, status: 'succeeded', error: null })).toThrow('ATTEMPT_TERMINAL');
  });
  it('checks alert unit and never defaults missing to healthy', () => {
    const a = { id: 'low-uptime', revision: 1, enabled: true, metric: f.metricBinding.metric, operator: 'lt', threshold: 60, unit: 's', for_ms: 0, min_coverage: 1, accepted_quality: ['good'], allow_estimated: false, on_missing: 'unknown' };
    schema.validateAlert(a, f.definitions);
    expect(() => schema.validateAlert({ ...a, unit: 'ms' }, f.definitions)).toThrow('ALERT_UNIT_OR_KIND');
    expect(() => schema.validateAlert({ ...a, on_missing: 'healthy' }, f.definitions)).toThrow();
  });
});
