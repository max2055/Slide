import { describe, expect, it } from 'vitest';
import type { TemplateVersion } from '../../contracts/metrics/templates.js';
import type { TriggerResourceSnapshot, TriggerRuleVersion } from '../../contracts/metrics/triggers.js';
import { baseline, near, portOf, thresholdRule, averageRule } from './test-support.js';
import { resolveTriggerRules } from './resolve.js';
import { compileTriggerSnapshot } from './compile.js';
import { evaluateTriggerRule, type TriggerEvaluationInput, type TriggerEvaluationResult } from './evaluate.js';

const evidenceFor = (snapshot: TriggerResourceSnapshot, overrides: Record<string, unknown> = {}) => ({
  resource: { type: snapshot.resource.type, id: Number(snapshot.resource.id) },
  applied_revision: snapshot.config_revision,
  plan_identity: snapshot.plan_identity,
  application_status: 'applied',
  ...overrides,
});

const DEFAULT_TRIGGERS: TemplateVersion['aggregate']['triggers'] = [
  { rule_id: 'alpha-threshold', scope: 'item:alpha', version: 1 },
  { rule_id: 'alpha-average', scope: 'item:alpha', version: 1 },
];

async function snapshotOf(options: {
  rules?: TriggerRuleVersion[];
  triggers?: TemplateVersion['aggregate']['triggers'];
} = {}): Promise<TriggerResourceSnapshot> {
  const base = await baseline(options);
  const candidate = await resolveTriggerRules(base.resolution, base.catalog, portOf([base.version]).port);
  return compileTriggerSnapshot(candidate);
}

const input = (overrides: Partial<TriggerEvaluationInput> = {}): TriggerEvaluationInput => ({
  now: '2026-10-29T12:00:00Z',
  last_seen_at: '2026-10-29T11:59:55.000Z',
  previous: null,
  samples: [near(95)],
  ...overrides,
});

function evaluate(
  snapshot: TriggerResourceSnapshot,
  request: Partial<TriggerEvaluationInput> = {},
  applied: Record<string, unknown> | null | undefined = undefined,
  key: { rule_id: string; scope: string } = { rule_id: 'alpha-threshold', scope: 'item:alpha' },
): TriggerEvaluationResult {
  return evaluateTriggerRule(snapshot, key, {
    input: input(request),
    applied: applied === undefined ? evidenceFor(snapshot) : applied,
  });
}

const windowAt = (from: string, to: string) => ({ from, to });

describe('pure trigger evaluation', () => {
  it('evaluates 95 → problem, 85 → keeps the problem, 60 → recovers', async () => {
    const snapshot = await snapshotOf();

    const firing = evaluate(snapshot);
    expect(firing).toMatchObject({
      business: 'problem', quality: 'good', problem_open: true, recovery: false, nodata: false,
      reason: 'problem', value: 95,
    });

    const holding = evaluate(snapshot, { previous: 'problem', samples: [near(85)] });
    expect(holding).toMatchObject({
      business: 'problem', quality: 'good', problem_open: true, recovery: false, reason: 'problem_retained',
    });

    const recovered = evaluate(snapshot, { previous: 'problem', samples: [near(60)] });
    expect(recovered).toMatchObject({
      business: 'healthy', quality: 'good', problem_open: false, recovery: true, reason: 'recovered',
    });

    const healthy = evaluate(snapshot, { samples: [near(60)] });
    expect(healthy).toMatchObject({ business: 'healthy', recovery: false, reason: 'healthy' });
  });

  it('honours the >90 and <70 boundaries exactly', async () => {
    const snapshot = await snapshotOf();
    expect(evaluate(snapshot, { samples: [near(90)] })).toMatchObject({ business: 'healthy', reason: 'healthy' });
    expect(evaluate(snapshot, { samples: [near(90.5)] })).toMatchObject({ business: 'problem', reason: 'problem' });
    expect(evaluate(snapshot, { previous: 'problem', samples: [near(70)] }))
      .toMatchObject({ business: 'problem', reason: 'problem_retained' });
    expect(evaluate(snapshot, { previous: 'problem', samples: [near(69.5)] }))
      .toMatchObject({ business: 'healthy', recovery: true, reason: 'recovered' });
  });

  it('fires explicit nodata from the clock and never recovers an open problem', async () => {
    const snapshot = await snapshotOf();

    const noData = evaluate(snapshot, { samples: [], last_seen_at: null });
    expect(noData).toMatchObject({ business: 'unknown', nodata: true, problem_open: false, recovery: false, reason: 'nodata' });

    const openProblem = evaluate(snapshot, { samples: [], last_seen_at: null, previous: 'problem' });
    expect(openProblem).toMatchObject({ business: 'unknown', nodata: true, problem_open: true, recovery: false, reason: 'nodata' });

    // It does not wait for a new sample: old arrivals plus the clock are enough.
    const clockOnly = evaluate(snapshot, {
      samples: [near(95, { observed_at: '2026-10-29T11:50:00.000Z' })],
      last_seen_at: '2026-10-29T11:50:00.000Z',
      previous: 'problem',
    });
    expect(clockOnly).toMatchObject({ nodata: true, problem_open: true, recovery: false, reason: 'nodata' });
  });

  it('reports missing and stale input as unknown and keeps the problem open', async () => {
    const snapshot = await snapshotOf();
    expect(evaluate(snapshot, { samples: [], last_seen_at: null, previous: 'problem' })).toMatchObject({
      nodata: true, problem_open: true, recovery: false,
    });

    // A 200s-old sample with a fresh arrival timestamp is still not recovery evidence.
    const staleSample = evaluate(snapshot, {
      previous: 'problem',
      samples: [near(10, { observed_at: '2026-10-29T11:56:40.000Z' })],
    });
    expect(staleSample).toMatchObject({
      business: 'unknown', quality: 'unknown', problem_open: true, recovery: false, reason: 'stale', value: null,
    });

    // With explicit nodata disabled, a stale arrival clock alone is still unknown.
    const noNodata = await snapshotOf({
      rules: [thresholdRule({ clock: { stale_after_ms: 120000, nodata: { enabled: false } } })],
      triggers: [{ rule_id: 'alpha-threshold', scope: 'item:alpha', version: 1 }],
    });
    const staleClock = evaluate(noNodata, { previous: 'problem', last_seen_at: '2026-10-29T11:50:00.000Z' });
    expect(staleClock).toMatchObject({ business: 'unknown', problem_open: true, recovery: false, reason: 'stale' });

    const noSamples = evaluate(snapshot, { samples: [] });
    expect(noSamples).toMatchObject({ business: 'unknown', reason: 'missing_input', recovery: false });
  });

  it('treats a unit or semantic-version mismatch as unknown, never as recovery', async () => {
    const snapshot = await snapshotOf();
    const unitMismatch = evaluate(snapshot, { previous: 'problem', samples: [near(10, { unit: 'count' })] });
    expect(unitMismatch).toMatchObject({ business: 'unknown', problem_open: true, recovery: false, reason: 'unit_mismatch' });

    const versionMismatch = evaluate(snapshot, {
      previous: 'problem',
      samples: [near(10, { metric: { id: 'fixture.alpha', semantic_version: '2.0.0' } })],
    });
    expect(versionMismatch).toMatchObject({ business: 'unknown', problem_open: true, recovery: false, reason: 'semantic_version_mismatch' });

    const metricMismatch = evaluate(snapshot, {
      previous: 'problem',
      samples: [near(10, { metric: { id: 'fixture.beta', semantic_version: '1.0.0' }, unit: 'count' })],
    });
    expect(metricMismatch.reason).toBe('metric_mismatch');
    expect(metricMismatch.problem_open).toBe(true);
  });

  it('keeps business and evidence quality independent', async () => {
    const snapshot = await snapshotOf();
    const partial = evaluate(snapshot, {
      samples: [near(95, { quality: { status: 'partial', reason: 'partial_input' } })],
    });
    expect(partial).toMatchObject({ business: 'problem', quality: 'partial', reason: 'problem' });

    const lowCoverage = evaluate(snapshot, { previous: 'problem', samples: [near(10, { coverage: 0.5 })] });
    expect(lowCoverage).toMatchObject({ business: 'unknown', quality: 'unknown', problem_open: true, recovery: false, reason: 'insufficient_evidence' });

    const estimated = evaluate(snapshot, {
      previous: 'problem',
      samples: [near(10, { accuracy: 'estimated' })],
    });
    expect(estimated).toMatchObject({ business: 'unknown', problem_open: true, reason: 'insufficient_evidence' });

    const unknownQuality = evaluate(snapshot, {
      previous: 'problem',
      samples: [near(10, { quality: { status: 'invalid', reason: 'source_error' } })],
    });
    expect(unknownQuality).toMatchObject({ business: 'unknown', problem_open: true, reason: 'insufficient_evidence' });
  });

  it('evaluates a bounded window average and rejects gaps and thin coverage', async () => {
    const snapshot = await snapshotOf();
    const averageKey = { rule_id: 'alpha-average', scope: 'item:alpha' };
    const windowed = (value: number, from: string, to: string) =>
      near(value, { window: windowAt(from, to), observed_at: to });

    const complete = evaluate(snapshot, {
      samples: [windowed(90, '2026-10-29T11:59:00.000Z', '2026-10-29T11:59:30.000Z'),
        windowed(90, '2026-10-29T11:59:30.000Z', '2026-10-29T12:00:00.000Z')],
    }, undefined, averageKey);
    expect(complete).toMatchObject({ business: 'problem', reason: 'problem', quality: 'good' });

    const gapped = evaluate(snapshot, {
      previous: 'problem',
      samples: [windowed(10, '2026-10-29T11:59:00.000Z', '2026-10-29T11:59:30.000Z'),
        windowed(10, '2026-10-29T11:59:45.000Z', '2026-10-29T12:00:00.000Z')],
    }, undefined, averageKey);
    expect(gapped).toMatchObject({ business: 'unknown', problem_open: true, recovery: false, reason: 'gap' });

    const thin = evaluate(snapshot, {
      previous: 'problem',
      samples: [windowed(10, '2026-10-29T11:59:30.000Z', '2026-10-29T12:00:00.000Z')],
    }, undefined, averageKey);
    expect(thin).toMatchObject({ business: 'unknown', problem_open: true, recovery: false, reason: 'insufficient_evidence' });

    const lastOnly = evaluate(snapshot, { previous: 'problem', samples: [near(10)] }, undefined, averageKey);
    expect(lastOnly).toMatchObject({ business: 'unknown', problem_open: true, reason: 'gap' });
  });

  it('combines AND/OR with Kleene unknown handling', async () => {
    const rule = thresholdRule({
      problem: {
        node: 'all',
        children: [
          { node: 'compare', select: { aggregation: 'last' }, operator: '>', threshold: { kind: 'constant', value: 90 } },
          { node: 'compare', select: { aggregation: 'avg', window_ms: 60000 }, operator: '>', threshold: { kind: 'constant', value: 0 } },
        ],
      },
    }) as TriggerRuleVersion;
    const snapshot = await snapshotOf({ rules: [rule], triggers: [{ rule_id: 'alpha-threshold', scope: 'item:alpha', version: 1 }] });

    // The windowed child is unknown, so the whole AND is unknown even though the last sample matches.
    const unknown = evaluate(snapshot, { previous: 'problem' });
    expect(unknown).toMatchObject({ business: 'unknown', problem_open: true, recovery: false, reason: 'gap' });

    const bothTrue = evaluate(snapshot, {
      samples: [
        near(95, { window: windowAt('2026-10-29T11:59:00.000Z', '2026-10-29T11:59:30.000Z'), observed_at: '2026-10-29T11:59:30.000Z' }),
        near(95, { window: windowAt('2026-10-29T11:59:30.000Z', '2026-10-29T12:00:00.000Z'), observed_at: '2026-10-29T12:00:00.000Z' }),
      ],
    });
    expect(bothTrue).toMatchObject({ business: 'problem', reason: 'problem' });
  });

  it('refuses to evaluate without matching applied evidence', async () => {
    const snapshot = await snapshotOf();
    const pending = evaluate(snapshot, {}, evidenceFor(snapshot, { application_status: 'pending' }));
    expect(pending).toMatchObject({ business: 'unknown', quality: 'unknown', reason: 'not_applied', recovery: false });
    expect(evaluate(snapshot, { previous: 'problem' }, evidenceFor(snapshot, { application_status: 'pending' })))
      .toMatchObject({ problem_open: true, recovery: false, reason: 'not_applied' });
    expect(evaluate(snapshot, {}, null)).toMatchObject({ reason: 'not_applied' });
    expect(evaluate(snapshot, {}, evidenceFor(snapshot, { applied_revision: 3 }))).toMatchObject({ reason: 'not_applied' });
  });

  it('does not accept any acknowledgement input, so an ack cannot recover', async () => {
    const snapshot = await snapshotOf();
    const ack = evaluate(snapshot, { previous: 'problem', samples: [near(95)], acknowledged_by: 42 } as unknown as Partial<TriggerEvaluationInput>);
    expect(ack).toMatchObject({ business: 'unknown', reason: 'invalid_input', recovery: false, problem_open: true });

    // The contract has no acknowledged field at all.
    const shape = evaluate(snapshot, { previous: 'problem', samples: [near(85)] });
    expect(shape).toMatchObject({ business: 'problem', problem_open: true, recovery: false });
  });

  it('bounds the number of series it will evaluate', async () => {
    const snapshot = await snapshotOf();
    const samples = Array.from({ length: 33 }, (_unused, index) => near(95, { dimensions: { series: `s${index}` } }));
    expect(evaluate(snapshot, { samples })).toMatchObject({ business: 'unknown', reason: 'series_budget_exceeded', recovery: false });
    const within = Array.from({ length: 32 }, (_unused, index) => near(95, { dimensions: { series: `s${index}` } }));
    expect(evaluate(snapshot, { samples: within })).toMatchObject({ business: 'problem' });
  });

  it('reports clock skew and an unknown rule with stable reasons', async () => {
    const snapshot = await snapshotOf();
    const future = evaluate(snapshot, { samples: [near(95, { observed_at: '2026-10-29T12:00:05.000Z' })] });
    expect(future).toMatchObject({ business: 'unknown', reason: 'clock_skew', recovery: false });

    const absent = evaluate(snapshot, {}, undefined, { rule_id: 'ghost', scope: 'item:alpha' });
    expect(absent).toMatchObject({ business: 'unknown', reason: 'rule_not_found' });
  });

  it('evaluates each dimension series and keeps the problem open while one is unknown', async () => {
    const snapshot = await snapshotOf();
    const mixed = evaluate(snapshot, {
      previous: 'problem',
      samples: [
        near(10, { dimensions: { mount: '/a' } }),
        near(95, { dimensions: { mount: '/b' }, quality: { status: 'invalid', reason: 'source_error' } }),
      ],
    });
    expect(mixed).toMatchObject({ business: 'unknown', problem_open: true, recovery: false, reason: 'insufficient_evidence' });

    const allRecover = evaluate(snapshot, {
      previous: 'problem',
      samples: [near(10, { dimensions: { mount: '/a' } }), near(10, { dimensions: { mount: '/b' } })],
    });
    expect(allRecover).toMatchObject({ business: 'healthy', recovery: true });
  });

  it('reports the first firing series in dimension-key order, not a healthy sibling', async () => {
    const snapshot = await snapshotOf({
      rules: [thresholdRule()],
      triggers: [{ rule_id: 'alpha-threshold', scope: 'item:alpha', version: 1 }],
    });

    // A healthy series arriving first must not supply the reported value.
    const mixed = evaluate(snapshot, {
      samples: [
        near(10, { dimensions: { mount: '/healthy' } }),
        near(95, { dimensions: { mount: '/breach' } }),
      ],
    });
    expect(mixed).toMatchObject({
      business: 'problem', reason: 'problem', value: 95,
      dimensions: { mount: '/breach' }, series_count: 2,
    });

    // Several firing series: the first in sorted dimension-key order wins, not
    // the first in arrival order and not the highest value.
    const several = evaluate(snapshot, {
      samples: [
        near(95, { dimensions: { mount: '/z-breach' } }),
        near(96, { dimensions: { mount: '/a-breach' } }),
      ],
    });
    expect(several).toMatchObject({
      business: 'problem', value: 96, dimensions: { mount: '/a-breach' },
    });
  });

  it('keeps the small recovery rule wired to the same snapshot cleanly', async () => {
    const snapshot = await snapshotOf({ rules: [averageRule({ rule_id: 'alpha-average' }), thresholdRule()] });
    expect(snapshot.rules.map(rule => rule.rule_id).sort()).toEqual(['alpha-average', 'alpha-threshold']);
    expect(DEFAULT_TRIGGERS).toHaveLength(2);
  });
});
