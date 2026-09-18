import {
  freshness, observationIdentity, seriesIdentity, validateCatalog, validateDerived, validateObservation,
  type DerivedMetric, type MetricDefinition, type Quality,
} from '../contracts/metrics-v2/index.js';
import { add, decode, divide, multiply, numberValue, rational, subtract } from './arithmetic.js';
import { buildOutput, type Computation, type Evaluation, type Observation } from './observation.js';
import { processCounter, type CounterOptions } from './counter.js';
import type { CounterState } from './state.js';

export interface DerivedExecution {
  /** Valid observation providing resource/dimension identity and lineage when all dependencies are absent. */
  anchor: Observation;
  context: Evaluation;
  targets: Record<string, { source: Observation['source']; versions: Observation['versions'] }>;
  counter: Omit<CounterOptions, 'context'>;
  counter_bounds?: ReadonlyMap<string, string>;
  states?: ReadonlyMap<string, CounterState>;
}
const refKey = (ref: { id: string; semantic_version: string }): string => `${ref.id}@${ref.semantic_version}`;
const sameScope = (a: Observation, b: Observation): boolean => seriesIdentity({ ...a, metric: b.metric }) === seriesIdentity(b);

/** Executes one resource/dimension group; no implicit broadcast, scripts, I/O, or state commits. */
export function executeDerived(nodesInput: DerivedMetric[], definitions: MetricDefinition[], inputs: Computation[], execution: DerivedExecution): {
  outputs: Computation[]; states: Map<string, CounterState>;
} {
  if (nodesInput.length > 256 || nodesInput.reduce((count, node) => count + (Array.isArray(node.inputs) ? node.inputs.length : 0), 0) > 1024) throw new Error('DAG_LIMIT');
  validateCatalog(definitions);
  const nodes = validateDerived(nodesInput, definitions);
  for (const node of nodes) {
    if (new Set(node.inputs.map(refKey)).size !== node.inputs.length) throw new Error('DUPLICATE_DEPENDENCY');
  }
  const definition = (ref: { id: string; semantic_version: string }): MetricDefinition => {
    const found = definitions.find(d => refKey({ id: d.id, semantic_version: d.semantic_version }) === refKey(ref));
    if (!found) throw new Error('UNKNOWN_METRIC');
    return found;
  };
  validateObservation(execution.anchor, definition(execution.anchor.metric));
  const values = new Map<string, Computation>();
  const outputs = new Map(nodes.map(node => [refKey(node.output), node]));
  for (const input of inputs) {
    validateObservation(input.observation, definition(input.observation.metric));
    if (!sameScope(input.observation, execution.anchor)) throw new Error('DERIVED_JOIN');
    const key = refKey(input.observation.metric);
    if (values.has(key) || outputs.has(key)) throw new Error('DUPLICATE_SOURCE');
    if (!Number.isFinite(Date.parse(input.window.from)) || !Number.isFinite(Date.parse(input.window.to))
      || Date.parse(input.window.from) > Date.parse(input.window.to) || Date.parse(input.window.to) !== Date.parse(input.observation.observed_at)) throw new Error('INPUT_WINDOW');
    values.set(key, input);
  }
  const initialStates = execution.states ?? new Map<string, CounterState>();
  const states = new Map(initialStates);
  const results: Computation[] = [];
  const visited = new Set<string>();
  function visit(node: DerivedMetric): void {
    if (visited.has(node.id)) return;
    for (const ref of node.inputs) { const dependency = outputs.get(refKey(ref)); if (dependency) visit(dependency); }
    const target = execution.targets[node.id];
    if (!target || target.versions.transform_version !== node.transform_version) throw new Error('DERIVED_TARGET_VERSION');
    const args = node.inputs.map(ref => values.get(refKey(ref)));
    const present = args.filter((a): a is Computation => !!a);
    const observations = present.map(a => a.observation);
    const anchor = observations[0] ?? execution.anchor;
    const d = definition(node.output);
    if (node.inputs.some(ref => ['histogram', 'summary'].includes(definition(ref).value_type))) throw new Error('SCALAR_REQUIRED');
    let result: Computation;
    if (node.operation === 'rate' && args[0]) {
      const input = args[0].observation, key = seriesIdentity(input);
      // All consumers of this counter share one plan fingerprint and one initial baseline.
      const consumers = nodes.filter(n => n.operation === 'rate' && refKey(n.inputs[0]) === refKey(node.inputs[0]));
      const processingRevision = JSON.stringify([execution.counter.processing_revision ?? '', consumers.map(n => {
        const t = execution.targets[n.id];
        if (!t || t.versions.transform_version !== n.transform_version) throw new Error('DERIVED_TARGET_VERSION');
        return JSON.stringify([n.id, n.output.id, n.output.semantic_version, n.transform_version,
          t.source.binding_id, t.source.metric_binding_id, t.source.collector_id,
          t.versions.contract, t.versions.package_id, t.versions.package_version, t.versions.config_revision]);
      }).sort()]);
      const transition = processCounter(input, definition(node.inputs[0]), d, 'rate', initialStates.get(key) ?? null,
        { ...execution.counter, ...(execution.counter_bounds?.has(key) ? { max_increment_per_second: execution.counter_bounds.get(key) } : {}), processing_revision: processingRevision, context: execution.context });
      if (transition.state) states.set(key, transition.state);
      result = transition.output;
      result.observation.source = structuredClone(target.source);
      result.observation.versions = structuredClone(target.versions);
      result.observation.id = observationIdentity(result.observation);
      validateObservation(result.observation, d);
    } else {
      let quality: Quality | undefined;
      let value = null;
      const times = observations.map(o => Date.parse(o.observed_at));
      const intervals = present.filter(p => Date.parse(p.window.from) !== Date.parse(p.window.to));
      if (args.some(a => !a)) quality = { status: 'unknown', reason: 'missing_input' };
      else if (Math.max(...times) - Math.min(...times) > node.max_skew_ms) quality = { status: 'unknown', reason: 'clock_skew' };
      else if (intervals.length && present.some(p => Date.parse(p.window.from) !== Date.parse(intervals[0].window.from) || Date.parse(p.window.to) !== Date.parse(intervals[0].window.to))) quality = { status: 'unknown', reason: 'gap' };
      else if (observations.every(o => o.value !== null)) {
        const numbers = observations.map(o => decode(o.value!));
        switch (node.operation) {
          case 'sum': value = numbers.reduce(add, rational(0n)); break;
          case 'difference': value = subtract(numbers[0], numbers[1]); break;
          case 'scale': value = multiply(numbers[0], numberValue(node.factor!)); break;
          case 'ratio':
            if (numbers[1].numerator === 0n) quality = { status: 'unknown', reason: 'invalid_denominator' };
            else value = multiply(divide(numbers[0], numbers[1]), rational(d.unit === '%' ? 100n : 1n));
            break;
        }
      }
      const from = present.length ? new Date(Math.min(...present.map(p => Date.parse(p.window.from)))).toISOString() : anchor.observed_at;
      const to = observations.length ? new Date(Math.max(...times)).toISOString() : anchor.observed_at;
      result = buildOutput({ anchor, definition: d, inputs: observations.length ? observations : [anchor], value, quality,
        derived: true, context: execution.context, window: { from, to }, source: target.source, versions: target.versions });
    }
    // Preserve transitive window freshness and source/transform versions, including dependency failures.
    const ages = present.flatMap(p => [p.freshness, freshness(p.window.from, execution.context.now, execution.context.stale_after_ms)]);
    if (ages.includes('unknown')) result.freshness = 'unknown';
    else if (result.freshness !== 'unknown' && ages.includes('stale')) result.freshness = 'stale';
    const provenance = [...result.input_provenance, ...present.flatMap(p => p.input_provenance)];
    result.input_provenance = [...new Map(provenance.map(p => [`${p.stage}:${p.id}`, p])).values()];
    values.set(refKey(node.output), result); results.push(result); visited.add(node.id);
  }
  nodes.forEach(visit);
  return { outputs: results, states };
}
