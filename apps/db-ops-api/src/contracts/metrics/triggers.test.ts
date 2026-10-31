import { describe, expect, it } from 'vitest';
import * as metricsContracts from './index.js';
import {
  ResolvedTriggerExpressionSchema, TRIGGER_LIMITS, TriggerAppliedEvidenceSchema, TriggerClockPolicySchema,
  TriggerExpressionSchema, TriggerResourceSnapshotSchema, TriggerRuleVersionSchema, TriggerSampleSchema,
  type TriggerExpression, type TriggerRuleVersion,
} from './triggers.js';

type RuleBody = Omit<TriggerRuleVersion, 'content_hash'>;

const compare = (overrides: Partial<Extract<TriggerExpression, { node: 'compare' }>> = {}): TriggerExpression => ({
  node: 'compare', select: { aggregation: 'avg', window_ms: 60000 }, operator: '>',
  threshold: { kind: 'parameter', name: 'problem_threshold' }, ...overrides,
});

const body = (): RuleBody => ({
  rule_id: 'alpha-threshold',
  version: 1,
  scope: 'item:alpha',
  metric: { id: 'fixture.alpha', semantic_version: '1.0.0' },
  unit: '1',
  parameters: {
    schema: {
      problem_threshold: { type: 'number', min: 0, max: 1000 },
      recovery_threshold: { type: 'number' },
    },
    defaults: { problem_threshold: 90, recovery_threshold: 70 },
  },
  problem: compare(),
  recovery: compare({ select: { aggregation: 'last' }, operator: '<', threshold: { kind: 'parameter', name: 'recovery_threshold' } }),
  quality: { accepted_quality: ['good', 'partial'], min_coverage: 1, allow_estimated: false },
  clock: { stale_after_ms: 120000, nodata: { enabled: true, after_ms: 300000 } },
});

const rule = (overrides: Partial<RuleBody> = {}) => ({
  ...body(), ...overrides, content_hash: `sha256:${'0'.repeat(64)}`,
});

describe('internal trigger contract', () => {
  it('stays unmounted from the public metrics contract index', () => {
    expect(Object.keys(metricsContracts)).not.toContain('TriggerRuleVersionSchema');
    expect(Object.keys(metricsContracts)).not.toContain('TRIGGER_LIMITS');
  });

  it('accepts a fixed rule version with parameters and AND/OR groups', () => {
    expect(TriggerRuleVersionSchema.safeParse(rule()).success).toBe(true);
    const grouped = rule({
      problem: {
        node: 'all',
        children: [
          compare({ select: { aggregation: 'last' }, threshold: { kind: 'constant', value: 90 } }),
          {
            node: 'any',
            children: [
              compare({ select: { aggregation: 'avg', window_ms: 60000 }, operator: '>=' }),
              compare({ select: { aggregation: 'min', window_ms: 60000 }, operator: '<', threshold: { kind: 'parameter', name: 'recovery_threshold' } }),
            ],
          },
        ],
      },
    });
    expect(TriggerRuleVersionSchema.safeParse(grouped).success).toBe(true);
  });

  it('rejects windows, thresholds, groups and keys outside the declared bounds', () => {
    const tooWide = rule({
      problem: compare({ select: { aggregation: 'avg', window_ms: TRIGGER_LIMITS.max_window_ms + 1 } }),
    });
    expect(TriggerRuleVersionSchema.safeParse(tooWide).success).toBe(false);

    for (const value of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const invalid = rule({ recovery: compare({ threshold: { kind: 'constant', value } }) });
      expect(TriggerRuleVersionSchema.safeParse(invalid).success).toBe(false);
    }

    const singleChild = rule({ problem: { node: 'all', children: [compare()] } as TriggerExpression });
    expect(TriggerRuleVersionSchema.safeParse(singleChild).success).toBe(false);

    expect(TriggerRuleVersionSchema.safeParse({ ...rule(), script: 'return true' }).success).toBe(false);
    expect(TriggerRuleVersionSchema.safeParse({ ...rule(), scope: 'metric:alpha' }).success).toBe(false);

    const badOperator = rule({ problem: compare({ operator: 'starts_with' as never }) });
    expect(TriggerRuleVersionSchema.safeParse(badOperator).success).toBe(false);
  });

  it('keeps explicit nodata shapes unambiguous', () => {
    expect(TriggerClockPolicySchema.safeParse({ stale_after_ms: 1000, nodata: { enabled: false } }).success).toBe(true);
    expect(TriggerClockPolicySchema.safeParse({ stale_after_ms: 1000, nodata: { enabled: true, after_ms: 500 } }).success).toBe(true);
    expect(TriggerClockPolicySchema.safeParse({ stale_after_ms: 1000, nodata: { enabled: false, after_ms: 500 } }).success).toBe(false);
    expect(TriggerClockPolicySchema.safeParse({ stale_after_ms: 1000, nodata: { enabled: true } }).success).toBe(false);
    expect(TriggerClockPolicySchema.safeParse({ stale_after_ms: 0, nodata: { enabled: false } }).success).toBe(false);
  });

  it('distinguishes an unresolved expression from a resolved one', () => {
    const unresolved = compare();
    expect(TriggerExpressionSchema.safeParse(unresolved).success).toBe(true);
    expect(ResolvedTriggerExpressionSchema.safeParse(unresolved).success).toBe(false);
    expect(ResolvedTriggerExpressionSchema.safeParse(compare({ threshold: { kind: 'constant', value: 90 } })).success).toBe(true);
  });

  it('requires a hash and a fixed template pin on a snapshot', () => {
    const snapshot = {
      kind: 'template_trigger_snapshot', internal: true, persisted: false, applied: false, effective: false,
      status: 'candidate', resource: { type: 'instance', id: '7' }, config_revision: 4,
      plan_identity: `sha256:${'0'.repeat(64)}`, templates: [], rules: [],
    };
    expect(TriggerResourceSnapshotSchema.safeParse(snapshot).success).toBe(false);
    expect(TriggerResourceSnapshotSchema.safeParse({ ...snapshot, snapshot_hash: `sha256:${'0'.repeat(64)}` }).success).toBe(false);
    expect(TriggerResourceSnapshotSchema.safeParse({
      ...snapshot,
      templates: [{ template_id: 'tpl', version: 1, content_hash: `sha256:${'0'.repeat(64)}` }],
      snapshot_hash: `sha256:${'0'.repeat(64)}`,
    }).success).toBe(true);
  });

  it('requires numeric trusted application evidence', () => {
    const trusted = {
      resource: { type: 'instance', id: 7 }, applied_revision: 4,
      plan_identity: `sha256:${'0'.repeat(64)}`, application_status: 'applied',
    };
    expect(TriggerAppliedEvidenceSchema.safeParse(trusted).success).toBe(true);
    expect(TriggerAppliedEvidenceSchema.safeParse({ ...trusted, resource: { type: 'instance', id: '7' } }).success).toBe(false);
    expect(TriggerAppliedEvidenceSchema.safeParse({ ...trusted, application_status: 'live' }).success).toBe(false);
    expect(TriggerAppliedEvidenceSchema.safeParse({ ...trusted, applied_revision: 0 }).success).toBe(false);
  });

  it('accepts only scalar samples with bounded coverage', () => {
    const sample = {
      metric: { id: 'fixture.alpha', semantic_version: '1.0.0' }, unit: '1',
      value: { encoding: 'float64', value: 95 }, observed_at: '2026-10-29T11:59:55.000Z',
      dimensions: {}, quality: { status: 'good', reason: 'none' }, accuracy: 'exact', coverage: 1, window: null,
    };
    expect(TriggerSampleSchema.safeParse(sample).success).toBe(true);
    expect(TriggerSampleSchema.safeParse({ ...sample, coverage: 1.5 }).success).toBe(false);
    expect(TriggerSampleSchema.safeParse({ ...sample, value: { encoding: 'histogram' } }).success).toBe(false);
  });
});
