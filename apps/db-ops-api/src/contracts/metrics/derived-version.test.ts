import { describe, expect, it } from 'vitest';
import { collectorPackage, definitions, derived, identify, sample } from './fixtures.js';
import { validateCatalog, validateDerived, validateDerivedObservation, validateObservation, type DerivedMetric, type MetricDefinition } from './index.js';
import { executeDerived } from '../../metrics/derived.js';
import { PackageRegistry, sealRelease } from '../../metrics/packages/model.js';

const uptime = definitions.find(d => d.id === 'db.uptime_seconds')!;
const ref = (semantic_version: string, id = uptime.id) => ({ id, semantic_version });
const catalog = ['1.0.0', '1.1.0', '1.2.0'].map(semantic_version => ({ ...uptime, semantic_version }));
function scale(output: string, input: string, id = `scale-${output}`): DerivedMetric {
  return { ...derived, id, output: ref(output), inputs: [ref(input)], operation: 'scale', factor: 1 };
}

// #506 / MAX-617: DAG identity must match MetricRef identity in the execution and package entry points.
describe('versioned derived metric DAG', () => {
  it.each([['1.1.0', '1.0.0'], ['1.0.0', '1.1.0']])('accepts acyclic %s output from %s input', (output, input) => {
    const nodes = [scale(output, input)];
    expect(validateDerived(nodes, validateCatalog(catalog))).toEqual(nodes);
  });

  it('allows multiple output versions and follows their exact edges in either declaration order', () => {
    const nodes = [scale('1.2.0', '1.1.0'), scale('1.1.0', '1.0.0')];
    expect(validateDerived(nodes, catalog)).toEqual(nodes);
    expect(validateDerived([...nodes].reverse(), catalog)).toEqual([...nodes].reverse());
  });

  it('allows separate output versions fed by the same external input', () => {
    const nodes = [scale('1.1.0', '1.0.0'), scale('1.2.0', '1.0.0')];
    expect(validateDerived(nodes, catalog)).toEqual(nodes);
  });

  it('rejects duplicate sources for the same complete output reference', () => {
    expect(() => validateDerived([scale('1.1.0', '1.0.0'), scale('1.1.0', '1.0.0', 'duplicate')], catalog)).toThrow('DUPLICATE_SOURCE');
  });

  it('keeps derived node IDs unique across different output versions', () => {
    expect(() => validateDerived([scale('1.1.0', '1.0.0', 'same'), scale('1.2.0', '1.0.0', 'same')], catalog)).toThrow('DERIVED_ID_CONFLICT');
  });

  it.each(['1.0.0', '1.1.0'])('rejects a same-version self-loop at %s', version => {
    expect(() => validateDerived([scale(version, version)], catalog)).toThrow('DERIVED_CYCLE');
  });

  it('rejects a real cycle between versions of the same metric', () => {
    expect(() => validateDerived([scale('1.1.0', '1.0.0'), scale('1.0.0', '1.1.0')], catalog)).toThrow('DERIVED_CYCLE');
  });

  it('rejects a real cycle across metric IDs and versions', () => {
    const other = { ...uptime, id: 'db.other_seconds', semantic_version: '1.2.0' };
    const a = scale('1.1.0', '1.0.0'); a.inputs = [ref('1.2.0', other.id)];
    const b = scale('1.2.0', '1.1.0', 'other'); b.output = ref('1.2.0', other.id);
    expect(() => validateDerived([a, b], [...catalog, other])).toThrow('DERIVED_CYCLE');
  });

  it('does not resolve an unknown version from another version of the same ID', () => {
    expect(() => validateDerived([scale('1.1.0', '9.0.0')], catalog)).toThrow('UNKNOWN_METRIC');
    expect(() => validateDerived([scale('9.0.0', '1.0.0')], catalog)).toThrow('UNKNOWN_METRIC');
  });

  it('preserves catalog semantic identity and derived unit/join checks', () => {
    expect(() => validateCatalog([uptime, { ...uptime, semantic_version: '1.1.0', meaning: 'different uptime' }])).toThrow('IDENTITY_SEMANTIC_CONFLICT');
    const other: MetricDefinition = { ...uptime, id: 'db.other_seconds' };
    const node = scale('1.1.0', '1.0.0'); node.inputs = [ref('1.0.0', other.id)];
    expect(() => validateDerived([node], [...catalog, { ...other, unit: 'ms' }])).toThrow('DERIVED_UNIT');
    expect(() => validateDerived([node], [...catalog, { ...other, resource_type: 'server' }])).toThrow('DERIVED_JOIN');
    expect(() => validateDerived([node], [...catalog, { ...other, dimensions: { ...other.dimensions, max_series_per_resource: 2 } }])).toThrow('DERIVED_JOIN');
  });

  it('executes an out-of-order multi-version chain with values and lineage intact', () => {
    const nodes = [scale('1.2.0', '1.1.0'), scale('1.1.0', '1.0.0')];
    const anchor = sample(uptime.id);
    const execution = {
      anchor, context: { now: anchor.stored_at!, stale_after_ms: 120000 }, counter: { max_gap_ms: 300000 },
      targets: Object.fromEntries(nodes.map(n => [n.id, {
        source: { ...anchor.source, collector_id: `derived:${n.id}` }, versions: anchor.versions,
      }])),
    };
    const input = {
      observation: anchor, window: { from: anchor.observed_at, to: anchor.observed_at },
      freshness: 'fresh' as const, input_provenance: [],
    };
    const result = executeDerived(nodes, catalog, [input], execution);
    expect(result.outputs.map(o => o.observation.metric)).toEqual([ref('1.1.0'), ref('1.2.0')]);
    let previous = anchor;
    for (const [i, output] of result.outputs.entries()) {
      expect(output.observation.value).toEqual(anchor.value);
      expect(output.observation).toMatchObject({ production: 'derived', accuracy: 'exact', quality: { status: 'good', reason: 'none' } });
      validateObservation(output.observation, catalog[i + 1]);
      validateDerivedObservation(output.observation, [previous], nodes[1 - i]);
      previous = output.observation;
    }
    const duplicate = { ...input, observation: identify({ ...anchor, metric: ref('1.1.0') }) };
    expect(() => executeDerived(nodes, catalog, [input, duplicate], execution)).toThrow('DUPLICATE_SOURCE');
    expect(() => executeDerived([scale('1.1.0', '1.1.0')], catalog, [input], execution)).toThrow('DERIVED_CYCLE');
  });

  it('installs a sealed package with multiple derived versions through PackageRegistry.install', () => {
    const extensions = catalog.map(d => ({ ...d, id: 'test.uptime_seconds', category: 'extension' as const, namespace: 'test' }));
    const nodes = [scale('1.2.0', '1.1.0'), scale('1.1.0', '1.0.0')].map(n => ({
      ...n, output: { ...n.output, id: extensions[0].id }, inputs: n.inputs.map(r => ({ ...r, id: extensions[0].id })),
    }));
    const collector = structuredClone(collectorPackage.collectors[0]);
    collector.mappings[0].metric = ref('1.0.0', extensions[0].id);
    const registry = new PackageRegistry([], [{
      id: collector.implementation_ref, method: collector.method, resource_type: 'instance',
      applicability: collectorPackage.applicability,
      outputs: [{ raw_field: 'Uptime', definition: extensions[0], input_unit: 's' }],
      permissions: ['read uptime'], discovery: 'synthetic uptime field',
    }]);
    const release = sealRelease({
      package: { ...collectorPackage, collectors: [collector] }, extensions, derived: nodes,
      transforms: [{ id: 'normalize', version: '1.0.0' }, { id: 'derive', version: '1.0.0' }],
      recommendations: { interval_ms: 60000, timeout_ms: 1000, stale_after_ms: 120000, max_counter_gap_ms: 300000, max_rows: 10, enabled: true },
      documentation: [{ collector_id: collector.id, permissions: ['read uptime'], discovery: 'synthetic uptime field' }],
    });
    expect(registry.install(release)).toEqual(release);
    expect(registry.get(release.package).derived).toEqual(nodes);
    const invalid = structuredClone(release); invalid.package.version = '1.1.0';
    invalid.derived[0].inputs = [invalid.derived[0].output];
    expect(() => registry.install(sealRelease(invalid))).toThrow('DERIVED_CYCLE');
  });
});
