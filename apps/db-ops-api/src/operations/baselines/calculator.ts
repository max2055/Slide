import { operationsContentHash, type BaselineVersion } from '../contracts.js';
import { DAY, HOUR, scalarNumber, type BaselineInput, type BaselineSourceWindow } from './source-adapter.js';

export const BASELINE_METHOD = 'utc-hour-median-q10-q90/1.0.0';
export interface ReferenceBand { slot: number; median: number; lower: number; upper: number; repeats: number }
export interface BaselineCalculation {
  methodVersion: string; mode: BaselineInput['mode']; state: BaselineVersion['state']; status: 'known' | 'unknown'; reason: string | null;
  series: BaselineSourceWindow['identity']; seriesHash: string | null;
  training: { from: string; until: string }; validation: { from: string; until: string };
  quality: BaselineVersion['quality'] & { trainingCoverage: number; validationCoverage: number; expectedHours: number; maxGapMs: number };
  referenceBands: ReferenceBand[];
  comparison: { observedAt: string | null; value: number | null; reference: ReferenceBand | null; deviation: number | null;
    deviationRatio: number | null; baselineAnomaly: boolean | null; staticAnomaly: boolean | null };
  staticComparison: { status: 'known' | 'unknown' | 'not_configured'; threshold: BaselineInput['staticThreshold'] | null; value: number | null; anomaly: boolean | null };
  temporalReport: { status: 'evaluated' | 'insufficient'; samples: number; baselineFlags: number | null; staticFlags: number | null;
    labelledSamples: 0; falsePositiveRate: null; importantMisses: null; improvement: 'not_established' };
  exclusions: { policy: 'quality-only-no-labels-no-interpolation'; excludedHours: number };
  evaluatedAt: string; validUntil: string; sourceFence: string;
}
const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b), rank = (sorted.length - 1) * q;
  const low = sorted[Math.floor(rank)], high = sorted[Math.ceil(rank)];
  // Weighted form avoids overflow of high-low for opposite large values.
  return low * (1 - (rank % 1)) + high * (rank % 1);
};
const slot = (at: number, mode: BaselineInput['mode']) => {
  const date = new Date(at); return date.getUTCHours() + (mode === 'weekly' ? date.getUTCDay() * 24 : 0);
};
const isOutside = (value: number, band: ReferenceBand) => value < band.lower || value > band.upper;
const staticFlag = (value: number, threshold: BaselineInput['staticThreshold']) => threshold
  ? threshold.operator === '>' ? value > threshold.value : value < threshold.value : null;

/** No online learning from holdout labels; the last seven days never change
 * training references. UTC is part of the pinned method version. */
export function calculateBaseline(input: BaselineInput, source: BaselineSourceWindow): BaselineCalculation {
  const from = Date.parse(source.from), until = Date.parse(source.until), split = until - 7 * DAY;
  const expected = (input.mode === 'daily' ? 14 : 28) * 24;
  const result: BaselineCalculation = {
    methodVersion: BASELINE_METHOD, mode: input.mode, state: 'not_qualified', status: 'unknown', reason: source.reason,
    series: source.identity, seriesHash: source.identity ? operationsContentHash(source.identity) : null,
    training: { from: source.from, until: new Date(split).toISOString() },
    validation: { from: new Date(split).toISOString(), until: source.until },
    quality: { validDays: 0, coverage: 0, samples: 0, missing: expected, trainingCoverage: 0,
      validationCoverage: 0, expectedHours: expected, maxGapMs: 0 }, referenceBands: [],
    comparison: { observedAt: source.latest.observedAt, value: null, reference: null, deviation: null,
      deviationRatio: null, baselineAnomaly: null, staticAnomaly: null },
    staticComparison: { status: !input.staticThreshold ? 'not_configured' : source.reason || source.latest.value === null ? 'unknown' : 'known',
      threshold: input.staticThreshold ?? null, value: source.reason || !input.staticThreshold ? null : source.latest.value,
      anomaly: source.reason || source.latest.value === null ? null : staticFlag(source.latest.value, input.staticThreshold) },
    temporalReport: { status: 'insufficient', samples: 0, baselineFlags: null, staticFlags: null,
      labelledSamples: 0, falsePositiveRate: null, importantMisses: null, improvement: 'not_established' },
    exclusions: { policy: 'quality-only-no-labels-no-interpolation', excludedHours: expected },
    evaluatedAt: source.evaluatedAt, validUntil: source.validUntil, sourceFence: source.fence,
  };
  const unknown = (reason: string, invalidated = false): BaselineCalculation => ({ ...result,
    state: invalidated ? 'invalidated' : 'not_qualified', status: 'unknown', reason, referenceBands: [] });
  if (source.reason) return unknown(source.reason, ['series_identity_changed', 'configuration_changed', 'counter_reset', 'stale_observation', 'future_observation', 'observation_quality', 'late_collection'].includes(source.reason));
  if (!source.identity || until - from !== expected * HOUR || from % HOUR || until % HOUR
    || until > Date.parse(source.evaluatedAt) || Date.parse(source.validUntil) <= Date.parse(source.evaluatedAt)) return unknown('observation_window');
  const valid = new Map<number, { at: number; value: number; coverage: number; samples: number }>();
  const coverage = new Map<number, number>();
  for (const bucket of source.buckets) {
    const at = Date.parse(bucket.window.from), end = Date.parse(bucket.window.to), value = scalarNumber(bucket.value);
    if (at < from || end > until || at % HOUR || end - at !== HOUR || coverage.has(at)) return unknown('bucket_window');
    const acceptable = value !== null && bucket.accuracy === 'exact'
      && (bucket.quality.status === 'good' || bucket.quality.status === 'partial' && bucket.quality.reason === 'gap')
      && Number.isFinite(bucket.coverage) && bucket.coverage >= 0.9 && bucket.coverage <= 1;
    coverage.set(at, acceptable ? bucket.coverage : 0);
    if (acceptable) valid.set(at, { at, value, coverage: bucket.coverage, samples: bucket.sample_count });
  }
  const training = [...valid.values()].filter(b => b.at < split), validation = [...valid.values()].filter(b => b.at >= split);
  const sum = (rows: typeof training) => rows.reduce((n, b) => n + b.coverage, 0);
  const coverageRatio = (n: number, count: number) => Math.round(n / count * 1e12) / 1e12;
  result.quality.coverage = coverageRatio(sum(training) + sum(validation), expected);
  result.quality.trainingCoverage = coverageRatio(sum(training), (split - from) / HOUR);
  result.quality.validationCoverage = coverageRatio(sum(validation), 168);
  result.quality.samples = [...valid.values()].reduce((n, b) => n + b.samples, 0);
  result.quality.missing = expected - valid.size; result.exclusions.excludedHours = expected - valid.size;
  for (let at = from; at < until; at += DAY) {
    let dayCoverage = 0;
    for (let hour = at; hour < at + DAY; hour += HOUR) dayCoverage += valid.get(hour)?.coverage ?? 0;
    if (coverageRatio(dayCoverage, 24) >= 0.9) result.quality.validDays++;
  }
  // Consecutive missing hours are a hard break even with high global coverage.
  let gap = 0;
  for (let at = from; at < until; at += HOUR) {
    gap = valid.has(at) ? 0 : gap + HOUR; result.quality.maxGapMs = Math.max(result.quality.maxGapMs, gap);
  }
  if (result.quality.maxGapMs >= 6 * HOUR) return unknown('long_gap', true);
  if (result.quality.coverage < 0.9 || result.quality.trainingCoverage < 0.9 || result.quality.validationCoverage < 0.9) return unknown('coverage_below_90_percent');
  if (result.quality.validDays < expected / 24) return unknown('insufficient_valid_days');
  const groups = new Map<number, typeof training>();
  for (const b of training) { const key = slot(b.at, input.mode); groups.set(key, [...groups.get(key) ?? [], b]); }
  const bands: ReferenceBand[] = [];
  for (let key = 0; key < (input.mode === 'daily' ? 24 : 168); key++) {
    const rows = groups.get(key) ?? [], repeats = new Set(rows.map(b => new Date(b.at).toISOString().slice(0, 10))).size;
    if (repeats < (input.mode === 'daily' ? 7 : 3)) return unknown('insufficient_repeated_periods');
    const values = rows.map(b => b.value);
    bands.push({ slot: key, median: quantile(values, 0.5), lower: quantile(values, 0.1), upper: quantile(values, 0.9), repeats });
  }
  let highShift = 0, lowShift = 0, baselineFlags = 0, staticFlags = 0;
  for (const b of validation) {
    const band = bands[slot(b.at, input.mode)], residual = b.value - band.median;
    const severe = Math.max((band.upper - band.lower) * 3, Math.abs(band.median) * 0.5, 1e-9);
    if (residual > severe) highShift++; if (residual < -severe) lowShift++;
    if (isOutside(b.value, band)) baselineFlags++;
    if (staticFlag(b.value, input.staticThreshold)) staticFlags++;
  }
  result.temporalReport = { ...result.temporalReport, status: 'evaluated', samples: validation.length,
    baselineFlags, staticFlags: input.staticThreshold ? staticFlags : null };
  if (Math.max(highShift, lowShift) / validation.length > 0.5) return unknown('severe_drift', true);
  const value = source.latest.value, band = bands[slot(Date.parse(source.evaluatedAt), input.mode)];
  if (value === null || !Number.isFinite(value)) return unknown('current_value_unavailable');
  const deviation = value - band.median;
  if (!Number.isFinite(deviation)) return unknown('scalar_precision_unavailable');
  result.referenceBands = bands;
  result.comparison = { observedAt: source.latest.observedAt, value, reference: band, deviation,
    deviationRatio: band.median === 0 || !Number.isFinite(deviation / Math.abs(band.median)) ? null : deviation / Math.abs(band.median),
    baselineAnomaly: isOutside(value, band), staticAnomaly: staticFlag(value, input.staticThreshold) };
  return { ...result, state: 'qualified', status: 'known', reason: null };
}

/** Retain original evidence on disk; outward cached projections cannot keep
 * reporting normal/reference values after revocation, expiry or rollback. */
export function invalidateBaseline(value: BaselineCalculation, reason: string): BaselineCalculation {
  return { ...value, state: 'invalidated', status: 'unknown', reason, referenceBands: [],
    staticComparison: { ...value.staticComparison, status: value.staticComparison.threshold ? 'unknown' : 'not_configured', value: null, anomaly: null },
    comparison: { observedAt: null, value: null, reference: null, deviation: null, deviationRatio: null, baselineAnomaly: null, staticAnomaly: null } };
}
