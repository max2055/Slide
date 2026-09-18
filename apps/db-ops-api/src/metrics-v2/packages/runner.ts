import {
  CapabilitySchema, ResourceSchema, TimestampSchema, observationIdentity, validateAttempt, validateObservationBatch,
  type Capability, type CollectionAttempt, type RawObservation, type Resource,
} from '../../contracts/metrics-v2/index.js';
import { normalize, executeDerived, type Computation, type CounterState } from '../index.js';
import { PackageRegistry, stable, type Selection } from './model.js';
import { AdapterError, collectFixed, classifyError, type DriverEvidence, type Transport } from './adapters.js';

export interface PackageExecution {
  resource: Resource;
  binding_id: string;
  attempt_id: string;
  config_revision: number;
  observed_at: string;
  evidence: DriverEvidence;
  /** Resolves a reference into already authorized, resource-scoped transports; no credential storage here. */
  resolve: (reference: string, resource: Resource, method: Transport['method']) => Promise<Transport>;
  clock?: () => string;
  previous_capabilities?: Capability[];
  states?: ReadonlyMap<string, CounterState>;
}
export interface PackageResult {
  observations: Computation[];
  attempts: CollectionAttempt[];
  capabilities: Capability[];
  states: Map<string, CounterState>;
  decision: 'attempted' | 'disabled' | 'unsupported' | 'capability_unknown';
}

/** Single invocation only: callers own scheduling, credential authorization, CAS/state commits and persistence. */
export async function runPackage(registry: PackageRegistry, input: Selection, execution: PackageExecution): Promise<PackageResult> {
  const { selection, release, settings } = registry.select(input);
  const resource = ResourceSchema.parse(execution.resource), p = release.package;
  const at = TimestampSchema.parse(execution.observed_at), clock = execution.clock ?? (() => new Date().toISOString());
  const definitions = registry.catalog(selection.package);
  const result: PackageResult = { observations: [], attempts: [], capabilities: [], states: new Map(execution.states), decision: 'attempted' };
  if (!settings.enabled) return { ...result, decision: 'disabled' };
  let applicable: Capability['status'] = resource.type === p.resource_type ? 'supported' : 'unsupported';
  const basis: Capability['basis'] = [{ kind: 'resource', evidence: `resource_type:${resource.type};required:${p.resource_type}` }];
  for (const condition of p.applicability) {
    const value = resource.attributes[condition.attribute]?.value;
    // Version family is an attribute, never part of metric identity or dimensions.
    const normalized = condition.attribute === 'db.version' && typeof value === 'string' ? value.match(/^(\d+\.\d+)(?:\.|$)/)?.[1] : value === undefined ? undefined : String(value).toLowerCase();
    const matched = normalized !== undefined && condition.values.includes(normalized);
    basis.push({ kind: condition.attribute.includes('version') ? 'version' : 'resource', evidence: `${condition.attribute}:${value === undefined ? 'absent' : matched ? 'matched' : 'not_supported'};allowed:${condition.values.join(',')}` });
    if (value !== undefined && !matched) applicable = 'unsupported';
    else if (value === undefined && applicable !== 'unsupported') applicable = 'unknown';
  }
  const until = new Date(Date.parse(at) + settings.stale_after_ms).toISOString();
  const capability = (metric: Capability['metric'], method: Capability['method'], status: Capability['status'], evidence: Capability['basis']): Capability => CapabilitySchema.parse({
    resource_id: resource.id, metric, method, status, basis: evidence, evaluated_at: at, valid_until: until,
  });
  if (applicable !== 'supported') {
    for (const collector of p.collectors) for (const mapping of collector.mappings) result.capabilities.push(capability(mapping.metric, collector.method, applicable, basis));
    for (const node of release.derived) result.capabilities.push(capability(node.output, 'derived', applicable, basis));
    return { ...result, decision: applicable === 'unsupported' ? 'unsupported' : 'capability_unknown' };
  }
  for (const collector of p.collectors) {
    const attempt: CollectionAttempt = { id: `${execution.attempt_id}:${collector.id}`, resource_id: resource.id, binding_id: execution.binding_id,
      collector_id: collector.id, config_revision: execution.config_revision, started_at: at, status: 'running', error: null, observation_ids: [] };
    validateAttempt(attempt);
    let error: CollectionAttempt['error'] = null;
    let outputs: Computation[] = [];
    let transport: Transport;
    try { transport = await execution.resolve(selection.credential_ref, resource, collector.method); }
    catch (failure) { error = classifyError(failure); }
    if (!error) {
      try {
        const rows = await collectFixed(collector.implementation_ref, transport!, execution.evidence, Math.min(settings.timeout_ms, collector.timeout_ms), settings.max_rows);
        if (rows.length > settings.max_rows || new Set(rows.map(r => stable(r.dimensions))).size !== rows.length) throw new Error('DUPLICATE_OR_EXCESS_ROWS');
        const collectedAt = TimestampSchema.parse(clock());
        for (const row of rows) for (const mapping of collector.mappings) {
          const definition = definitions.find(d => d.id === mapping.metric.id && d.semantic_version === mapping.metric.semantic_version)!;
          const value = row.fields[mapping.raw_field];
          if (value === undefined) throw new Error('MISSING_FIELD');
          const raw: RawObservation = { id: 'pending', stage: 'raw', resource_type: resource.type, resource_id: resource.id,
            metric: mapping.metric, dimensions: row.dimensions, observed_at: at, collected_at: collectedAt, stored_at: null,
            unit: mapping.input_unit, value, raw_field: mapping.raw_field,
            quality: value === null ? { status: 'unknown', reason: 'source_error' } : { status: 'good', reason: 'none' }, accuracy: value === null ? 'unknown' : 'exact', production: 'measured',
            source: { binding_id: execution.binding_id, metric_binding_id: `${execution.binding_id}:${mapping.metric.id}`, collector_id: collector.id, attempt_id: attempt.id },
            versions: { contract: p.contract_version, package_id: p.id, package_version: p.version, transform_version: mapping.transform_version, config_revision: execution.config_revision },
            ...(definition.kind === 'counter' ? { counter: row.counter } : {}),
          };
          raw.id = observationIdentity(raw);
          outputs.push(normalize(raw, definition, { now: collectedAt, stale_after_ms: settings.stale_after_ms }));
        }
        validateObservationBatch(outputs.map(o => o.observation), definitions);
      } catch (failure) {
        // Known transport errors retain their category. Validation failures are parse failures.
        error = failure instanceof AdapterError ? failure.code : 'parse_error';
        outputs = [];
      }
    }
    attempt.ended_at = TimestampSchema.parse(clock());
    attempt.error = error; attempt.status = error ? 'failed' : 'succeeded';
    attempt.observation_ids = outputs.map(o => o.observation.id);
    validateAttempt(attempt); result.attempts.push(attempt); result.observations.push(...outputs);
    for (const mapping of collector.mappings) {
      const previous = execution.previous_capabilities?.find(c => c.resource_id === resource.id && stable(c.metric) === stable(mapping.metric) && c.method === collector.method);
      if (error === 'timeout' && previous && Date.parse(previous.evaluated_at) <= Date.parse(at) && Date.parse(previous.valid_until) > Date.parse(at)) {
        result.capabilities.push(CapabilitySchema.parse(previous));
      } else result.capabilities.push(capability(mapping.metric, collector.method, error ? 'unknown' : 'supported', [...basis,
        { kind: error === 'permission_denied' || !error ? 'permission' : 'method', evidence: error ?? 'fixed_read_succeeded' }]));
    }
  }
  const groups = new Map<string, Computation[]>();
  for (const observation of result.observations) {
    const key = stable(observation.observation.dimensions), group = groups.get(key) ?? [];
    group.push(observation); groups.set(key, group);
  }
  for (const inputs of groups.values()) {
    if (!release.derived.length) break;
    const anchor = inputs[0].observation;
    const targets = Object.fromEntries(release.derived.map(d => [d.id, {
      source: { ...anchor.source, collector_id: `derived:${d.id}`, metric_binding_id: `${execution.binding_id}:${d.output.id}` },
      versions: { ...anchor.versions, transform_version: d.transform_version },
    }]));
    const derived = executeDerived(release.derived, definitions, inputs, { anchor, context: { now: clock(), stale_after_ms: settings.stale_after_ms },
      targets, counter: { max_gap_ms: settings.max_counter_gap_ms }, states: result.states });
    result.observations.push(...derived.outputs); result.states = derived.states;
  }
  for (const node of release.derived) {
    const dependencies = node.inputs.map(ref => result.capabilities.find(c => stable(c.metric) === stable(ref)));
    result.capabilities.push(capability(node.output, 'derived', dependencies.every(d => d?.status === 'supported') ? 'supported' : 'unknown',
      [{ kind: 'method', evidence: 'public_processor:derive@1.0.0' }, ...dependencies.flatMap(d => d?.basis ?? [])]));
  }
  validateObservationBatch(result.observations.map(o => o.observation), definitions);
  return result;
}
