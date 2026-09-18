import { createHash } from 'node:crypto';
import {
  CapabilitySchema, ResourceSchema, TimestampSchema, observationIdentity, validateAttempt, validateObservationBatch,
  type Capability, type CollectionAttempt, type RawObservation, type Resource,
} from '../../contracts/metrics-v2/index.js';
import { normalize, executeDerived, type Computation, type CounterState } from '../index.js';
import { PackageRegistry, stable, type Selection } from './model.js';
import { AdapterError, collectFixed, classifyError, type DecodedRow, type DriverEvidence, type Transport } from './adapters.js';

const metricBindingId = (binding: string, metric: string, dimensions: Record<string, string>) =>
  `${binding}:${metric}${Object.keys(dimensions).length ? ':' + createHash('sha256').update(stable(dimensions)).digest('hex').slice(0, 16) : ''}`;

export interface PackageExecution {
  signal?: AbortSignal;
  /** Internal compiled plan selection; absent preserves the standalone package API. */
  collector_ids?: string[];
  metric_keys?: string[];
  /** Trusted adapter seam for isolated collector tests; never populated from configuration. */
  collect?: typeof collectFixed;
  before_request?: () => Promise<void>;
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
  execution.signal?.throwIfAborted();
  const { selection, release, settings } = registry.select(input);
  const resource = ResourceSchema.parse(execution.resource), p = release.package;
  const at = TimestampSchema.parse(execution.observed_at), clock = execution.clock ?? (() => new Date().toISOString());
  const definitions = registry.catalog(selection.package);
  const selected = (metric: { id: string; semantic_version: string }) => !execution.metric_keys || execution.metric_keys.includes(`${metric.id}@${metric.semantic_version}`);
  release.derived = release.derived.filter(d => selected(d.output));
  p.collectors = p.collectors.filter(c => !execution.collector_ids || execution.collector_ids.includes(c.id));
  for (const c of p.collectors) c.mappings = c.mappings.filter(m => selected(m.metric));
  const shared = new Map<string, Promise<DecodedRow[]>>();
  const check = async () => { execution.signal?.throwIfAborted(); await execution.before_request?.(); execution.signal?.throwIfAborted(); };
  // Guard every transport call, including adapters that issue several reads.
  const guarded = (t: Transport): Transport => {
    if (!execution.signal && !execution.before_request) return t;
    if (t.method === 'sql') return { method: 'sql', pool: { query: async options => { await check(); return t.pool.query(options); } } };
    if (t.method === 'snmp') return { method: 'snmp', table: async (root, timeout) => { await check(); return t.table(root, timeout); } };
    return { ...t, pool: { execCommands: async (client, commands, options) => {
      const results = [];
      for (const command of commands) { await check(); results.push(...await t.pool.execCommands(client, [command], options)); }
      return results;
    } } };
  };
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
    await check();
    const attempt: CollectionAttempt = { id: `${execution.attempt_id}:${collector.id}`, resource_id: resource.id, binding_id: execution.binding_id,
      collector_id: collector.id, config_revision: execution.config_revision, started_at: at, status: 'running', error: null, observation_ids: [] };
    validateAttempt(attempt);
    let error: CollectionAttempt['error'] = null;
    let outputs: Computation[] = [];
    let transport: Transport;
    try { transport = guarded(await execution.resolve(selection.credential_ref, resource, collector.method)); await check(); }
    catch (failure) { error = classifyError(failure); }
    execution.signal?.throwIfAborted();
    if (!error) {
      try {
        const key = `${collector.method}:${collector.implementation_ref}`;
        const timeout = Math.min(settings.timeout_ms, ...p.collectors.filter(c => `${c.method}:${c.implementation_ref}` === key).map(c => c.timeout_ms));
        if (!shared.has(key)) shared.set(key, (execution.collect ?? collectFixed)(collector.implementation_ref, transport!, execution.evidence, timeout, settings.max_rows));
        const rows = await shared.get(key)!;
        execution.signal?.throwIfAborted();
        if (rows.length > settings.max_rows || new Set(rows.map(r => stable(r.dimensions))).size !== rows.length) throw new Error('DUPLICATE_OR_EXCESS_ROWS');
        const collectedAt = TimestampSchema.parse(clock());
        for (const row of rows) for (const mapping of collector.mappings) {
          try {
            const definition = definitions.find(d => d.id === mapping.metric.id && d.semantic_version === mapping.metric.semantic_version)!;
            const value = row.fields[mapping.raw_field];
            if (value === undefined) throw new Error('MISSING_FIELD');
            const raw: RawObservation = { id: 'pending', stage: 'raw', resource_type: resource.type, resource_id: resource.id,
              metric: mapping.metric, dimensions: row.dimensions, observed_at: at, collected_at: collectedAt, stored_at: null,
              unit: mapping.input_unit, value, raw_field: mapping.raw_field,
              quality: value === null ? { status: 'unknown', reason: 'source_error' } : { status: 'good', reason: 'none' }, accuracy: value === null ? 'unknown' : row.accuracy?.[mapping.raw_field] ?? 'exact', production: 'measured',
              source: { binding_id: execution.binding_id, metric_binding_id: metricBindingId(execution.binding_id, mapping.metric.id, row.dimensions), collector_id: collector.id, attempt_id: attempt.id },
              versions: { contract: p.contract_version, package_id: p.id, package_version: p.version, transform_version: mapping.transform_version, config_revision: execution.config_revision },
              ...(definition.kind === 'counter' ? { counter: row.counter } : {}),
            };
            raw.id = observationIdentity(raw);
            const output = normalize(raw, definition, { now: collectedAt, stale_after_ms: settings.stale_after_ms });
            validateObservationBatch([output.observation], definitions);
            outputs.push(output);
          } catch { error = 'parse_error'; }
        }
        validateObservationBatch(outputs.map(o => o.observation), definitions);
      } catch (failure) {
        // Known transport errors retain their category. Validation failures are parse failures.
        error = failure instanceof AdapterError ? failure.code : 'parse_error';
        outputs = [];
      }
    }
    execution.signal?.throwIfAborted();
    attempt.ended_at = TimestampSchema.parse(clock());
    attempt.error = error; attempt.status = error ? outputs.length ? 'partial' : 'failed' : 'succeeded';
    attempt.observation_ids = outputs.map(o => o.observation.id);
    validateAttempt(attempt); result.attempts.push(attempt); result.observations.push(...outputs);
    for (const mapping of collector.mappings) {
      const mappingError = outputs.some(o => stable(o.observation.metric) === stable(mapping.metric)) ? null : error;
      const previous = execution.previous_capabilities?.find(c => c.resource_id === resource.id && stable(c.metric) === stable(mapping.metric) && c.method === collector.method);
      if (mappingError === 'timeout' && previous && Date.parse(previous.evaluated_at) <= Date.parse(at) && Date.parse(previous.valid_until) > Date.parse(at)) {
        result.capabilities.push(CapabilitySchema.parse(previous));
      } else result.capabilities.push(capability(mapping.metric, collector.method, mappingError ? 'unknown' : 'supported', [...basis,
        { kind: mappingError === 'permission_denied' || !mappingError ? 'permission' : 'method', evidence: mappingError ?? 'fixed_read_succeeded' }]));
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
    // A package can mix instance gauges and database-scoped counters. Do not broadcast
    // database formulas onto the singleton instance group (or invent database identity).
    const nodes = release.derived.filter(node => {
      const keys = definitions.find(d => d.id === node.output.id && d.semantic_version === node.output.semantic_version)!.dimensions.keys;
      return keys.every(k => !k.required || Object.hasOwn(anchor.dimensions, k.name))
        && Object.keys(anchor.dimensions).every(name => keys.some(k => k.name === name));
    });
    if (!nodes.length) continue;
    const targets = Object.fromEntries(nodes.map(d => [d.id, {
      source: { ...anchor.source, collector_id: `derived:${d.id}`, metric_binding_id: metricBindingId(execution.binding_id, d.output.id, anchor.dimensions) },
      versions: { ...anchor.versions, transform_version: d.transform_version },
    }]));
    const derived = executeDerived(nodes, definitions, inputs, { anchor, context: { now: clock(), stale_after_ms: settings.stale_after_ms },
      targets, counter: { max_gap_ms: settings.max_counter_gap_ms }, states: result.states });
    result.observations.push(...derived.outputs); result.states = derived.states;
  }
  for (const node of release.derived) {
    const dependencies = node.inputs.map(ref => result.capabilities.find(c => stable(c.metric) === stable(ref)));
    result.capabilities.push(capability(node.output, 'derived', dependencies.every(d => d?.status === 'supported') ? 'supported' : 'unknown',
      [{ kind: 'method', evidence: 'public_processor:derive@1.0.0' }, ...dependencies.flatMap(d => d?.basis ?? [])]));
  }
  execution.signal?.throwIfAborted();
  validateObservationBatch(result.observations.map(o => o.observation), definitions);
  return result;
}
