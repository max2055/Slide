/**
 * MAX-239 — pure trigger evaluation over explicit observations and clock.
 *
 * No I/O, no store, no timer, no event, no outbox and no notification: this
 * module answers one question for one already-fenced snapshot and returns the
 * business verdict and the evidence quality as **two separate states**.
 *
 * Rules that make the answer unknown (never a recovery, never a healthy
 * verdict): missing input, stale input, non-contiguous or under-covered sample
 * windows, sample quality/accuracy outside the policy, a unit mismatch, a metric
 * semantic-version mismatch, clock skew, more dimension series than the budget,
 * and a snapshot that has no trusted applied evidence.
 *
 * Explicit nodata is clock-driven: `now` and `last_seen_at` decide it, so it does
 * not wait for a new sample. While a problem is open, missing/stale/unknown
 * evidence keeps the problem open — an interruption is not a recovery.
 *
 * Exact numbers come from the existing `arithmetic.ts` rational helpers, and the
 * quality/coverage/accuracy semantics mirror the accepted consumer evaluator
 * (`metrics/consumers/evaluation.ts`). This module does not build a second event
 * engine, does not create an episode and never acknowledges anything: there is no
 * acknowledgement input at all, so an acknowledgement cannot change these results.
 */
import { z } from 'zod';
import { TimestampSchema } from '../../contracts/metrics/index.js';
import {
  TriggerSampleSchema, TRIGGER_LIMITS,
  type ResolvedTriggerExpression, type TriggerClockPolicy, type TriggerItemIdentity,
  type TriggerQualityPolicy, type TriggerResourceSnapshot, type TriggerRuleSnapshot, type TriggerSample,
  type TriggerSelector,
} from '../../contracts/metrics/triggers.js';
import type { MetricRef } from '../templates/model.js';
import { add, compare, decode, divide, encode, numberValue, rational, type Rational } from '../arithmetic.js';
import { checkTriggerSnapshotFence } from './compile.js';

export const TriggerEvaluationInputSchema = z.strictObject({
  now: TimestampSchema,
  /** Arrival time of the newest sample; drives staleness and explicit nodata. */
  last_seen_at: TimestampSchema.nullable(),
  /** The business state of the open problem at the previous evaluation, if any. */
  previous: z.enum(['problem', 'healthy', 'unknown']).nullable(),
  samples: z.array(TriggerSampleSchema),
});
export type TriggerEvaluationInput = z.infer<typeof TriggerEvaluationInputSchema>;

export type TriggerEvaluationReason =
  | 'not_applied'
  | 'invalid_input'
  | 'rule_not_found'
  | 'nodata'
  | 'missing_input'
  | 'stale'
  | 'clock_skew'
  | 'metric_mismatch'
  | 'semantic_version_mismatch'
  | 'unit_mismatch'
  | 'insufficient_evidence'
  | 'gap'
  | 'series_budget_exceeded'
  | 'problem'
  | 'problem_retained'
  | 'recovered'
  | 'healthy';

export type TriggerBusinessState = 'problem' | 'healthy' | 'unknown';
export type TriggerEvidenceQuality = 'good' | 'partial' | 'unknown';

export interface TriggerEvaluationResult {
  rule: { rule_id: string; version: number };
  scope: string;
  item: TriggerItemIdentity;
  metric: MetricRef;
  /** The business verdict only. */
  business: TriggerBusinessState;
  /** The evidence verdict only; never folded into `business`. */
  quality: TriggerEvidenceQuality;
  /** True when a problem episode must stay open (including while evidence is unknown). */
  problem_open: boolean;
  /** True only for the evaluation that closed an open problem with recovery evidence. */
  recovery: boolean;
  /** The explicit missing-data signal; independent of the threshold verdicts. */
  nodata: boolean;
  reason: TriggerEvaluationReason;
  value: number | null;
  dimensions: Record<string, string> | null;
  series_count: number;
  evaluated_at: string;
}

export interface TriggerEvaluationRequest {
  input: unknown;
  /** Trusted applied evidence for this snapshot; without it nothing is evaluated. */
  applied: unknown;
}

const seriesKey = (dimensions: Record<string, string>): string =>
  JSON.stringify(Object.entries(dimensions).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));

const toNumber = (value: Rational): number | null => {
  const encoded = encode(value, 'float64');
  if (encoded.value === null || !('value' in encoded.value)) return null;
  return Number(encoded.value.value);
};

const thresholdRational = (threshold: Extract<ResolvedTriggerExpression, { node: 'compare' }>['threshold']): Rational =>
  numberValue(threshold.value);

/** One gate result: either a comparable value or the stable reason the evidence is unusable. */
type Selected = { kind: 'value'; value: Rational } | { kind: 'reason'; reason: TriggerEvaluationReason };

interface EvaluationContext {
  now: number;
  quality: TriggerQualityPolicy;
  clock: TriggerClockPolicy;
  series: TriggerSample[];
  cache: Map<string, Selected>;
}

/** Mirror the accepted consumer gate: quality, accuracy and coverage must all be acceptable. */
function gate(sample: TriggerSample, quality: TriggerQualityPolicy): TriggerEvaluationReason | null {
  if (!quality.accepted_quality.includes(sample.quality.status as 'good' | 'partial')) return 'insufficient_evidence';
  if (sample.accuracy === 'unknown') return 'insufficient_evidence';
  if (sample.accuracy === 'estimated' && !quality.allow_estimated) return 'insufficient_evidence';
  if (sample.coverage < quality.min_coverage) return 'insufficient_evidence';
  return null;
}

const numericOf = (sample: TriggerSample): Rational => decode(sample.value);

/**
 * Select one value for one leaf selector. `last` needs a fresh, covered newest
 * sample; a windowed aggregation needs contiguous sample windows that actually
 * cover the requested window and reach the present. Anything else is unknown:
 * an old sample never recovers an open problem.
 */
function selectValue(selector: TriggerSelector, context: EvaluationContext): Selected {
  const cacheKey = selector.aggregation === 'last' ? 'last' : `${selector.aggregation}:${selector.window_ms}`;
  const cached = context.cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = selectValueUncached(selector, context);
  context.cache.set(cacheKey, result);
  return result;
}

function selectValueUncached(selector: TriggerSelector, context: EvaluationContext): Selected {
  const samples = context.series;
  if (samples.length === 0) return { kind: 'reason', reason: 'missing_input' };

  if (selector.aggregation === 'last') {
    const newest = samples.reduce((left, right) =>
      Date.parse(right.observed_at) > Date.parse(left.observed_at) ? right : left);
    if (context.now - Date.parse(newest.observed_at) >= context.clock.stale_after_ms) {
      return { kind: 'reason', reason: 'stale' };
    }
    const problem = gate(newest, context.quality);
    if (problem !== null) return { kind: 'reason', reason: problem };
    return { kind: 'value', value: numericOf(newest) };
  }

  const windowMs = selector.window_ms;
  const from = context.now - windowMs;
  const inWindow = samples
    .filter(sample => Date.parse(sample.observed_at) <= context.now && Date.parse(sample.observed_at) > from)
    .sort((left, right) => Date.parse(left.observed_at) - Date.parse(right.observed_at));
  if (inWindow.length === 0) return { kind: 'reason', reason: 'missing_input' };
  if (inWindow.some(sample => sample.window === null)) return { kind: 'reason', reason: 'gap' };
  // Contiguity and coverage are judged on the sample windows, like the accepted
  // consumer evaluator: a hole in the middle is not an average of what is left.
  let coveredMs = 0;
  let cursor: number | null = null;
  for (const sample of inWindow) {
    const window = sample.window!;
    const start = Date.parse(window.from);
    const end = Date.parse(window.to);
    if (end <= start || end > context.now) return { kind: 'reason', reason: 'gap' };
    if (cursor !== null && start !== cursor) return { kind: 'reason', reason: 'gap' };
    cursor = end;
    coveredMs += end - start;
  }
  const first = Date.parse(inWindow[0].window!.from);
  const last = Date.parse(inWindow.at(-1)!.window!.to);
  if (first < from) return { kind: 'reason', reason: 'gap' };
  if (coveredMs / windowMs < context.quality.min_coverage) return { kind: 'reason', reason: 'insufficient_evidence' };
  if (context.now - last > context.clock.stale_after_ms) return { kind: 'reason', reason: 'stale' };

  for (const sample of inWindow) {
    const problem = gate(sample, context.quality);
    if (problem !== null) return { kind: 'reason', reason: problem };
  }

  if (selector.aggregation === 'min' || selector.aggregation === 'max') {
    const values = inWindow.map(numericOf);
    const picked = values.reduce((left, right) => {
      const order = compare(right, left);
      return (selector.aggregation === 'min' ? order < 0 : order > 0) ? right : left;
    });
    return { kind: 'value', value: picked };
  }
  const sum = inWindow.map(numericOf).reduce((total, value) => add(total, value), rational(0n));
  return { kind: 'value', value: divide(sum, rational(BigInt(inWindow.length))) };
}

type Verdict = { kind: 'value'; value: boolean } | { kind: 'reason'; reason: TriggerEvaluationReason };

/** Kleene AND/OR: a definitive child decides even if a sibling is unknown. */
function matches(expression: ResolvedTriggerExpression, context: EvaluationContext): Verdict {
  if (expression.node === 'compare') {
    const selected = selectValue(expression.select, context);
    if (selected.kind === 'reason') return selected;
    const order = compare(selected.value, thresholdRational(expression.threshold));
    switch (expression.operator) {
      case '>': return { kind: 'value', value: order > 0 };
      case '>=': return { kind: 'value', value: order >= 0 };
      case '<': return { kind: 'value', value: order < 0 };
      case '<=': return { kind: 'value', value: order <= 0 };
      case '=': return { kind: 'value', value: order === 0 };
      case '!=': return { kind: 'value', value: order !== 0 };
    }
  }
  const verdicts = expression.children.map(child => matches(child, context));
  let unknown: TriggerEvaluationReason | null = null;
  for (const verdict of verdicts) {
    if (verdict.kind === 'value') {
      if (expression.node === 'all' && !verdict.value) return verdict;
      if (expression.node === 'any' && verdict.value) return verdict;
    } else if (unknown === null) {
      unknown = verdict.reason;
    }
  }
  if (unknown !== null) return { kind: 'reason', reason: unknown };
  return { kind: 'value', value: expression.node === 'all' };
}


type Outcome = Pick<TriggerEvaluationResult,
  'business' | 'quality' | 'problem_open' | 'recovery' | 'nodata' | 'reason' | 'value' | 'dimensions' | 'series_count'>;

/** Every unknown outcome carries the same conservative defaults; only the reason differs. */
const unresolved = (reason: TriggerEvaluationReason, problem_open: boolean): Outcome => ({
  business: 'unknown', quality: 'unknown', problem_open, recovery: false, nodata: false,
  reason, value: null, dimensions: null, series_count: 0,
});

function evaluatedAt(input: unknown): string {
  const now = (input as { now?: unknown } | null | undefined)?.now;
  return typeof now === 'string' ? now : '1970-01-01T00:00:00Z';
}

function describe(rule: TriggerRuleSnapshot, at: string, outcome: Outcome): TriggerEvaluationResult {
  return {
    rule: { rule_id: rule.rule_id, version: rule.version },
    scope: rule.scope,
    item: rule.item,
    metric: rule.metric,
    evaluated_at: at,
    ...outcome,
  };
}

/**
 * Evaluate one rule of one frozen snapshot.
 *
 * `request.applied` is the trusted application evidence: unless it matches this
 * snapshot and says `applied`, the answer is unknown with `not_applied` — the
 * snapshot is a candidate, not a live rule.
 */
export function evaluateTriggerRule(
  snapshot: TriggerResourceSnapshot,
  key: { rule_id: string; scope: string },
  request: TriggerEvaluationRequest,
): TriggerEvaluationResult {
  const at = evaluatedAt(request.input);
  const parsedInput = TriggerEvaluationInputSchema.safeParse(request.input);
  // An input that fails validation is not evidence of recovery: if it still
  // states an open problem, that open problem is carried, not silently dropped.
  const rawPrevious = (request.input as { previous?: unknown } | null | undefined)?.previous;
  const carryProblem = parsedInput.success
    ? parsedInput.data.previous === 'problem'
    : rawPrevious === 'problem';
  const rule = snapshot.rules.find(entry => entry.rule_id === key.rule_id && entry.scope === key.scope);

  if (rule === undefined) {
    // A missing rule has no identity to report; the stable reason is the answer.
    return {
      rule: { rule_id: key.rule_id, version: 0 },
      scope: key.scope,
      item: { template_id: '', item_id: key.scope.slice('item:'.length), item_version: 0 },
      metric: { id: '', semantic_version: '0.0.0' },
      evaluated_at: at,
      ...unresolved('rule_not_found', false),
    };
  }

  const fence = checkTriggerSnapshotFence(snapshot, request.applied);
  if (!fence.ok) return describe(rule, at, unresolved('not_applied', carryProblem));
  if (!parsedInput.success) return describe(rule, at, unresolved('invalid_input', carryProblem));
  const input = parsedInput.data;

  const now = Date.parse(input.now);
  const nodataClock = rule.clock.nodata.enabled
    && (input.last_seen_at === null || now - Date.parse(input.last_seen_at) >= rule.clock.nodata.after_ms);
  if (nodataClock) {
    // Explicit nodata is clock-driven: it fires without any new sample, and it
    // never closes an open problem.
    return describe(rule, at, { ...unresolved('nodata', carryProblem), nodata: true });
  }
  if (input.last_seen_at === null) return describe(rule, at, unresolved('missing_input', carryProblem));
  if (now - Date.parse(input.last_seen_at) >= rule.clock.stale_after_ms) {
    return describe(rule, at, unresolved('stale', carryProblem));
  }
  if (input.samples.some(sample => Date.parse(sample.observed_at) > now)) {
    return describe(rule, at, unresolved('clock_skew', carryProblem));
  }
  if (input.samples.some(sample => sample.metric.id !== rule.metric.id)) {
    return describe(rule, at, unresolved('metric_mismatch', carryProblem));
  }
  if (input.samples.some(sample => sample.metric.semantic_version !== rule.metric.semantic_version)) {
    return describe(rule, at, unresolved('semantic_version_mismatch', carryProblem));
  }
  if (input.samples.some(sample => sample.unit !== rule.unit)) {
    return describe(rule, at, unresolved('unit_mismatch', carryProblem));
  }

  const groups = new Map<string, TriggerSample[]>();
  for (const sample of input.samples) {
    const keyOfSeries = seriesKey(sample.dimensions);
    const group = groups.get(keyOfSeries);
    if (group === undefined) groups.set(keyOfSeries, [sample]);
    else group.push(sample);
  }
  if (groups.size === 0) return describe(rule, at, unresolved('missing_input', carryProblem));
  if (groups.size > TRIGGER_LIMITS.max_series) {
    return describe(rule, at, unresolved('series_budget_exceeded', carryProblem));
  }

  // Deterministic dimension-key order: the reported series must not depend on
  // the arrival order of the samples.
  const series = [...groups.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, samples]) => samples);
  const problems: Verdict[] = [];
  const recoveries: Verdict[] = [];
  const qualities: TriggerEvidenceQuality[] = [];
  for (const samples of series) {
    const context: EvaluationContext = {
      now, quality: rule.quality, clock: rule.clock, series: samples, cache: new Map(),
    };
    problems.push(matches(rule.problem, context));
    recoveries.push(matches(rule.recovery, context));
    qualities.push(samples.some(sample => sample.quality.status !== 'good') ? 'partial' : 'good');
  }

  // An unusable evidence gate on any series makes the whole rule unknown; it
  // can never be read as a recovery.
  const blocking = problems.find(verdict => verdict.kind === 'reason')
    ?? recoveries.find(verdict => verdict.kind === 'reason');
  if (blocking !== undefined && blocking.kind === 'reason') {
    return describe(rule, at, { ...unresolved(blocking.reason, carryProblem), series_count: groups.size });
  }

  const problem = problems.some(verdict => verdict.kind === 'value' && verdict.value);
  // Recovery needs both its own evidence and the absence of the problem
  // condition: two expressions that happen to overlap must never close a live
  // problem.
  const recoveryEvidence = recoveries.every(verdict => verdict.kind === 'value' && verdict.value) && !problem;
  const evidenceQuality: TriggerEvidenceQuality = qualities.every(entry => entry === 'good') ? 'good' : 'partial';
  // Report the first series in sorted dimension-key order that actually makes the
  // problem condition true; an earlier healthy sibling must not supply the value.
  // When no series fires, the first series is the deterministic fallback.
  const reportedIndex = problem
    ? problems.findIndex(verdict => verdict.kind === 'value' && verdict.value)
    : 0;
  const reportedSeries = series[Math.max(reportedIndex, 0)];
  const reported = selectValue({ aggregation: 'last' }, {
    now, quality: rule.quality, clock: rule.clock, series: reportedSeries, cache: new Map(),
  });
  const shared = {
    quality: evidenceQuality,
    value: reported.kind === 'value' ? toNumber(reported.value) : null,
    dimensions: reportedSeries[0].dimensions,
    series_count: groups.size,
  };

  if (carryProblem) {
    return recoveryEvidence
      ? describe(rule, at, { ...shared, business: 'healthy', problem_open: false, recovery: true, nodata: false, reason: 'recovered' })
      : describe(rule, at, { ...shared, business: 'problem', problem_open: true, recovery: false, nodata: false, reason: 'problem_retained' });
  }
  return problem
    ? describe(rule, at, { ...shared, business: 'problem', problem_open: true, recovery: false, nodata: false, reason: 'problem' })
    : describe(rule, at, { ...shared, business: 'healthy', problem_open: false, recovery: false, nodata: false, reason: 'healthy' });
}
