import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { validateDimensions, validateObservation, type MetricDefinition, type NormalizedObservation } from '../../contracts/metrics/index.js';
import { MetricConsumerService } from '../../metrics/consumers/service.js';
import { metricConsumerService } from '../../metrics/consumers/runtime.js';
import { aggregate, type SemanticBucket } from '../../metrics/query.js';
import { MysqlFormalMetricStore } from '../../metrics/rollout/formal-store.js';
import type { QueryStore } from '../../metrics/query.js';
import { operationsContentHash, OperationsError, resourceRefSchema, type BaselineSeriesIdentity } from '../contracts.js';

export const HOUR = 3_600_000, DAY = 24 * HOUR;
export const baselineInputSchema = z.strictObject({
  resource: resourceRefSchema, metric: z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/),
  dimensions: z.record(z.string().max(128), z.string().max(256)).refine(v => Object.keys(v).length <= 16),
  mode: z.enum(['daily', 'weekly']),
  staticThreshold: z.strictObject({ operator: z.enum(['>', '<']), value: z.number().finite() }).optional(),
});
export type BaselineInput = z.infer<typeof baselineInputSchema>;
export interface BaselineSourceWindow {
  identity: BaselineSeriesIdentity | null;
  from: string; until: string; evaluatedAt: string; validUntil: string;
  intervalMs: number; maxGapMs: number; buckets: SemanticBucket[];
  reason: string | null; latest: { value: number | null; observedAt: string | null };
  /** Opaque hash of the target and formal control snapshot, supplied by the store. */
  fence: string;
}
export interface BaselineSource {
  load(actor: ActorContext, input: BaselineInput, fence: string, targetVersion: string): Promise<BaselineSourceWindow>;
}
export const scalarNumber = (value: NormalizedObservation['value']): number | null => {
  if (!value || !('value' in value)) return null;
  const n = Number(value.value);
  return Number.isFinite(n) && (value.encoding === 'float64' || Number.isSafeInteger(n)) ? n : null;
};
export function baselineIdentity(point: NormalizedObservation, definition: MetricDefinition, targetVersion: string): BaselineSeriesIdentity {
  return { resource: { type: point.resource_type, id: Number(point.resource_id) },
    metric: `${point.metric.id}@${point.metric.semantic_version}`, unit: definition.kind === 'counter'
      ? definition.unit === 'By' ? 'By/s' : 'count/s' : definition.unit, dimensions: { ...point.dimensions },
    source: { id: point.source.collector_id, bindingId: `${point.source.binding_id}/${point.source.metric_binding_id}`,
      version: operationsContentHash([point.versions.contract, point.versions.package_id, point.versions.package_version, targetVersion]) },
    configurationVersion: String(point.versions.config_revision), transformVersion: point.versions.transform_version,
    counterEpoch: point.counter ? operationsContentHash(point.counter) : null };
}

/** The only production data port is the integrated formal store. Historical
 * freshness is assessed at collection time; current freshness is checked apart
 * from the training window. No legacy/shadow/history fallback or collection IO. */
export class FormalBaselineSource implements BaselineSource {
  constructor(private readonly store: Pick<QueryStore, 'queryWindow'>,
    private readonly consumer: Pick<MetricConsumerService, 'discover'> = metricConsumerService,
    private readonly clock = () => new Date()) {}

  async load(actor: ActorContext, input: BaselineInput, fence: string, targetVersion: string): Promise<BaselineSourceWindow> {
    const now = +this.clock(), until = Math.floor(now / HOUR) * HOUR;
    const from = until - (input.mode === 'daily' ? 14 : 28) * DAY;
    const iso = (n: number) => new Date(n).toISOString();
    const result: BaselineSourceWindow = { identity: null, from: iso(from), until: iso(until), evaluatedAt: iso(now),
      validUntil: iso(now), intervalMs: 60_000, maxGapMs: HOUR, buckets: [], reason: null,
      latest: { value: null, observedAt: null }, fence };
    const catalog = await this.consumer.discover(actor, input.resource);
    const definition = catalog.definitions.find(d => d.id === input.metric);
    if (!definition) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    try { validateDimensions(input.dimensions, definition); }
    catch { throw new OperationsError('OPERATIONS_INPUT_INVALID'); }
    const effective = catalog.effective;
    const template = effective?.resolved.metric_templates.find(t => t.metric.id === input.metric && t.metric.semantic_version === definition.semantic_version);
    const stop = (reason: string) => ({ ...result, reason });
    if (!effective || !template) return stop('not_covered');
    const settings = effective.resolved.settings;
    result.intervalMs = settings.interval_ms; result.maxGapMs = settings.max_counter_gap_ms;
    if (!settings.enabled || !template.enabled) return stop('collection_disabled');
    if (template.capability.status !== 'supported') return stop(`capability_${template.capability.status}`);
    if (effective.application.status !== 'applied' || effective.application.applied_revision !== effective.published_revision) return stop('configuration_pending');
    if (definition.kind !== 'gauge' && definition.kind !== 'counter'
      || definition.kind === 'counter' && (!definition.aggregation.time.includes('rate') || !['By', 'count'].includes(definition.unit))) return stop('scalar_operation_unavailable');
    if (settings.interval_ms > HOUR) return stop('sampling_interval_unavailable');
    const series = { resource_type: input.resource.type, resource_id: String(input.resource.id),
      metric: { id: definition.id, semantic_version: definition.semantic_version }, dimensions: input.dimensions };
    const points = new Map<string, NormalizedObservation>();
    // queryWindow retains the predecessor/successor required by counter rate.
    // Split overflowing day windows recursively; empty historical days cost
    // one query. Bounds fail closed rather than truncate qualification data.
    let queries = 0;
    const fetchWindow = async (start: number, end: number): Promise<void> => {
      if (++queries > 5000 || points.size > 100_000) throw new Error('BASELINE_SOURCE_LIMIT');
      try {
        const rows = await this.store.queryWindow(series, iso(start), iso(end), 1000);
        for (const row of rows) points.set(row.id, row);
        if (points.size > 100_000) throw new Error('BASELINE_SOURCE_LIMIT');
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'QUERY_LIMIT_EXCEEDED' || end - start <= settings.interval_ms) throw error;
        const middle = Math.floor((start + end) / 2);
        await fetchWindow(start, middle); await fetchWindow(middle, end);
      }
    };
    for (let at = from; at < now; at += DAY) await fetchWindow(at, Math.min(now, at + DAY));
    const ordered = [...points.values()].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || a.id.localeCompare(b.id));
    if (!ordered.length) return stop('formal_samples_missing');
    for (const p of ordered) {
      try { validateObservation(p, definition); } catch { return stop('invalid_observation'); }
      if (p.resource_type !== series.resource_type || p.resource_id !== series.resource_id
        || operationsContentHash(p.dimensions) !== operationsContentHash(input.dimensions) || p.unit !== definition.unit) return stop('series_identity_changed');
      if (Date.parse(p.observed_at) > now || Date.parse(p.collected_at) > now) return stop('future_observation');
      if (p.versions.config_revision !== effective.published_revision) return stop('configuration_changed');
    }
    const inWindow = ordered.filter(p => Date.parse(p.observed_at) >= from && Date.parse(p.observed_at) < now);
    const latest = inWindow.at(-1);
    if (!latest) return stop('formal_samples_missing');
    result.identity = baselineIdentity(latest, definition, targetVersion);
    result.latest.observedAt = latest.observed_at;
    result.validUntil = iso(Math.min(Date.parse(latest.observed_at) + settings.stale_after_ms,
      Date.parse(template.capability.valid_until), until + HOUR));
    if (Date.parse(result.validUntil) <= now) return stop('stale_observation');
    for (const p of inWindow) {
      if (operationsContentHash(baselineIdentity(p, definition, targetVersion)) !== operationsContentHash(result.identity)) return stop('series_identity_changed');
      if (p.quality.status !== 'good' || p.accuracy !== 'exact' || p.quality.reason !== 'none') return stop('observation_quality');
      if (Date.parse(p.collected_at) < Date.parse(p.observed_at)
        || Date.parse(p.collected_at) - Date.parse(p.observed_at) > settings.stale_after_ms) return stop('late_collection');
      if (scalarNumber(p.value) === null && definition.kind !== 'counter') return stop('scalar_precision_unavailable');
    }
    // Counter epochs include reset evidence even when the cumulative value rose.
    // An unexplained decrease cannot establish a new qualified period either.
    if (definition.kind === 'counter') for (let i = 1; i < inWindow.length; i++) {
      const a = inWindow[i - 1].value, b = inWindow[i].value;
      if (a && b && 'value' in a && 'value' in b && BigInt(b.value) < BigInt(a.value)) return stop('counter_reset');
    }
    const query = { definition, series: [series], now: iso(now), interval_ms: settings.interval_ms,
      max_gap_ms: settings.max_counter_gap_ms, stale_after_ms: settings.stale_after_ms,
      mode: definition.kind === 'counter' ? 'rate' as const : 'last' as const, space: 'none' as const };
    result.buckets = aggregate({ ...query, from: iso(from), to: iso(until), bucket_ms: HOUR }, [ordered]);
    const currentFrom = definition.kind === 'counter' ? Date.parse(inWindow.at(-2)?.observed_at ?? latest.observed_at) : Date.parse(latest.observed_at);
    const currentTo = definition.kind === 'counter' ? Date.parse(latest.observed_at) : now;
    if (currentFrom >= currentTo) return stop('current_value_unavailable');
    const current = aggregate({ ...query, from: iso(currentFrom), to: iso(currentTo), bucket_ms: currentTo - currentFrom }, [ordered])[0];
    result.latest.value = current && current.quality.status === 'good' ? scalarNumber(current.value) : null;
    if (result.latest.value === null) return stop('current_value_unavailable');
    return result;
  }
}
/** P10 composition helper; supplied pool is the platform pool, never a target DB. */
export const formalBaselineSource = (pool: ConstructorParameters<typeof MysqlFormalMetricStore>[0]) => new FormalBaselineSource(new MysqlFormalMetricStore(pool));
