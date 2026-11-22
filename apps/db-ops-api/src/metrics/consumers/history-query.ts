import type { ConfigurationAt } from '../../contracts/metrics/configuration-history.js';
import type { NormalizedObservation } from '../../contracts/metrics/index.js';
import { aggregate, MAX_BUCKETS, type SemanticQuery, type SemanticBucket } from '../query.js';
import { historySampling } from './history-context.js';
import { metricKey } from '../policy/model.js';
import { metricTiming } from '../timing.js';
import { encode, rational } from '../arithmetic.js';
import { retainedHierarchy, retainedRange, type RetainedTrend } from './retained-trends.js';
import { TREND_TIERS } from './trends.js';

export interface HistoryChartWindow {
  points: NormalizedObservation[];
  // History-expired observations still on disk. Only their aggregate statistics leave this path.
  trendOnly?: NormalizedObservation[];
  retained: RetainedTrend[];
}

/** Settings follow each sample revision, never the resource's current binding. */
export async function aggregateHistory(q: SemanticQuery, points: NormalizedObservation[],
  configurationAt: (revision: number) => Promise<ConfigurationAt>): Promise<SemanticBucket[]> {
  const revisions = [...new Set(points.map(p => p.versions.config_revision))];
  if (revisions.length > 100) throw new Error('QUERY_LIMIT_EXCEEDED');
  const windows = await Promise.all(revisions.map(async revision => {
    const configuration = await configurationAt(revision);
    const settings = configuration.state === 'effective'
      ? metricTiming(configuration.settings, configuration.item_intervals_ms?.[metricKey(q.definition)]) : null;
    return aggregate({ ...q, interval_ms: settings?.interval_ms ?? historySampling.interval_ms,
      max_gap_ms: settings?.max_counter_gap_ms ?? historySampling.max_gap_ms,
      stale_after_ms: settings?.stale_after_ms ?? historySampling.max_gap_ms },
    [points.filter(p => p.versions.config_revision === revision)]);
  }));
  const empty = aggregate(q, [[]]);
  return empty.map((bucket, i) => {
    const candidates = windows.map(w => w[i]).filter(b => b.sources.length);
    if (candidates.length === 1) return candidates[0];
    if (!candidates.length) return bucket;
    // A bucket spanning revisions has no single proven cadence. Keep provenance,
    // reject a blended value/coverage, and never bridge counters across revisions.
    return { ...bucket, sources: candidates.flatMap(b => b.sources), value: null, coverage: 0,
      observed_at: candidates.map(b => b.observed_at).filter((at): at is string => Boolean(at)).sort().at(-1) ?? null,
      quality: { status: 'unknown', reason: 'gap' }, stats: undefined };
  });
}

/** Keep detail where it survives. Use the same exact trend statistics as historical study where it was pruned. */
export async function aggregateHistoryChart(q: SemanticQuery, { points, trendOnly = [], retained }: HistoryChartWindow,
  configurationAt?: (revision: number) => Promise<ConfigurationAt>): Promise<SemanticBucket[]> {
  const from = Date.parse(q.from), to = Date.parse(q.to);
  const hasTrend = trendOnly.length > 0 || retained.some(({ bucket }) =>
    bucket.numeric_count > 0 && retainedRange(bucket, from, to) === 'inside');
  const tier = hasTrend && (Object.keys(TREND_TIERS) as Array<keyof typeof TREND_TIERS>).find(key => {
    const ms = TREND_TIERS[key];
    return ms >= (q.bucket_ms ?? 0) && Math.ceil(to / ms) - Math.floor(from / ms) <= MAX_BUCKETS;
  });
  const request: SemanticQuery = { ...q, history_chart: true,
    ...(tier ? { bucket_ms: TREND_TIERS[tier], align_buckets: true } : {}) };
  const detail = configurationAt ? await aggregateHistory(request, points, configurationAt) : aggregate(request, [points]);
  if (!tier) return detail;

  const plottableDetail = new Set(points.filter(p => p.value !== null
    && (p.quality.status === 'good' || p.quality.status === 'partial')).map(p => p.id));
  const trends = retainedHierarchy(points, retained, q.from, q.to, q.interval_ms, tier, { trendOnly, plottableDetail });
  return detail.map((raw, i) => {
    const trend = trends[i];
    if (!trend.retained_count) return raw;
    const counts = { retained_sample_count: trend.retained_count, sample_count: trend.count };
    if (!trend.avg || !trend.min || !trend.max) return { ...raw, ...counts };
    const unpack = (value: typeof trend.avg) => rational(BigInt(value.numerator), BigInt(value.denominator));
    const mean = encode(unpack(trend.avg), 'float64');
    const min = encode(unpack(trend.min), q.definition.value_type).value;
    const max = encode(unpack(trend.max), q.definition.value_type).value;
    if (!mean.value || !min || !max) return { ...raw, ...counts };
    const exact = mean.exact && trend.estimated_count === 0;
    const stats = { count: trend.numeric_count, min, max, avg: mean.value };
    // Keep the failed detail as a break in the line and let the chart show the trend as an isolated point.
    if (raw.sources.length && raw.value === null) return { ...raw, ...counts, stats };
    return { ...raw, value: mean.value, accuracy: exact ? 'exact' : 'estimated',
      quality: trend.quality === 'good' && raw.quality.status !== 'partial' && exact ? { status: 'good', reason: 'none' }
        : { status: 'partial', reason: exact ? 'partial_input' : 'precision_loss' },
      coverage: trend.coverage, freshness: 'unknown', observed_at: null, ...counts, stats };
  });
}
