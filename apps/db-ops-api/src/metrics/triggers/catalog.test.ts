import { describe, expect, it } from 'vitest';
import type { TemplateVersion } from '../../contracts/metrics/templates.js';
import type { TriggerResourceSnapshot, TriggerRuleVersion } from '../../contracts/metrics/triggers.js';
import { NOW, baseline, near, parameterSpec, portOf, thresholdRule } from './test-support.js';
import { resolveTriggerRules } from './resolve.js';
import { compileTriggerSnapshot } from './compile.js';
import { evaluateTriggerRule, type TriggerEvaluationInput, type TriggerEvaluationResult } from './evaluate.js';
import { triggerEpisodeIdentityHash, type TriggerEpisodeIdentity } from './episode.js';
import { TriggerEpisodeCatalog } from './catalog.js';

const KEY = { rule_id: 'alpha-threshold', scope: 'item:alpha' };
const TRIGGERS: TemplateVersion['aggregate']['triggers'] = [{ ...KEY, version: 1 }];

const evidenceFor = (snapshot: TriggerResourceSnapshot, overrides: Record<string, unknown> = {}) => ({
  resource: { type: snapshot.resource.type, id: Number(snapshot.resource.id) },
  applied_revision: snapshot.config_revision,
  plan_identity: snapshot.plan_identity,
  application_status: 'applied',
  ...overrides,
});

async function snapshotOf(options: { rules?: TriggerRuleVersion[] } = {}): Promise<TriggerResourceSnapshot> {
  const base = await baseline({ ...options, triggers: TRIGGERS });
  const candidate = await resolveTriggerRules(base.resolution, base.catalog, portOf([base.version]).port);
  return compileTriggerSnapshot(candidate);
}

function evaluate(
  snapshot: TriggerResourceSnapshot,
  request: Partial<TriggerEvaluationInput> = {},
  applied: Record<string, unknown> | null | undefined = undefined,
): TriggerEvaluationResult {
  return evaluateTriggerRule(snapshot, KEY, {
    input: { now: NOW, last_seen_at: '2026-10-29T11:59:55.000Z', previous: null, samples: [near(95)], ...request },
    applied: applied === undefined ? evidenceFor(snapshot) : applied,
  });
}

function identityOf(snapshot: TriggerResourceSnapshot): TriggerEpisodeIdentity {
  const rule = snapshot.rules.find(entry => entry.rule_id === KEY.rule_id && entry.scope === KEY.scope)!;
  return {
    resource: snapshot.resource, rule_id: rule.rule_id, version: rule.version,
    body_hash: rule.body_hash, scope: rule.scope,
  };
}

async function ninetyFiveSnapshot(): Promise<TriggerResourceSnapshot> {
  return snapshotOf({
    rules: [thresholdRule({
      parameters: parameterSpec(
        {
          problem_threshold: { type: 'number' as const, min: 0, max: 1000 },
          recovery_threshold: { type: 'number' as const, min: 0, max: 1000 },
        },
        { problem_threshold: 95, recovery_threshold: 70 },
      ),
    })],
  });
}

describe('in-memory episode catalog', () => {
  it('keeps one episode id through repeated problems, closes once and opens the next occurrence from the stored record', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const catalog = new TriggerEpisodeCatalog();
    expect(catalog.get(identity)).toBeNull();

    const opened = catalog.apply(identity, evaluate(snapshot))!;
    expect(opened).toMatchObject({ state: 'open', occurrence: 0, closed_at: null, recovery_count: 0 });
    expect(opened.identity_hash).toBe(triggerEpisodeIdentityHash(identity));
    expect(catalog.size).toBe(1);
    expect(catalog.get(identity)).toBe(opened);

    // A repeated, still-firing problem reads the stored record back: same id.
    const retained = catalog.apply(identity, evaluate(snapshot, { previous: 'problem', samples: [near(85)] }))!;
    expect(retained.episode_id).toBe(opened.episode_id);
    expect(retained).toMatchObject({ state: 'open', last: { reason: 'problem_retained' } });
    expect(catalog.size).toBe(1);

    const recovered = evaluate(snapshot, { previous: 'problem', samples: [near(60)] });
    const closed = catalog.apply(identity, recovered)!;
    expect(closed).toMatchObject({ state: 'closed', closed_at: NOW, recovery_count: 1 });

    // Replaying the recovery over the stored closed record opens nothing and
    // closes no second time.
    const replay = catalog.apply(identity, recovered)!;
    expect(replay).toBe(closed);
    expect(replay.recovery_count).toBe(1);
    expect(catalog.size).toBe(1);

    // The closed record is read back, so the next definite problem is occurrence 1
    // under a new id.
    expect(catalog.get(identity)).toBe(closed);
    const reopened = catalog.apply(identity, evaluate(snapshot))!;
    expect(reopened.episode_id).not.toBe(opened.episode_id);
    expect(reopened).toMatchObject({ state: 'open', occurrence: 1, closed_at: null, recovery_count: 0 });
    expect(catalog.size).toBe(1);
  });

  it('keeps the episode open for unknown, nodata, stale, missing, low-quality and not-applied evidence', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);

    const cases: Array<{ name: string; expected: string; result: TriggerEvaluationResult }> = [
      {
        name: 'low-quality sample',
        expected: 'insufficient_evidence',
        result: evaluate(snapshot, {
          previous: 'problem',
          samples: [near(95, { quality: { status: 'invalid', reason: 'source_error' } })],
        }),
      },
      {
        name: 'nodata',
        expected: 'nodata',
        result: evaluate(snapshot, { previous: 'problem', samples: [], last_seen_at: null }),
      },
      {
        name: 'stale sample',
        expected: 'stale',
        result: evaluate(snapshot, {
          previous: 'problem', samples: [near(95, { observed_at: '2026-10-29T11:56:40.000Z' })],
        }),
      },
      {
        name: 'missing input',
        expected: 'missing_input',
        result: evaluate(snapshot, { previous: 'problem', samples: [] }),
      },
      {
        name: 'snapshot not applied',
        expected: 'not_applied',
        result: evaluate(snapshot, { previous: 'problem' }, evidenceFor(snapshot, { application_status: 'pending' })),
      },
    ];

    for (const entry of cases) {
      expect(entry.result.reason, entry.name).toBe(entry.expected);
      expect(entry.result.recovery, entry.name).toBe(false);

      const catalog = new TriggerEpisodeCatalog();
      const opened = catalog.apply(identity, evaluate(snapshot))!;
      const kept = catalog.apply(identity, entry.result)!;
      expect(kept.episode_id, entry.name).toBe(opened.episode_id);
      expect(kept, entry.name).toMatchObject({ state: 'open', closed_at: null, recovery_count: 0 });
      expect(catalog.get(identity), entry.name).toBe(kept);
      expect(catalog.size, entry.name).toBe(1);
    }
  });

  it('starts at occurrence 0 on an empty catalog — an in-memory catalog has no restart recovery', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);

    const catalog = new TriggerEpisodeCatalog();
    const opened = catalog.apply(identity, evaluate(snapshot))!;
    expect(opened).toMatchObject({ state: 'open', occurrence: 0 });

    // A process restart is a new, empty catalog: the same problem opens
    // occurrence 0 again — under the same derived id as the first occurrence 0.
    // This is the honest state of an unmounted in-memory catalog, recorded as a
    // counterexample; it is not evidence that a restart resumes the episode.
    const restarted = new TriggerEpisodeCatalog();
    expect(restarted.size).toBe(0);
    expect(restarted.get(identity)).toBeNull();
    const reopened = restarted.apply(identity, evaluate(snapshot))!;
    expect(reopened).toMatchObject({ state: 'open', occurrence: 0 });
    expect(reopened.episode_id).toBe(opened.episode_id);
  });

  it('keeps the 90 and 95 bodies in separate records and never rewrites the other identity', async () => {
    const ninety = await snapshotOf();
    const ninetyFive = await ninetyFiveSnapshot();
    const identity90 = identityOf(ninety);
    const identity95 = identityOf(ninetyFive);
    expect(identity90.body_hash).not.toBe(identity95.body_hash);

    const catalog = new TriggerEpisodeCatalog();
    const opened90 = catalog.apply(identity90, evaluate(ninety))!;
    const opened95 = catalog.apply(identity95, evaluate(ninetyFive, { samples: [near(99)] }))!;

    expect(opened95.identity_hash).not.toBe(opened90.identity_hash);
    expect(opened95.episode_id).not.toBe(opened90.episode_id);
    expect(opened95).toMatchObject({ state: 'open', occurrence: 0, recovery_count: 0 });
    expect(catalog.size).toBe(2);
    // The 90 record is not rewritten by the 95 evaluation.
    expect(catalog.get(identity90)).toBe(opened90);
    expect(catalog.get(identity90)).toMatchObject({ state: 'open', recovery_count: 0, last: { reason: 'problem' } });

    // Recovering the 95 identity closes only that record.
    const closed95 = catalog.apply(identity95, evaluate(ninetyFive, { previous: 'problem', samples: [near(60)] }))!;
    expect(closed95).toMatchObject({ state: 'closed', recovery_count: 1 });
    expect(catalog.get(identity90)).toBe(opened90);
    expect(catalog.get(identity90)).toMatchObject({ state: 'open', closed_at: null });
    expect(catalog.size).toBe(2);
  });

  it('has no acknowledgement input, so an ack can neither close nor prevent a close', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const recovered = evaluate(snapshot, { previous: 'problem', samples: [near(60)] });
    const acknowledged = { ...recovered, acknowledged_by: 42, acknowledged_at: NOW } as unknown as TriggerEvaluationResult;

    const catalog = new TriggerEpisodeCatalog();
    const opened = catalog.apply(identity, evaluate(snapshot))!;
    const closed = catalog.apply(identity, acknowledged)!;
    expect(closed).toMatchObject({ state: 'closed', recovery_count: 1 });
    expect(closed.episode_id).toBe(opened.episode_id);
    expect(closed).not.toHaveProperty('acknowledged_by');
    expect(closed.last).not.toHaveProperty('acknowledged_at');
    expect(catalog.get(identity)).toBe(closed);

    // The same recovery without any acknowledgement field produces the same record.
    const plainCatalog = new TriggerEpisodeCatalog();
    plainCatalog.apply(identity, evaluate(snapshot));
    expect(plainCatalog.apply(identity, recovered)).toEqual(catalog.get(identity));
  });

  it('leaves the catalog untouched when the pure transition records nothing', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const catalog = new TriggerEpisodeCatalog();

    expect(catalog.apply(identity, evaluate(snapshot, { samples: [near(60)] }))).toBeNull();
    expect(catalog.apply(identity, evaluate(snapshot, { samples: [], last_seen_at: null }))).toBeNull();
    expect(catalog.apply(identity, evaluate(snapshot, { previous: 'problem', samples: [near(60)] }))).toBeNull();
    expect(catalog.size).toBe(0);
    expect(catalog.get(identity)).toBeNull();
  });

  it('reads by the full identity — resource and scope are part of the key', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const catalog = new TriggerEpisodeCatalog();
    const opened = catalog.apply(identity, evaluate(snapshot))!;

    expect(catalog.get(identity)).toBe(opened);
    expect(catalog.get({ ...identity, resource: { type: 'instance', id: '8' } })).toBeNull();
    expect(catalog.get({ ...identity, scope: 'item:beta' })).toBeNull();
    expect(catalog.get({ ...identity, rule_id: 'alpha-average' })).toBeNull();
    expect(catalog.size).toBe(1);
  });
});
