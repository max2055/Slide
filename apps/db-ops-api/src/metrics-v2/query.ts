import {
  CONTRACT_VERSION, freshness, seriesIdentity, validateDefinition, validateDimensions, validateObservation,
  type MetricDefinition, type NormalizedObservation, type Resource,
} from '../contracts/metrics-v2/index.js';
import { add, compare, decode, divide, encode, multiply, numberValue, rational, type Rational } from './arithmetic.js';
import { processCounter } from './counter.js';
import type { Series } from './storage.js';
import type { CounterState } from './state.js';

type Point = NormalizedObservation;
type Space = 'none' | 'sum' | 'min' | 'max' | 'weighted_mean' | 'merge';
type Mode = 'last' | 'min' | 'max' | 'mean' | 'rate' | 'ratio' | 'duration' | 'merge' | 'quantile';
export interface SemanticQuery {
  definition: MetricDefinition;
  series: Series[];
  from: string;
  to: string;
  now: string;
  interval_ms: number;
  max_gap_ms: number;
  stale_after_ms: number;
  bucket_ms?: number;
  mode: Mode;
  space: Space;
  /** A time-weighted gauge holds a sample only until the next sample or max_gap_ms. */
  weighting?: 'samples' | 'time';
  /** Spatial means require explicit population weights; sample counts are not population sizes. */
  weights?: number[];
  /** Ratio pairs two metrics at the same resource, dimensions and observed_at. */
  numerator?: MetricDefinition;
  denominator?: MetricDefinition;
  state_value?: number;
  quantile?: number;
}
export interface SemanticBucket {
  contract_version: typeof CONTRACT_VERSION;
  metric: Point['metric'];
  unit: MetricDefinition['unit'];
  dimensions: Record<string, string> | null;
  window: { from: string; to: string };
  value: Point['value'];
  quality: Point['quality'];
  accuracy: Point['accuracy'];
  coverage: number;
  freshness: 'fresh' | 'stale' | 'unknown';
  sample_count: number;
  sources: { id: string; source: Point['source']; versions: Point['versions'] }[];
}
export interface QueryStore {
  queryWindow(series: Series, from: string, to: string, limit?: number): Promise<Point[]>;
  inventory(type: Resource['type'], id: string): Promise<Resource | null>;
}
type Group = { value: Rational | null; histogram?: Extract<NonNullable<Point['value']>, { encoding: 'histogram' }>;
  summary?: Extract<NonNullable<Point['value']>, { encoding: 'summary' }>;
  coverage: number; points: Point[]; accuracy: Point['accuracy']; quality: Point['quality'] };
const empty = (): Group => ({ value: null, coverage: 0, points: [], accuracy: 'unknown', quality: { status: 'unknown', reason: 'missing_input' } });
const valid = (p: Point) => p.value !== null && (p.quality.status === 'good' || p.quality.status === 'partial');
const scalar = (p: Point): Rational => {
  if (!p.value || !('value' in p.value)) throw new Error('QUERY_SCALAR_REQUIRED');
  return decode(p.value);
};
const time = (p: Point) => Date.parse(p.observed_at);
const overlap = (a: number, b: number, from: number, to: number) => Math.max(0, Math.min(b, to) - Math.max(a, from));
const rank = { good: 0, partial: 1, unknown: 2, invalid: 3 };
const accurate = { exact: 0, estimated: 1, unknown: 2 };
function unique(points: Point[]): Point[] {
  const byTime = new Map<number, Point>();
  for (const p of [...points].sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id))) byTime.set(time(p), p);
  return [...byTime.values()].sort((a, b) => time(a) - time(b));
}
function qualityOf(points: Point[]): Pick<Group, 'accuracy' | 'quality'> {
  return points.reduce((result, p) => ({
    accuracy: accurate[p.accuracy] > accurate[result.accuracy] ? p.accuracy : result.accuracy,
    quality: rank[p.quality.status] > rank[result.quality.status] ? p.quality : result.quality,
  }), { accuracy: 'exact', quality: { status: 'good', reason: 'none' } } as Pick<Group, 'accuracy' | 'quality'>);
}
function period(p: Point): string {
  return JSON.stringify([p.counter?.start_at ?? null, p.counter?.discontinuity?.epoch ?? null,
    p.counter?.discontinuity?.reason ?? null, p.source.binding_id, p.source.metric_binding_id,
    p.source.collector_id, p.versions.contract, p.versions.package_id, p.versions.package_version,
    p.versions.transform_version, p.versions.config_revision]);
}
function histogramDelta(previous: Point | null, current: Point, definition: MetricDefinition, maxGap: number): Group {
  if (!valid(current) || current.value?.encoding !== 'histogram') return empty();
  if (definition.temporality !== 'cumulative') return { ...empty(), histogram: current.value, points: [current], coverage: 1, ...qualityOf([current]) };
  if (!previous || !valid(previous) || previous.value?.encoding !== 'histogram' || period(previous) !== period(current)
    || time(current) - time(previous) > maxGap) return empty();
  const a = previous.value, b = current.value;
  if (JSON.stringify(a.buckets.map(x => x.upper_bound)) !== JSON.stringify(b.buckets.map(x => x.upper_bound))) throw new Error('HISTOGRAM_BUCKET_MISMATCH');
  if (BigInt(b.count) < BigInt(a.count) || !Number.isFinite(b.sum - a.sum)
    || b.buckets.some((x, i) => BigInt(x.count) < BigInt(a.buckets[i].count))) return empty();
  return { ...empty(), histogram: { encoding: 'histogram', count: (BigInt(b.count) - BigInt(a.count)).toString(),
    sum: b.sum - a.sum, buckets: b.buckets.map((x, i) => ({ upper_bound: x.upper_bound, count: (BigInt(x.count) - BigInt(a.buckets[i].count)).toString() })) },
    points: [previous, current], coverage: 1, ...qualityOf([previous, current]) };
}
function mergeHistograms(groups: Group[]): Group {
  const available = groups.filter(g => g.histogram);
  if (!available.length) return empty();
  const first = available[0].histogram!;
  for (const g of available.slice(1)) {
    if (JSON.stringify(g.histogram!.buckets.map(x => x.upper_bound)) !== JSON.stringify(first.buckets.map(x => x.upper_bound))) throw new Error('HISTOGRAM_BUCKET_MISMATCH');
  }
  const count = available.reduce((n, g) => n + BigInt(g.histogram!.count), 0n);
  if (count >= 1n << 64n) throw new Error('HISTOGRAM_COUNT_OVERFLOW');
  const sum = available.reduce((n, g) => n + g.histogram!.sum, 0);
  if (!Number.isFinite(sum)) throw new Error('HISTOGRAM_SUM_OVERFLOW');
  return { ...empty(), histogram: { encoding: 'histogram', count: count.toString(),
    sum,
    buckets: first.buckets.map((b, i) => ({ upper_bound: b.upper_bound,
      count: available.reduce((n, g) => n + BigInt(g.histogram!.buckets[i].count), 0n).toString() })) },
    points: available.flatMap(g => g.points), coverage: Math.min(1, available.reduce((n, g) => n + g.coverage, 0)),
    ...qualityOf(available.flatMap(g => g.points)) };
}
function reduceSeries(q: SemanticQuery, rows: Point[], from: number, to: number): Group {
  const points = unique(rows);
  const inside = points.filter(p => time(p) >= from && time(p) < to && valid(p));
  const duration = to - from;
  if (q.mode === 'rate') {
    let state: CounterState | null = null, total = rational(0n), covered = 0;
    const used: Point[] = [];
    const outputDefinition: MetricDefinition = { ...q.definition, id: `${q.definition.id}.aggregate_delta`,
      kind: 'gauge', temporality: 'instant', monotonic: false, aggregation: { ...q.definition.aggregation, time: ['last'], space: ['none'] } };
    for (const point of points) {
      if (!valid(point)) { state = null; continue; }
      const prior = state?.baseline as Point | undefined;
      const transition = processCounter(point, q.definition, outputDefinition, 'delta', state,
        { context: { now: q.now, stale_after_ms: q.stale_after_ms }, max_gap_ms: q.max_gap_ms });
      state = transition.state;
      const delta = transition.output.observation.value;
      if (!prior || !delta || !('value' in delta)) continue;
      const ms = overlap(time(prior), time(point), from, to);
      if (!ms) continue;
      total = add(total, multiply(decode(delta), rational(BigInt(ms), BigInt(time(point) - time(prior)))));
      covered += ms; used.push(prior, point);
    }
    if (!covered) return empty();
    return { value: divide(total, rational(BigInt(covered), 1000n)), coverage: covered / duration,
      points: used, ...qualityOf(used) };
  }
  if (q.mode === 'duration' || q.weighting === 'time') {
    let total = rational(0n), covered = 0;
    const used: Point[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!valid(p)) continue;
      const end = Math.min(points[i + 1] ? time(points[i + 1]) : to, time(p) + q.max_gap_ms);
      const ms = overlap(time(p), end, from, to);
      if (!ms) continue;
      if (q.mode === 'duration') {
        if (compare(scalar(p), rational(BigInt(q.state_value!))) === 0) total = add(total, rational(BigInt(ms)));
      } else total = add(total, multiply(scalar(p), rational(BigInt(ms))));
      covered += ms; used.push(p);
    }
    if (!covered) return empty();
    return { value: q.mode === 'duration' ? total : divide(total, rational(BigInt(covered))),
      coverage: covered / duration, points: used, ...qualityOf(used) };
  }
  if (q.definition.kind === 'summary') {
    const last = inside.at(-1);
    return last?.value?.encoding === 'summary' ? { ...empty(), summary: last.value,
      coverage: 1 / Math.ceil(duration / q.interval_ms), points: [last], ...qualityOf([last]) } : empty();
  }
  if (q.mode === 'merge' || q.mode === 'quantile') {
    const groups: Group[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (time(p) < from || time(p) >= to) continue;
      const g = histogramDelta(points[i - 1] ?? null, p, q.definition, q.max_gap_ms);
      if (g.histogram) groups.push(g);
    }
    const merged = mergeHistograms(groups);
    return { ...merged, coverage: new Set(inside.map(p => Math.floor((time(p) - from) / q.interval_ms))).size / Math.ceil(duration / q.interval_ms) };
  }
  if (!inside.length) return empty();
  const values = inside.map(scalar);
  let value = values[0];
  if (q.mode === 'last') value = values[values.length - 1];
  else if (q.mode === 'min' || q.mode === 'max') {
    for (const v of values.slice(1)) if ((q.mode === 'min' ? compare(v, value) < 0 : compare(v, value) > 0)) value = v;
  } else if (q.mode === 'mean') value = divide(values.reduce(add, rational(0n)), rational(BigInt(values.length)));
  return { value, coverage: new Set(inside.map(p => Math.floor((time(p) - from) / q.interval_ms))).size / Math.ceil(duration / q.interval_ms),
    points: inside, ...qualityOf(inside) };
}
function ratioSeries(q: SemanticQuery, numerator: Point[], denominator: Point[], from: number, to: number): Group {
  const denominators = new Map(unique(denominator).map(p => [time(p), p]));
  const pairs: Point[] = [];
  let zero = false;
  let n = rational(0n), d = rational(0n);
  const slots = new Set<number>();
  for (const p of unique(numerator)) {
    if (time(p) < from || time(p) >= to || !valid(p)) continue;
    const other = denominators.get(time(p));
    if (other && valid(other) && compare(scalar(other), rational(0n)) <= 0) zero = true;
    if (!other || !valid(other) || compare(scalar(other), rational(0n)) <= 0) continue;
    n = add(n, scalar(p)); d = add(d, scalar(other));
    slots.add(Math.floor((time(p) - from) / q.interval_ms)); pairs.push(p, other);
  }
  return pairs.length ? { value: divide(n, d), coverage: slots.size / Math.ceil((to - from) / q.interval_ms),
    points: pairs, ...qualityOf(pairs) } : zero ? { ...empty(), quality: { status: 'unknown', reason: 'invalid_denominator' } } : empty();
}
function spatial(q: SemanticQuery, groups: Group[]): Group {
  const good = groups.filter(g => g.value || g.histogram || g.summary);
  if (!good.length) return empty();
  if (q.space === 'none' && groups.length !== 1) throw new Error('SPACE_OPERATION_REQUIRED');
  if (q.space === 'none') return good[0];
  if (q.space === 'merge') {
    const merged = mergeHistograms(good);
    return { ...merged, coverage: groups.reduce((n, g) => n + g.coverage, 0) / groups.length };
  }
  let value = good[0].value;
  if (q.space === 'sum') value = good.reduce((n, g) => add(n, g.value!), rational(0n));
  if (q.space === 'min' || q.space === 'max') for (const g of good.slice(1)) if ((q.space === 'min' ? compare(g.value!, value!) < 0 : compare(g.value!, value!) > 0)) value = g.value;
  if (q.space === 'weighted_mean') {
    if (!q.weights || q.weights.length !== groups.length || q.weights.some(w => !Number.isSafeInteger(w) || w <= 0)) throw new Error('SPATIAL_WEIGHTS_REQUIRED');
    const weighted = groups.reduce((n, g, i) => g.value ? add(n, multiply(g.value, rational(BigInt(q.weights![i])))) : n, rational(0n));
    const weight = groups.reduce((n, g, i) => n + (g.value ? BigInt(q.weights![i]) : 0n), 0n);
    value = divide(weighted, rational(weight));
  }
  const points = good.flatMap(g => g.points);
  return { value, coverage: groups.reduce((n, g) => n + g.coverage, 0) / groups.length,
    points, ...qualityOf(points) };
}
function validateQuery(q: SemanticQuery): void {
  validateDefinition(q.definition);
  const start = Date.parse(q.from), end = Date.parse(q.to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || !Number.isFinite(Date.parse(q.now))
    || end - start > 31 * 86_400_000 || !q.series.length || q.series.length > 50
    || ![q.interval_ms, q.max_gap_ms, q.stale_after_ms, q.bucket_ms ?? q.interval_ms].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('QUERY_WINDOW');
  if (q.series.some(s => s.resource_type !== q.definition.resource_type || s.metric.id !== q.definition.id
    || s.metric.semantic_version !== q.definition.semantic_version) || new Set(q.series.map(seriesIdentity)).size !== q.series.length) throw new Error('QUERY_IDENTITY');
  if (q.space === 'none' && q.series.length !== 1) throw new Error('SPACE_OPERATION_REQUIRED');
  for (const s of q.series) validateDimensions(s.dimensions, q.definition);
  if (q.mode === 'rate' ? q.definition.kind !== 'counter' || q.definition.temporality !== 'cumulative' :
    ['merge', 'quantile'].includes(q.mode) ? q.definition.kind !== 'histogram' :
      q.definition.kind !== 'gauge' && q.definition.kind !== 'summary') throw new Error('QUERY_KIND');
  if (q.mode === 'rate' && q.definition.unit !== 'By' && q.definition.unit !== 'count') throw new Error('COUNTER_RATE_UNIT');
  if (q.definition.kind === 'summary' && (q.mode !== 'last' || q.series.length !== 1)) throw new Error('SUMMARY_NON_MERGEABLE');
  if (q.mode !== 'duration' && q.mode !== 'ratio' && !q.definition.aggregation.time.includes(q.mode)) throw new Error('AGGREGATION_NOT_ALLOWED');
  if (!q.definition.aggregation.space.includes(q.space) && !(q.space === 'none' && q.series.length === 1)) throw new Error('SPACE_NOT_ALLOWED');
  if (q.mode === 'ratio') {
    if (!q.numerator || !q.denominator || q.numerator.unit !== q.denominator.unit || !['1', '%'].includes(q.definition.unit)
      || q.numerator.id === q.denominator.id || q.numerator.kind !== 'gauge' || q.denominator.kind !== 'gauge'
      || (q.space !== 'none' && q.space !== 'sum')) throw new Error('RATIO_INPUT');
    validateDefinition(q.numerator); validateDefinition(q.denominator);
    for (const d of [q.numerator, q.denominator]) {
      if (d.resource_type !== q.definition.resource_type) throw new Error('RATIO_INPUT');
      for (const s of q.series) validateDimensions(s.dimensions, d);
    }
  }
  if (q.mode === 'duration' && (!Number.isSafeInteger(q.state_value) || q.definition.unit !== '1')) throw new Error('STATE_VALUE');
  if (q.mode === 'quantile' ? q.quantile === undefined || q.quantile < 0 || q.quantile > 1 : q.quantile !== undefined) throw new Error('QUANTILE');
  if (q.weighting && q.mode !== 'mean') throw new Error('QUERY_WEIGHTING');
  if (q.mode === 'mean' && q.weighting === 'time' && q.definition.temporality !== 'instant') throw new Error('TIME_WEIGHTING');
  if (q.space === 'weighted_mean' && (!q.weights || q.weights.length !== q.series.length || q.weights.some(n => !Number.isSafeInteger(n) || n <= 0))) throw new Error('SPATIAL_WEIGHTS_REQUIRED');
}

/** Pure reducer: live, historical and bucketed queries use the same calculation. */
export function aggregate(q: SemanticQuery, data: Point[][], denominators?: Point[][]): SemanticBucket[] {
  validateQuery(q);
  if (data.length !== q.series.length || (q.mode === 'ratio' && denominators?.length !== data.length)) throw new Error('QUERY_SERIES_COUNT');
  for (let i = 0; i < data.length; i++) {
    const sources = q.mode === 'ratio' ? [[data[i], q.numerator!], [denominators![i], q.denominator!]] as const : [[data[i], q.definition]] as const;
    for (const [rows, definition] of sources) for (const p of rows) {
      validateObservation(p, definition);
      if (p.resource_id !== q.series[i].resource_id || p.resource_type !== q.series[i].resource_type
        || JSON.stringify(Object.entries(p.dimensions).sort()) !== JSON.stringify(Object.entries(q.series[i].dimensions).sort())) throw new Error('QUERY_IDENTITY');
    }
  }
  const result: SemanticBucket[] = [];
  const start = Date.parse(q.from), end = Date.parse(q.to), step = q.bucket_ms ?? end - start;
  if (Math.ceil((end - start) / step) > 1000) throw new Error('QUERY_LIMIT_EXCEEDED');
  for (let from = start; from < end; from += step) {
    const to = Math.min(end, from + step);
    const groups = data.map((rows, i) => q.mode === 'ratio' ? ratioSeries(q, rows, denominators![i], from, to) : reduceSeries(q, rows, from, to));
    let group: Group;
    if (q.mode === 'ratio') {
      const validGroups = groups.filter(g => g.value !== null);
      const numerator = validGroups.flatMap(g => g.points.filter(p => p.metric.id === q.numerator!.id));
      const denominator = validGroups.flatMap(g => g.points.filter(p => p.metric.id === q.denominator!.id));
      group = validGroups.length ? { value: divide(numerator.map(scalar).reduce(add, rational(0n)), denominator.map(scalar).reduce(add, rational(0n))),
        coverage: groups.reduce((n, g) => n + g.coverage, 0) / groups.length, points: validGroups.flatMap(g => g.points),
        ...qualityOf(validGroups.flatMap(g => g.points)) } : groups.find(g => g.quality.reason === 'invalid_denominator') ?? empty();
    } else group = spatial(q, groups);
    const coverage = Math.min(1, group.coverage);
    let value: Point['value'] = null;
    let accuracy = group.accuracy;
    let quality = group.quality;
    let precisionLoss = false;
    if (group.summary) value = group.summary;
    else if (group.histogram && q.mode === 'merge') value = group.histogram;
    else if (group.histogram && q.mode === 'quantile') {
      const fraction = numberValue(q.quantile!);
      const count = BigInt(group.histogram.count);
      const target = (count * fraction.numerator + fraction.denominator - 1n) / fraction.denominator;
      const upper = group.histogram.buckets.find(b => BigInt(b.count) >= (target > 0n ? target : 1n))?.upper_bound;
      if (typeof upper === 'number') { value = { encoding: 'float64', value: upper }; accuracy = 'estimated'; }
      else quality = { status: 'unknown', reason: 'partial_input' };
    } else if (group.value) {
      const scaled = q.mode === 'ratio' && q.definition.unit === '%' ? multiply(group.value, rational(100n)) : group.value;
      const targetType = q.mode === 'rate' || q.mode === 'ratio' || q.mode === 'mean' || q.mode === 'duration' ? 'float64' : q.definition.value_type;
      const encoded = encode(scaled, targetType);
      value = encoded.value;
      if (!encoded.exact) { accuracy = 'estimated'; precisionLoss = true; }
    }
    if (coverage < q.definition.aggregation.min_coverage || !value) {
      value = null; quality = { status: 'unknown', reason: coverage && !value && quality.reason === 'partial_input' ? 'partial_input' : coverage ? 'gap' :
        group.quality.reason === 'invalid_denominator' ? 'invalid_denominator' : 'missing_input' }; accuracy = 'unknown';
    } else if (precisionLoss || coverage < 1 || accuracy !== 'exact' || quality.status === 'partial') {
      quality = quality.status === 'partial' ? quality : { status: 'partial',
        reason: precisionLoss ? 'precision_loss' : coverage < 1 ? 'gap' : 'partial_input' };
    }
    const sources = [...new Map(group.points.map(p => [p.id, { id: p.id, source: p.source, versions: p.versions }])).values()];
    const latest = Math.max(...group.points.filter(p => valid(p) && time(p) < to).map(time));
    result.push({ contract_version: CONTRACT_VERSION, metric: { id: q.definition.id, semantic_version: q.definition.semantic_version },
      unit: q.mode === 'rate' ? (q.definition.unit === 'By' ? 'By/s' : 'count/s') : q.mode === 'duration' ? 'ms' : q.definition.unit,
      dimensions: q.space === 'none' ? { ...q.series[0].dimensions } : null,
      window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, value, quality, accuracy, coverage,
      freshness: Number.isFinite(latest) ? freshness(new Date(latest).toISOString(), q.now, q.stale_after_ms) : 'unknown',
      sample_count: new Set(group.points.filter(p => time(p) >= from && time(p) < to).map(p => p.id)).size, sources });
  }
  return result;
}

/** Authorization is checked on every resource/metric series before any storage read. */
export class SemanticQueryService {
  constructor(private readonly store: QueryStore, private readonly authorize: (series: Series) => Promise<boolean>,
    private readonly authorizeInventory?: (type: Resource['type'], id: string) => Promise<boolean>) {}
  async query(q: SemanticQuery): Promise<SemanticBucket[]> {
    validateQuery(q);
    const refs = q.series.flatMap(s => q.mode === 'ratio' ? [q.numerator!, q.denominator!].map(d => ({ ...s, metric: { id: d.id, semantic_version: d.semantic_version } })) : [s]);
    for (const ref of refs) if (!await this.authorize(ref)) throw new Error('QUERY_FORBIDDEN');
    const fetch = (definition: MetricDefinition) => Promise.all(q.series.map(s => this.store.queryWindow({ ...s, metric: { id: definition.id, semantic_version: definition.semantic_version } }, q.from, q.to)));
    return aggregate(q, await fetch(q.mode === 'ratio' ? q.numerator! : q.definition), q.mode === 'ratio' ? await fetch(q.denominator!) : undefined);
  }
  async inventory(type: Resource['type'], id: string): Promise<Resource | null> {
    if (!this.authorizeInventory || !await this.authorizeInventory(type, id)) throw new Error('QUERY_FORBIDDEN');
    return this.store.inventory(type, id);
  }
}
