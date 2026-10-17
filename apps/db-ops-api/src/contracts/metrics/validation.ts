import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CONTRACT_VERSION, MetricDefinitionSchema, MetricAliasSchema, CoreProfileSchema, type MetricDefinition, type CoreProfile } from './definitions.js';
import { AggregationRequestSchema, CapabilitySchema, CollectionAttemptSchema, NormalizedObservationSchema, RawObservationSchema, type NormalizedObservation, type RawObservation, type Quality, type Accuracy, type MetricValue } from './observations.js';
import { AlertPolicySchema, CollectorPackageSchema, CollectionBindingSchema, CollectionPolicySchema, DerivedMetricSchema, MetricBindingSchema, type CollectionBinding, type CollectionPolicy, type MetricBinding, type DerivedMetric, type CollectorPackage } from './configuration.js';

function requireRule(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function acceptsVersion(reader: string, writer: string): boolean {
  const schema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  schema.parse(reader); schema.parse(writer);
  const r = reader.split('.').map(Number), w = writer.split('.').map(Number);
  return r[0] === w[0] && (w[1] < r[1] || (w[1] === r[1] && w[2] <= r[2]));
}
export function semanticSignature(d: MetricDefinition): string {
  // Product labels/roles/lifecycle are metadata; all meaning-bearing fields are frozen.
  return stable({ meaning: d.meaning, unit: d.unit, resource_type: d.resource_type, scope: d.scope,
    kind: d.kind, temporality: d.temporality, monotonic: d.monotonic, value_type: d.value_type,
    dimensions: d.dimensions, aggregation: d.aggregation });
}
export function validateDefinition(input: unknown): MetricDefinition {
  const d = MetricDefinitionSchema.parse(input);
  const names = d.dimensions.keys.map(k => k.name);
  requireRule(new Set(names).size === names.length, 'DUPLICATE_DIMENSION');
  requireRule(!names.some(k => ['version', 'model', 'db_version', 'firmware'].includes(k)), 'ATTRIBUTE_NOT_DIMENSION');
  requireRule(!['db.version', 'db.engine', 'device.model'].includes(d.id), 'ATTRIBUTE_NOT_METRIC');
  requireRule(d.category !== 'extension' || (d.id.startsWith(`${d.namespace}.`) && !['db', 'host', 'network'].includes(d.namespace)), 'EXTENSION_NAMESPACE');
  requireRule(d.category !== 'canonical' || /^(db|host|network)\./.test(d.id), 'CANONICAL_NAMESPACE');
  requireRule(d.lifecycle !== 'active' || d.replacement_id === undefined, 'ACTIVE_REPLACEMENT');
  requireRule(d.replacement_id !== d.id, 'SELF_REPLACEMENT');
  requireRule(d.kind === 'counter' || !d.monotonic, 'MONOTONIC_KIND');
  requireRule(d.kind !== 'gauge' || d.temporality === 'instant', 'GAUGE_TEMPORALITY');
  requireRule(d.kind === 'gauge' || d.temporality !== 'instant', 'ACCUMULATION_TEMPORALITY');
  requireRule((d.kind === 'histogram' || d.kind === 'summary') ? d.value_type === d.kind : !['histogram', 'summary'].includes(d.value_type), 'KIND_VALUE_TYPE');
  if (d.kind === 'counter') {
    requireRule(['int64', 'uint64'].includes(d.value_type), 'COUNTER_INTEGER_ENCODING');
    requireRule(!d.aggregation.time.some(op => ['mean', 'quantile', 'merge'].includes(op)), 'COUNTER_AGGREGATION');
    requireRule(d.temporality !== 'cumulative' || !d.aggregation.time.includes('sum'), 'SUM_CUMULATIVE_COUNTER');
  }
  requireRule(d.kind === 'counter' || !d.aggregation.time.includes('rate'), 'RATE_KIND');
  if (d.kind === 'summary') requireRule(d.aggregation.quantiles === 'non_mergeable' && d.aggregation.time.every(op => op === 'last') && d.aggregation.space.every(op => op === 'none'), 'SUMMARY_NON_MERGEABLE');
  if (d.kind === 'histogram') requireRule(d.aggregation.quantiles === 'from_merged_histogram' && d.aggregation.time.every(op => ['last', 'merge', 'quantile'].includes(op)) && d.aggregation.space.every(op => ['none', 'merge'].includes(op)), 'HISTOGRAM_AGGREGATION');
  if (['gauge', 'counter'].includes(d.kind)) requireRule(d.aggregation.quantiles === 'not_applicable' && !d.aggregation.time.some(op => ['merge', 'quantile'].includes(op)) && !d.aggregation.space.includes('merge'), 'SCALAR_AGGREGATION');
  return d;
}
export function validateCatalog(inputs: unknown[], aliases: unknown[] = []): MetricDefinition[] {
  const definitions = inputs.map(validateDefinition);
  const ids = new Map<string, MetricDefinition>();
  const versions = new Set<string>();
  for (const d of definitions) {
    const previous = ids.get(d.id);
    requireRule(!previous || semanticSignature(previous) === semanticSignature(d), 'IDENTITY_SEMANTIC_CONFLICT');
    requireRule(!versions.has(`${d.id}@${d.semantic_version}`), 'DUPLICATE_DEFINITION');
    versions.add(`${d.id}@${d.semantic_version}`); ids.set(d.id, d);
  }
  const aliasIds = new Set<string>();
  for (const input of aliases) {
    const a = MetricAliasSchema.parse(input);
    requireRule(!ids.has(a.alias) && !aliasIds.has(a.alias), 'ALIAS_CONFLICT');
    requireRule(versions.has(`${a.target.id}@${a.target.semantic_version}`), 'ALIAS_TARGET');
    aliasIds.add(a.alias); // Targets must be definitions, never alias chains.
  }
  for (const d of definitions) requireRule(!d.replacement_id || ids.has(d.replacement_id), 'REPLACEMENT_NOT_FOUND');
  return definitions;
}
export function validateProfile(input: unknown, definitions: MetricDefinition[], previous?: CoreProfile): CoreProfile {
  const p = CoreProfileSchema.parse(input);
  requireRule(new Set(p.columns.map(c => c.key)).size === p.columns.length, 'PROFILE_COLUMN_CONFLICT');
  for (const c of p.columns) requireRule(definitions.some(d => d.id === c.metric.id && d.semantic_version === c.metric.semantic_version && d.resource_type === p.resource_type && d.category === 'canonical'), 'PROFILE_METRIC');
  if (previous && previous.id === p.id && previous.version === p.version) requireRule(stable(previous) === stable(p), 'IMMUTABLE_PROFILE');
  return p;
}
export function validateDimensions(dimensions: Record<string, string>, d: MetricDefinition): void {
  requireRule(Object.keys(dimensions).every(k => d.dimensions.keys.some(key => key.name === k)), 'UNKNOWN_DIMENSION');
  for (const key of d.dimensions.keys) {
    const value = dimensions[key.name];
    requireRule(!key.required || value !== undefined, 'MISSING_DIMENSION');
    if (value !== undefined) requireRule(value.length > 0 && value.length <= d.dimensions.max_value_length && (!key.allowed_values || key.allowed_values.includes(value)), 'DIMENSION_VALUE');
  }
}
export function seriesIdentity(o: Pick<NormalizedObservation, 'resource_type' | 'resource_id' | 'metric' | 'dimensions'>): string {
  return stable([o.resource_type, o.resource_id, o.metric.id, o.metric.semantic_version, o.dimensions]);
}
export function observationIdentity(o: RawObservation | NormalizedObservation): string {
  // observed_at + attempt/source distinguish independent samples. stored_at never changes retry identity.
  const preimage = [o.stage, seriesIdentity(o), new Date(o.observed_at).toISOString(), o.source, o.versions,
    o.stage === 'raw' ? o.raw_field : [...o.lineage].sort((a, b) => compare(stable(a), stable(b)))];
  return `sha256:${createHash('sha256').update(stable(preimage)).digest('hex')}`;
}
function validateValue(value: MetricValue): void {
  if (value.encoding === 'int64') requireRule(BigInt(value.value) >= -(1n << 63n) && BigInt(value.value) < (1n << 63n), 'INT64_RANGE');
  if (value.encoding === 'uint64') requireRule(BigInt(value.value) < (1n << 64n), 'UINT64_RANGE');
  if (value.encoding === 'histogram' || value.encoding === 'summary') requireRule(BigInt(value.count) < (1n << 64n), 'COUNT_RANGE');
  if (value.encoding === 'summary') {
    const qs = value.quantiles.map(q => q.quantile);
    requireRule(new Set(qs).size === qs.length, 'DUPLICATE_QUANTILE');
  }
  if (value.encoding === 'histogram') {
    let bound = -Infinity, count = 0n;
    for (const bucket of value.buckets) {
      const next = bucket.upper_bound === '+Inf' ? Infinity : bucket.upper_bound;
      requireRule(next > bound && BigInt(bucket.count) >= count && BigInt(bucket.count) <= BigInt(value.count), 'HISTOGRAM_BUCKET');
      bound = next; count = BigInt(bucket.count);
    }
    requireRule(bound === Infinity && count === BigInt(value.count), 'HISTOGRAM_TOTAL');
  }
}
export function validateObservation(input: unknown, definition: MetricDefinition): RawObservation | NormalizedObservation {
  const stage = (input as { stage?: string })?.stage;
  const o = stage === 'raw' ? RawObservationSchema.parse(input) : NormalizedObservationSchema.parse(input);
  const d = validateDefinition(definition);
  requireRule(o.metric.id === d.id && o.metric.semantic_version === d.semantic_version && o.resource_type === d.resource_type, 'OBSERVATION_IDENTITY');
  requireRule(acceptsVersion(CONTRACT_VERSION, o.versions.contract), 'CONTRACT_VERSION');
  validateDimensions(o.dimensions, d);
  requireRule(Date.parse(o.observed_at) <= Date.parse(o.collected_at) && (!o.stored_at || Date.parse(o.collected_at) <= Date.parse(o.stored_at)), 'OBSERVATION_TIME');
  requireRule(o.quality.status === 'good' ? o.quality.reason === 'none' : o.quality.reason !== 'none', 'QUALITY_REASON');
  requireRule(['unknown', 'invalid'].includes(o.quality.status) ? o.value === null : o.value !== null, 'QUALITY_VALUE');
  requireRule(o.quality.reason !== 'legacy_unknown' || (o.quality.status === 'unknown' && o.accuracy === 'unknown'), 'LEGACY_QUALITY');
  requireRule(o.quality.reason !== 'precision_loss' || o.accuracy !== 'exact', 'PRECISION_ACCURACY');
  if (o.stage === 'normalized') requireRule(o.unit === d.unit, 'UNIT_CONFLICT');
  if (o.value) {
    validateValue(o.value);
    if (o.stage === 'normalized') requireRule(o.value.encoding === d.value_type, 'VALUE_ENCODING');
    if (d.monotonic && 'value' in o.value) requireRule(o.value.encoding === 'float64' ? o.value.value >= 0 : BigInt(o.value.value) >= 0n, 'NEGATIVE_MONOTONIC');
  }
  if (d.kind === 'counter' || (['histogram', 'summary'].includes(d.kind) && d.temporality === 'cumulative')) {
    requireRule(o.counter?.start_at || o.counter?.discontinuity, 'COUNTER_EVIDENCE');
    if (o.counter?.start_at) requireRule(Date.parse(o.counter.start_at) <= Date.parse(o.observed_at), 'COUNTER_TIME');
    if (o.counter?.discontinuity) requireRule(Date.parse(o.counter.discontinuity.observed_at) <= Date.parse(o.observed_at), 'COUNTER_TIME');
    if (o.counter?.bits === '32' && o.value && 'value' in o.value) requireRule(BigInt(o.value.value) < (1n << 32n), 'COUNTER_WIDTH');
  }
  if (o.stage === 'normalized') requireRule(!o.lineage.some(ref => ref.id === o.id) && new Set(o.lineage.map(ref => `${ref.stage}:${ref.id}`)).size === o.lineage.length, 'LINEAGE_IDENTITY');
  requireRule(o.id === observationIdentity(o), 'IDEMPOTENCY_ID');
  return o;
}
export function validateObservationBatch(inputs: unknown[], definitions: MetricDefinition[]): void {
  const series = new Map<string, Set<string>>(), observations = new Map<string, string>();
  for (const input of inputs) {
    const o = (input as NormalizedObservation);
    const d = definitions.find(d => d.id === o.metric?.id && d.semantic_version === o.metric?.semantic_version);
    requireRule(d, 'UNKNOWN_METRIC');
    const parsed = validateObservation(input, d);
    const key = stable([parsed.resource_type, parsed.resource_id, parsed.metric]);
    const seen = series.get(key) ?? new Set<string>(); seen.add(seriesIdentity(parsed)); series.set(key, seen);
    requireRule(seen.size <= d.dimensions.max_series_per_resource, 'CARDINALITY_LIMIT');
    const payload = stable({ ...parsed, observed_at: new Date(parsed.observed_at).toISOString(), collected_at: new Date(parsed.collected_at).toISOString(), stored_at: null });
    requireRule(!observations.has(parsed.id) || observations.get(parsed.id) === payload, 'IDEMPOTENCY_PAYLOAD_CONFLICT');
    observations.set(parsed.id, payload);
  }
}
export function propagateQuality(inputs: { quality: Quality; accuracy: Accuracy }[]): { quality: Quality; accuracy: Accuracy } {
  if (!inputs.length) return { quality: { status: 'unknown', reason: 'missing_input' }, accuracy: 'unknown' };
  const rank = { good: 0, partial: 1, unknown: 2, invalid: 3 };
  const worst = inputs.reduce((a, b) => rank[a.quality.status] >= rank[b.quality.status] ? a : b);
  return { quality: { ...worst.quality }, accuracy: inputs.some(i => i.accuracy === 'unknown') ? 'unknown' : inputs.some(i => i.accuracy === 'estimated') ? 'estimated' : 'exact' };
}
export function validateLineage(output: NormalizedObservation, inputs: (RawObservation | NormalizedObservation)[]): void {
  const refs = output.lineage.map(ref => `${ref.stage}:${ref.id}`).sort();
  requireRule(stable(refs) === stable(inputs.map(i => `${i.stage}:${i.id}`).sort()), 'LINEAGE_MISSING');
  const propagated = propagateQuality(inputs);
  const rank = { good: 0, partial: 1, unknown: 2, invalid: 3 }, accuracy = { exact: 0, estimated: 1, unknown: 2 };
  requireRule(rank[output.quality.status] >= rank[propagated.quality.status] && accuracy[output.accuracy] >= accuracy[propagated.accuracy], 'QUALITY_UPGRADE');
}
export function freshness(observedAt: string | null, now: string, staleAfterMs: number): 'fresh' | 'stale' | 'unknown' {
  if (!observedAt || !Number.isFinite(Date.parse(observedAt)) || !Number.isFinite(Date.parse(now)) || staleAfterMs <= 0 || Date.parse(observedAt) > Date.parse(now)) return 'unknown';
  return Date.parse(now) - Date.parse(observedAt) > staleAfterMs ? 'stale' : 'fresh';
}
export function validateAttempt(input: unknown): void {
  const a = CollectionAttemptSchema.parse(input);
  requireRule(a.status === 'running' ? !a.ended_at && a.error === null && a.observation_ids.length === 0 : !!a.ended_at && Date.parse(a.ended_at) >= Date.parse(a.started_at), 'ATTEMPT_TIME');
  if (a.status === 'succeeded') requireRule(a.error === null, 'ATTEMPT_ERROR');
  if (['failed', 'partial', 'cancelled'].includes(a.status)) requireRule(a.error !== null, 'ATTEMPT_ERROR');
  if (['failed', 'cancelled'].includes(a.status)) requireRule(a.observation_ids.length === 0, 'FAILED_ATTEMPT_OBSERVATIONS');
  if (a.status === 'partial') requireRule(a.observation_ids.length > 0, 'PARTIAL_ATTEMPT_OBSERVATIONS');
}
export function validateAggregation(input: unknown, d: MetricDefinition): void {
  const a = AggregationRequestSchema.parse(input);
  requireRule(a.metric.id === d.id && a.metric.semantic_version === d.semantic_version && a.resource_type === d.resource_type, 'AGGREGATION_METRIC');
  validateDimensions(a.dimensions, d);
  requireRule(Date.parse(a.from) < Date.parse(a.to), 'AGGREGATION_WINDOW');
  requireRule(d.aggregation.time.includes(a.operation), 'AGGREGATION_NOT_ALLOWED');
  requireRule(a.input !== 'summary_quantile' || a.operation === 'last', 'AVG_P95_FORBIDDEN');
  requireRule(a.input === (d.kind === 'histogram' ? 'histogram' : d.kind === 'summary' ? 'summary_quantile' : 'samples'), 'AGGREGATION_INPUT');
  requireRule(a.operation === 'quantile' ? a.quantile !== undefined : a.quantile === undefined, 'AGGREGATION_QUANTILE');
}

function lookup(ref: { id: string; semantic_version: string }, definitions: MetricDefinition[]): MetricDefinition {
  const d = definitions.find(d => d.id === ref.id && d.semantic_version === ref.semantic_version);
  requireRule(d, 'UNKNOWN_METRIC'); return d;
}
export function validateDerived(inputs: unknown[], definitions: MetricDefinition[]): DerivedMetric[] {
  const nodes = inputs.map(i => DerivedMetricSchema.parse(i));
  const outputs = new Map<string, DerivedMetric>();
  requireRule(new Set(nodes.map(n => n.id)).size === nodes.length, 'DERIVED_ID_CONFLICT');
  for (const n of nodes) {
    const output = lookup(n.output, definitions), args = n.inputs.map(i => lookup(i, definitions));
    requireRule(!outputs.has(output.id), 'DUPLICATE_SOURCE'); outputs.set(output.id, n);
    requireRule(output.kind === 'gauge' && !['histogram', 'summary'].includes(output.value_type), 'DERIVED_OUTPUT');
    requireRule(args.every(d => d.resource_type === output.resource_type && stable(d.dimensions) === stable(output.dimensions)), 'DERIVED_JOIN');
    if (['sum', 'difference'].includes(n.operation)) requireRule(args.every(d => d.unit === output.unit) && (n.operation !== 'difference' || args.length === 2), 'DERIVED_UNIT');
    if (n.operation === 'ratio') requireRule(args.length === 2 && args[0].unit === args[1].unit && ['1', '%'].includes(output.unit), 'DERIVED_UNIT');
    if (n.operation === 'scale') requireRule(args.length === 1 && args[0].unit === output.unit && n.factor !== undefined, 'DERIVED_UNIT');
    if (n.operation === 'rate') {
      const rates: Record<string, string[]> = { By: ['By/s', 'bit/s'], count: ['count/s'] };
      requireRule(args.length === 1 && args[0].kind === 'counter' && args[0].temporality === 'cumulative' && args[0].monotonic && rates[args[0].unit]?.includes(output.unit), 'DERIVED_RATE');
    }
    requireRule(n.operation === 'scale' || n.factor === undefined, 'UNEXPECTED_FACTOR');
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string): void {
    requireRule(!visiting.has(id), 'DERIVED_CYCLE');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const ref of outputs.get(id)?.inputs ?? []) if (outputs.has(ref.id)) visit(ref.id);
    visiting.delete(id); visited.add(id);
  }
  for (const id of outputs.keys()) visit(id);
  return nodes;
}
export function validatePackage(input: unknown, definitions: MetricDefinition[], previous?: CollectorPackage): CollectorPackage {
  const p = CollectorPackageSchema.parse(input);
  requireRule(acceptsVersion(CONTRACT_VERSION, p.contract_version), 'CONTRACT_VERSION');
  requireRule(new Set(p.collectors.map(c => c.id)).size === p.collectors.length, 'COLLECTOR_ID_CONFLICT');
  for (const c of p.collectors) {
    requireRule(new Set(c.mappings.map(m => m.metric.id)).size === c.mappings.length, 'DUPLICATE_SOURCE');
    for (const m of c.mappings) {
      const d = lookup(m.metric, definitions);
      requireRule(d.resource_type === p.resource_type && d.unit === m.output_unit, 'MAPPING_UNIT');
      const order = ['decode', 'unit_convert', 'counter_delta', 'rate', 'derive', 'normalize'];
      requireRule(m.steps[0] === 'decode' && m.steps.at(-1) === 'normalize' && m.steps.every((s, i) => i === 0 || order.indexOf(s) > order.indexOf(m.steps[i - 1])), 'TRANSFORM_ORDER');
      requireRule(!m.steps.includes('rate') || m.steps.includes('counter_delta'), 'RATE_WITHOUT_DELTA');
      const compatible = m.input_unit === m.output_unit || (m.steps.includes('unit_convert') && ['s:ms', 'ms:s'].includes(`${m.input_unit}:${m.output_unit}`)) || (m.steps.includes('rate') && ['By:By/s', 'By:bit/s', 'count:count/s'].includes(`${m.input_unit}:${m.output_unit}`));
      requireRule(compatible, 'UNIT_CONVERSION');
    }
  }
  if (previous && previous.id === p.id && previous.version === p.version) requireRule(stable(p) === stable(previous), 'IMMUTABLE_PACKAGE');
  return p;
}
export function validateBindings(input: { collections: unknown[]; metrics: unknown[]; policies: unknown[]; packages: unknown[]; derived: unknown[] }, definitions: MetricDefinition[]): void {
  const packages = input.packages.map(p => validatePackage(p, definitions));
  const policies = input.policies.map(p => CollectionPolicySchema.parse(p));
  const collections = input.collections.map(c => CollectionBindingSchema.parse(c));
  const metrics = input.metrics.map(m => MetricBindingSchema.parse(m));
  const derived = validateDerived(input.derived, definitions);
  for (const list of [collections, metrics, policies]) requireRule(new Set(list.map(x => x.id)).size === list.length, 'CONFIG_ID_CONFLICT');
  for (const p of policies) requireRule(p.timeout_ms <= p.interval_ms && p.stale_after_ms >= p.interval_ms && p.max_counter_gap_ms >= p.interval_ms, 'POLICY_TIMING');
  for (const c of collections) {
    requireRule(packages.some(p => p.id === c.package.id && p.version === c.package.version && p.digest === c.package.digest && p.resource_type === c.resource_type), 'PACKAGE_PIN');
    requireRule(policies.some(p => p.id === c.policy_id && p.revision === c.policy_revision), 'POLICY_PIN');
  }
  const sources = new Set<string>();
  for (const m of metrics) {
    const c = collections.find(c => c.id === m.collection_binding_id), d = lookup(m.metric, definitions);
    requireRule(c && c.resource_id === m.resource_id && c.resource_type === d.resource_type, 'BINDING_RESOURCE');
    validateDimensions(m.dimensions, d);
    const key = stable([m.resource_id, d.resource_type, m.metric, m.dimensions]);
    if (m.enabled && c.enabled) { requireRule(!sources.has(key), 'DUPLICATE_SOURCE'); sources.add(key); }
    const p = packages.find(p => p.id === c.package.id && p.version === c.package.version)!;
    const source = m.source;
    if (source.kind === 'collector') requireRule(p.collectors.some(col => col.id === source.collector_id && col.mappings.some(map => map.raw_field === source.raw_field && map.metric.id === m.metric.id && map.metric.semantic_version === m.metric.semantic_version)), 'BINDING_SOURCE');
    else requireRule(derived.some(n => n.id === source.derived_id && n.output.id === m.metric.id && n.output.semantic_version === m.metric.semantic_version), 'BINDING_SOURCE');
  }
}
export function resolveDecision(collection: CollectionBinding, policy: CollectionPolicy, metric: MetricBinding, input: unknown, at: string): 'collect' | 'derive' | 'disabled' | 'unsupported' | 'capability_unknown' {
  const capability = CapabilitySchema.parse(input);
  requireRule(capability.resource_id === metric.resource_id && stable(capability.metric) === stable(metric.metric), 'CAPABILITY_IDENTITY');
  requireRule(Date.parse(capability.evaluated_at) < Date.parse(capability.valid_until), 'CAPABILITY_TIME');
  if (!collection.enabled || !policy.enabled || !metric.enabled) return 'disabled';
  if (Date.parse(at) < Date.parse(capability.evaluated_at) || Date.parse(at) >= Date.parse(capability.valid_until)) return 'capability_unknown';
  if (capability.status === 'unknown') return 'capability_unknown';
  if (capability.status === 'unsupported') return 'unsupported';
  return metric.source.kind === 'derived' ? 'derive' : 'collect';
}
export function validateAlert(input: unknown, definitions: MetricDefinition[]): void {
  const a = AlertPolicySchema.parse(input), d = lookup(a.metric, definitions);
  requireRule(a.unit === d.unit && !['histogram', 'summary'].includes(d.kind), 'ALERT_UNIT_OR_KIND');
}

/** Freeze-time promotion check; rewriting stored series or their history is never implied. */
export function validatePromotion(extension: unknown, canonical: unknown): void {
  const from = validateDefinition(extension), to = validateDefinition(canonical);
  requireRule(from.category === 'extension' && to.category === 'canonical', 'PROMOTION_CATEGORY');
  requireRule(semanticSignature(from) === semanticSignature(to), 'PROMOTION_SEMANTICS');
}

/** Checks a derived output against its declared input identities, not its arithmetic implementation. */
export function validateDerivedObservation(output: NormalizedObservation, inputs: NormalizedObservation[], node: DerivedMetric): void {
  requireRule(output.production === 'derived' && stable(output.metric) === stable(node.output), 'DERIVED_OUTPUT_IDENTITY');
  requireRule(stable(inputs.map(i => stable(i.metric)).sort()) === stable(node.inputs.map(ref => stable(ref)).sort()), 'DERIVED_INPUTS');
  requireRule(inputs.every(i => i.resource_id === output.resource_id && i.resource_type === output.resource_type && stable(i.dimensions) === stable(output.dimensions)), 'DERIVED_JOIN');
  requireRule(inputs.every(i => Date.parse(i.collected_at) <= Date.parse(output.collected_at)), 'DERIVED_COLLECTION_TIME');
  const times = inputs.map(i => Date.parse(i.observed_at));
  requireRule(Math.max(...times) - Math.min(...times) <= node.max_skew_ms, 'DERIVED_SKEW');
  requireRule(Date.parse(output.observed_at) === Math.max(...times), 'DERIVED_TIME');
  validateLineage(output, inputs);
}

export function validateAttemptTransition(previous: unknown, next: unknown): void {
  validateAttempt(previous); validateAttempt(next);
  const a = CollectionAttemptSchema.parse(previous), b = CollectionAttemptSchema.parse(next);
  requireRule(a.id === b.id && a.resource_id === b.resource_id && a.binding_id === b.binding_id && a.collector_id === b.collector_id && a.config_revision === b.config_revision && a.started_at === b.started_at, 'ATTEMPT_IDENTITY');
  requireRule(a.status === 'running' || stable(a) === stable(b), 'ATTEMPT_TERMINAL');
}
