import { describe, expect, it } from 'vitest';
import type { TemplateVersion } from '../../contracts/metrics/templates.js';
import type { TriggerResourceSnapshot, TriggerRuleVersion } from '../../contracts/metrics/triggers.js';
import { NOW, baseline, near, parameterSpec, portOf, thresholdRule } from './test-support.js';
import { resolveTriggerRules } from './resolve.js';
import { compileTriggerSnapshot } from './compile.js';
import { evaluateTriggerRule, type TriggerEvaluationInput, type TriggerEvaluationResult } from './evaluate.js';
import {
  nextTriggerEpisode, triggerEpisodeIdentityHash, type TriggerEpisodeIdentity,
} from './episode.js';

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
  key: { rule_id: string; scope: string } = KEY,
): TriggerEvaluationResult {
  return evaluateTriggerRule(snapshot, key, {
    input: { now: NOW, last_seen_at: '2026-10-29T11:59:55.000Z', previous: null, samples: [near(95)], ...request },
    applied: evidenceFor(snapshot),
  });
}

function identityOf(
  snapshot: TriggerResourceSnapshot,
  key: { rule_id: string; scope: string } = KEY,
): TriggerEpisodeIdentity {
  const rule = snapshot.rules.find(entry => entry.rule_id === key.rule_id && entry.scope === key.scope)!;
  return {
    resource: snapshot.resource, rule_id: rule.rule_id, version: rule.version,
    body_hash: rule.body_hash, scope: rule.scope,
  };
}

describe('pure episode transition', () => {
  it('keeps one episode id through problem, unknown evidence and closes it exactly once', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);

    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;
    expect(opened).toMatchObject({ state: 'open', occurrence: 0, closed_at: null, recovery_count: 0 });
    expect(opened.episode_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(opened.identity_hash).toBe(triggerEpisodeIdentityHash(identity));
    expect(opened.opened_at).toBe(NOW);

    // A repeated, still-firing evaluation is the same episode.
    const retained = nextTriggerEpisode({
      identity, previous: opened, evaluation: evaluate(snapshot, { previous: 'problem', samples: [near(85)] }),
    })!;
    expect(retained.episode_id).toBe(opened.episode_id);
    expect(retained).toMatchObject({
      state: 'open', closed_at: null, recovery_count: 0,
      last: { business: 'problem', reason: 'problem_retained' },
    });

    // Nodata, stale and unknown evidence keep the id and never close.
    const nodata = evaluate(snapshot, { previous: 'problem', samples: [], last_seen_at: null });
    const keptOnNodata = nextTriggerEpisode({ identity, previous: retained, evaluation: nodata })!;
    expect(keptOnNodata.episode_id).toBe(opened.episode_id);
    expect(keptOnNodata).toMatchObject({
      state: 'open', closed_at: null, recovery_count: 0,
      last: { business: 'unknown', reason: 'nodata', nodata: true },
    });

    const stale = evaluate(snapshot, {
      previous: 'problem', samples: [near(10, { observed_at: '2026-10-29T11:56:40.000Z' })],
    });
    const keptOnStale = nextTriggerEpisode({ identity, previous: keptOnNodata, evaluation: stale })!;
    expect(keptOnStale.episode_id).toBe(opened.episode_id);
    expect(keptOnStale).toMatchObject({
      state: 'open', closed_at: null, recovery_count: 0, last: { business: 'unknown', reason: 'stale' },
    });

    // Recovery closes the opened episode once, under the same id.
    const recovered = evaluate(snapshot, { previous: 'problem', samples: [near(60)] });
    const closed = nextTriggerEpisode({ identity, previous: keptOnStale, evaluation: recovered })!;
    expect(closed.episode_id).toBe(opened.episode_id);
    expect(closed).toMatchObject({
      state: 'closed', closed_at: NOW, recovery_count: 1,
      last: { business: 'healthy', reason: 'recovered' },
    });

    // Replaying the recovery neither opens a new episode nor closes a second time.
    const replay = nextTriggerEpisode({ identity, previous: closed, evaluation: recovered });
    expect(replay).toBe(closed);
    expect(replay!.recovery_count).toBe(1);

    // Unknown evidence while closed records nothing either.
    expect(nextTriggerEpisode({ identity, previous: closed, evaluation: stale })).toBe(closed);

    // A later definite problem is another occurrence with another id.
    const reopened = nextTriggerEpisode({ identity, previous: closed, evaluation: evaluate(snapshot) })!;
    expect(reopened.episode_id).not.toBe(opened.episode_id);
    expect(reopened).toMatchObject({
      state: 'open', occurrence: 1, opened_at: NOW, closed_at: null, recovery_count: 0,
    });
    expect(opened.state).toBe('open');
  });

  it('records nothing for healthy or unknown evidence before an episode exists', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    expect(nextTriggerEpisode({
      identity, previous: null, evaluation: evaluate(snapshot, { samples: [near(60)] }),
    })).toBeNull();
    expect(nextTriggerEpisode({
      identity, previous: null, evaluation: evaluate(snapshot, { samples: [], last_seen_at: null }),
    })).toBeNull();
    // A replayed recovery with no stored episode opens nothing.
    expect(nextTriggerEpisode({
      identity, previous: null, evaluation: evaluate(snapshot, { previous: 'problem', samples: [near(60)] }),
    })).toBeNull();
  });

  it('never shares an episode id across different rule bodies', async () => {
    const ninety = await snapshotOf();
    const ninetyFive = await snapshotOf({
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
    const identity90 = identityOf(ninety);
    const identity95 = identityOf(ninetyFive);
    expect(identity90.body_hash).not.toBe(identity95.body_hash);

    const opened90 = nextTriggerEpisode({ identity: identity90, previous: null, evaluation: evaluate(ninety) })!;
    const opened95 = nextTriggerEpisode({
      identity: identity95, previous: opened90, evaluation: evaluate(ninetyFive, { samples: [near(99)] }),
    })!;

    expect(opened95.identity_hash).not.toBe(opened90.identity_hash);
    expect(opened95.episode_id).not.toBe(opened90.episode_id);
    // The old episode is not reused, closed or rewritten by the new identity.
    expect(opened95).toMatchObject({ state: 'open', occurrence: 0, recovery_count: 0 });
    expect(opened90).toMatchObject({ state: 'open', recovery_count: 0, last: { reason: 'problem' } });
  });

  it('rejects an evaluation that does not belong to the supplied identity', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    expect(() => nextTriggerEpisode({
      identity: { ...identity, rule_id: 'alpha-average' }, previous: null, evaluation: evaluate(snapshot),
    })).toThrowError('TRIGGER_EPISODE_IDENTITY');
    expect(() => nextTriggerEpisode({
      identity: { ...identity, resource: { type: 'instance', id: '0' } },
      previous: null,
      evaluation: evaluate(snapshot),
    })).toThrowError('TRIGGER_EPISODE_IDENTITY');
  });

  it('leaves the open record alone when the rule is not in the snapshot', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;
    const absent = evaluate(snapshot, {}, { rule_id: 'ghost', scope: 'item:alpha' });
    expect(absent.reason).toBe('rule_not_found');
    expect(nextTriggerEpisode({ identity, previous: opened, evaluation: absent })).toBe(opened);
    expect(nextTriggerEpisode({ identity, previous: null, evaluation: absent })).toBeNull();
  });

  it('has no acknowledgement input, so an ack cannot close or prevent a close', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;
    const recovered = evaluate(snapshot, { previous: 'problem', samples: [near(60)] });
    const acknowledged = { ...recovered, acknowledged_by: 42, acknowledged_at: NOW } as unknown as TriggerEvaluationResult;

    const closed = nextTriggerEpisode({ identity, previous: opened, evaluation: acknowledged })!;
    expect(closed).toMatchObject({ state: 'closed', recovery_count: 1 });
    expect(closed).toEqual(nextTriggerEpisode({ identity, previous: opened, evaluation: recovered }));
    expect(closed).not.toHaveProperty('acknowledged_by');
    expect(closed.last).not.toHaveProperty('acknowledged_at');
  });
});

describe('unknown intervals on the episode record', () => {
  // A real interruption: the sample is older than the rule's stale_after_ms, so
  // the evaluator itself returns unknown evidence, not a flag set by this test.
  const staleAt = (snapshot: TriggerResourceSnapshot, at: string): TriggerEvaluationResult => evaluate(snapshot, {
    now: at,
    previous: 'problem',
    samples: [near(10, { observed_at: '2026-10-29T11:56:40.000Z' })],
  });
  // Explicit nodata, also unknown evidence, one minute after the stale judgement.
  const nodataAt = (snapshot: TriggerResourceSnapshot, at: string): TriggerEvaluationResult => evaluate(snapshot, {
    now: at, previous: 'problem', last_seen_at: null, samples: [],
  });
  const recoveryAt = (snapshot: TriggerResourceSnapshot, at: string): TriggerEvaluationResult => {
    const seen = new Date(Date.parse(at) - 5000).toISOString();
    return evaluate(snapshot, {
      now: at, last_seen_at: seen, previous: 'problem', samples: [near(60, { observed_at: seen })],
    });
  };

  const INTERRUPTED = '2026-10-29T12:01:00Z';
  const AGAIN = '2026-10-29T12:02:00Z';
  const RECOVERED_AT = '2026-10-29T12:03:00Z';
  const RETAINED_AT = '2026-10-29T12:01:30Z';
  const REOPENED_AT = '2026-10-29T12:04:00Z';

  it('keeps an episode without unknown evidence at an empty array and null', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;
    expect(opened).toMatchObject({ unknown_segments: [], unknown_open_from: null });

    const retained = nextTriggerEpisode({
      identity, previous: opened, evaluation: evaluate(snapshot, { previous: 'problem', samples: [near(85)] }),
    })!;
    expect(retained).toMatchObject({ unknown_segments: [], unknown_open_from: null });

    const closed = nextTriggerEpisode({
      identity,
      previous: retained,
      evaluation: evaluate(snapshot, { previous: 'problem', samples: [near(60)] }),
    })!;
    expect(closed).toMatchObject({ state: 'closed', unknown_segments: [], unknown_open_from: null });
  });

  it('records one interval from the first unknown evidence to the recovery and keeps it after the close', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;

    const firstUnknown = staleAt(snapshot, INTERRUPTED);
    expect(firstUnknown).toMatchObject({ business: 'unknown', quality: 'unknown', reason: 'stale', recovery: false });
    const interrupted = nextTriggerEpisode({ identity, previous: opened, evaluation: firstUnknown })!;
    expect(interrupted).toMatchObject({
      episode_id: opened.episode_id, state: 'open', closed_at: null, recovery_count: 0,
      unknown_open_from: INTERRUPTED, last: { quality: 'unknown', reason: 'stale', at: INTERRUPTED },
    });
    expect(interrupted.unknown_segments).toEqual([{ from: INTERRUPTED, to: null, reason: 'stale' }]);

    // A second unknown judgement with another reason keeps the first `from` and
    // the first `reason`: it is the same interval, not a second one.
    const secondUnknown = nodataAt(snapshot, AGAIN);
    expect(secondUnknown).toMatchObject({ business: 'unknown', quality: 'unknown', reason: 'nodata' });
    const stillInterrupted = nextTriggerEpisode({ identity, previous: interrupted, evaluation: secondUnknown })!;
    expect(stillInterrupted).toMatchObject({
      episode_id: opened.episode_id, state: 'open',
      unknown_open_from: INTERRUPTED, last: { reason: 'nodata' },
    });
    expect(stillInterrupted.unknown_segments).toEqual([{ from: INTERRUPTED, to: null, reason: 'stale' }]);

    const recovered = recoveryAt(snapshot, RECOVERED_AT);
    expect(recovered).toMatchObject({ business: 'healthy', quality: 'good', recovery: true });
    const closed = nextTriggerEpisode({ identity, previous: stillInterrupted, evaluation: recovered })!;
    expect(closed).toMatchObject({
      episode_id: opened.episode_id, state: 'closed', closed_at: RECOVERED_AT, recovery_count: 1,
      unknown_open_from: null, last: { reason: 'recovered' },
    });
    // The interval stays on the closed record, ending at the recovering evidence.
    expect(closed.unknown_segments).toEqual([{ from: INTERRUPTED, to: RECOVERED_AT, reason: 'stale' }]);

    // Replaying the recovery neither reopens nor closes a second time.
    expect(nextTriggerEpisode({ identity, previous: closed, evaluation: recovered })).toBe(closed);
  });

  it('closes the interval on a retained problem too, not only on a recovery', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;
    const interrupted = nextTriggerEpisode({ identity, previous: opened, evaluation: staleAt(snapshot, INTERRUPTED) })!;

    const seen = '2026-10-29T12:01:25.000Z';
    const retainedEvaluation = evaluate(snapshot, {
      now: RETAINED_AT, last_seen_at: seen, previous: 'problem', samples: [near(95, { observed_at: seen })],
    });
    expect(retainedEvaluation).toMatchObject({ business: 'problem', quality: 'good', reason: 'problem_retained' });

    const retained = nextTriggerEpisode({ identity, previous: interrupted, evaluation: retainedEvaluation })!;
    expect(retained).toMatchObject({
      episode_id: opened.episode_id, state: 'open', closed_at: null, recovery_count: 0,
      unknown_open_from: null, last: { business: 'problem', reason: 'problem_retained' },
    });
    expect(retained.unknown_segments).toEqual([{ from: INTERRUPTED, to: RETAINED_AT, reason: 'stale' }]);
  });

  it('starts the next occurrence without the intervals of the closed one', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;
    const interrupted = nextTriggerEpisode({ identity, previous: opened, evaluation: staleAt(snapshot, INTERRUPTED) })!;
    const closed = nextTriggerEpisode({ identity, previous: interrupted, evaluation: recoveryAt(snapshot, RECOVERED_AT) })!;

    const seen = '2026-10-29T12:03:55.000Z';
    const reopened = nextTriggerEpisode({
      identity,
      previous: closed,
      evaluation: evaluate(snapshot, {
        now: REOPENED_AT, last_seen_at: seen, samples: [near(95, { observed_at: seen })],
      }),
    })!;
    expect(reopened).toMatchObject({
      state: 'open', occurrence: 1, closed_at: null, recovery_count: 0,
      unknown_segments: [], unknown_open_from: null,
    });
    expect(reopened.episode_id).not.toBe(closed.episode_id);
    // The closed record keeps the interval it recorded; nothing was copied over.
    expect(closed.unknown_segments).toEqual([{ from: INTERRUPTED, to: RECOVERED_AT, reason: 'stale' }]);
  });

  it('does not record or extend an interval for a late unknown evaluation', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;
    const interrupted = nextTriggerEpisode({ identity, previous: opened, evaluation: staleAt(snapshot, INTERRUPTED) })!;

    const late = staleAt(snapshot, '2026-10-29T12:00:30Z');
    expect(late).toMatchObject({ quality: 'unknown', reason: 'stale' });
    expect(Date.parse(late.evaluated_at)).toBeLessThan(Date.parse(interrupted.last.at));

    const kept = nextTriggerEpisode({ identity, previous: interrupted, evaluation: late });
    expect(kept).toBe(interrupted);
    expect(kept!.unknown_open_from).toBe(INTERRUPTED);
    expect(kept!.unknown_segments).toEqual([{ from: INTERRUPTED, to: null, reason: 'stale' }]);
  });

  it('records no interval before an episode exists or after it has closed', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    expect(nextTriggerEpisode({ identity, previous: null, evaluation: staleAt(snapshot, INTERRUPTED) })).toBeNull();
    expect(nextTriggerEpisode({ identity, previous: null, evaluation: nodataAt(snapshot, INTERRUPTED) })).toBeNull();

    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;
    const closed = nextTriggerEpisode({ identity, previous: opened, evaluation: recoveryAt(snapshot, RECOVERED_AT) })!;
    expect(nextTriggerEpisode({ identity, previous: closed, evaluation: nodataAt(snapshot, AGAIN) })).toBe(closed);
    expect(closed.unknown_segments).toEqual([]);
    expect(closed.unknown_open_from).toBeNull();
  });
});

describe('opening evidence on the episode record', () => {
  const INTERRUPTED = '2026-10-29T12:01:00Z';
  const RECOVERED_AT = '2026-10-29T12:03:00Z';
  const REOPENED_AT = '2026-10-29T12:04:00Z';

  it('freezes the opening evaluation’s item, metric, value, reason and time', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opening = evaluate(snapshot);
    expect(opening).toMatchObject({ business: 'problem', reason: 'problem', value: 95 });

    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: opening })!;
    expect(opened.opened).toEqual({
      item: { template_id: 'tpl-monitoring', item_id: 'alpha', item_version: 1 },
      metric: { id: 'fixture.alpha', semantic_version: '1.0.0' },
      value: 95,
      reason: 'problem',
      at: NOW,
    });
    expect(opened.opened.item).toEqual(opening.item);
    expect(opened.opened.metric).toEqual(opening.metric);
    expect(opened.opened.at).toBe(opened.opened_at);
    expect(opened.identity_hash).toBe(triggerEpisodeIdentityHash(identity));

    // Every later verdict of the same episode moves `last` and leaves `opened`.
    const retained = nextTriggerEpisode({
      identity, previous: opened, evaluation: evaluate(snapshot, { previous: 'problem', samples: [near(85)] }),
    })!;
    expect(retained.last).toMatchObject({ value: 85, reason: 'problem_retained' });
    expect(retained.opened).toEqual(opened.opened);

    const nodata = nextTriggerEpisode({
      identity,
      previous: retained,
      evaluation: evaluate(snapshot, { previous: 'problem', last_seen_at: null, samples: [] }),
    })!;
    expect(nodata.last).toMatchObject({ reason: 'nodata', value: null });
    expect(nodata.opened).toEqual(opened.opened);

    const stale = nextTriggerEpisode({
      identity,
      previous: nodata,
      evaluation: evaluate(snapshot, {
        previous: 'problem', samples: [near(10, { observed_at: '2026-10-29T11:56:40.000Z' })],
      }),
    })!;
    expect(stale.last).toMatchObject({ reason: 'stale', quality: 'unknown' });
    expect(stale.opened).toEqual(opened.opened);

    const recovered = evaluate(snapshot, { previous: 'problem', samples: [near(60)] });
    const closed = nextTriggerEpisode({ identity, previous: stale, evaluation: recovered })!;
    expect(closed).toMatchObject({ state: 'closed', recovery_count: 1 });
    expect(closed.last).toMatchObject({ value: 60, reason: 'recovered' });
    // The closed record still says what opened it.
    expect(closed.opened).toEqual(opened.opened);
    expect(closed.opened.at).toBe(closed.opened_at);
    // Replaying the recovery returns the very same record, `opened` included.
    expect(nextTriggerEpisode({ identity, previous: closed, evaluation: recovered })).toBe(closed);
  });

  it('gives the next occurrence its own opening evidence instead of copying the closed one', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;
    const interrupted = nextTriggerEpisode({
      identity,
      previous: opened,
      evaluation: evaluate(snapshot, {
        now: INTERRUPTED, previous: 'problem', samples: [near(10, { observed_at: '2026-10-29T11:56:40.000Z' })],
      }),
    })!;
    const seenRecovery = '2026-10-29T12:02:55.000Z';
    const closed = nextTriggerEpisode({
      identity,
      previous: interrupted,
      evaluation: evaluate(snapshot, {
        now: RECOVERED_AT, last_seen_at: seenRecovery, previous: 'problem',
        samples: [near(60, { observed_at: seenRecovery })],
      }),
    })!;
    expect(closed).toMatchObject({ state: 'closed', recovery_count: 1 });

    const seenReopen = '2026-10-29T12:03:55.000Z';
    const reopening = evaluate(snapshot, {
      now: REOPENED_AT, last_seen_at: seenReopen, previous: 'healthy',
      samples: [near(97, { observed_at: seenReopen })],
    });
    expect(reopening).toMatchObject({ business: 'problem', reason: 'problem', value: 97 });
    const reopened = nextTriggerEpisode({ identity, previous: closed, evaluation: reopening })!;

    expect(reopened).toMatchObject({
      state: 'open', occurrence: 1, opened_at: REOPENED_AT, closed_at: null, recovery_count: 0,
      unknown_segments: [], unknown_open_from: null,
    });
    expect(reopened.opened).toEqual({
      item: reopening.item,
      metric: reopening.metric,
      value: 97,
      reason: 'problem',
      at: REOPENED_AT,
    });
    expect(reopened.opened).not.toEqual(closed.opened);
    expect(reopened.episode_id).not.toBe(closed.episode_id);
    // The closed record kept its own opening evidence.
    expect(closed.opened).toMatchObject({ value: 95, reason: 'problem', at: NOW });
  });

  it('creates no opening evidence when the evaluation opens nothing', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;

    // A late judgement returns the stored record object itself: no new `opened`,
    // nothing a caller could mistake for a rewritten opening.
    const late = evaluate(snapshot, {
      now: '2026-10-29T11:58:00.000Z',
      last_seen_at: '2026-10-29T11:57:55.000Z',
      previous: 'problem',
      samples: [near(60, { observed_at: '2026-10-29T11:57:55.000Z' })],
    });
    expect(nextTriggerEpisode({ identity, previous: opened, evaluation: late })).toBe(opened);
    expect(opened.opened).toEqual({
      item: expect.objectContaining({ item_id: 'alpha' }),
      metric: expect.objectContaining({ id: 'fixture.alpha' }),
      value: 95,
      reason: 'problem',
      at: NOW,
    });

    // Without a previous record, healthy and unknown evidence still record nothing.
    expect(nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot, { samples: [near(60)] }) }))
      .toBeNull();
    expect(nextTriggerEpisode({
      identity, previous: null, evaluation: evaluate(snapshot, { samples: [], last_seen_at: null }),
    })).toBeNull();
  });
});

describe('late and out-of-order watermark', () => {
  // An evaluation one minute before NOW, with its own fresh sample. The evidence
  // is usable on its own terms; only its evaluated_at is older than the record.
  const EARLIER = '2026-10-29T11:59:00.000Z';
  const EARLIER_SEEN = '2026-10-29T11:58:55.000Z';
  // An evaluation after NOW, likewise with a fresh sample.
  const LATER = '2026-10-29T12:00:30.000Z';
  const LATER_SEEN = '2026-10-29T12:00:25.000Z';

  it('returns the open record untouched for an older recovery', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;
    expect(opened).toMatchObject({ state: 'open', recovery_count: 0, last: { at: NOW } });

    const olderRecovery = evaluate(snapshot, {
      now: EARLIER,
      last_seen_at: EARLIER_SEEN,
      previous: 'problem',
      samples: [near(60, { observed_at: EARLIER_SEEN })],
    });
    // It is a real recovery verdict; only its time is behind the stored record.
    expect(olderRecovery).toMatchObject({ business: 'healthy', recovery: true, reason: 'recovered' });
    expect(olderRecovery.evaluated_at).toBe(EARLIER);
    expect(Date.parse(olderRecovery.evaluated_at)).toBeLessThan(Date.parse(opened.last.at));

    const kept = nextTriggerEpisode({ identity, previous: opened, evaluation: olderRecovery });
    // The same object, so a caller writing only `next !== previous` writes nothing.
    expect(kept).toBe(opened);
    expect(kept).toMatchObject({
      state: 'open', closed_at: null, recovery_count: 0, last: { reason: 'problem', at: NOW },
    });
  });

  it('returns the closed record untouched for an older problem', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;
    const closed = nextTriggerEpisode({
      identity,
      previous: opened,
      evaluation: evaluate(snapshot, { previous: 'problem', samples: [near(60)] }),
    })!;
    expect(closed).toMatchObject({ state: 'closed', closed_at: NOW, recovery_count: 1 });

    const olderProblem = evaluate(snapshot, {
      now: EARLIER,
      last_seen_at: EARLIER_SEEN,
      previous: 'healthy',
      samples: [near(95, { observed_at: EARLIER_SEEN })],
    });
    // A definite problem in its own right, but from before the close.
    expect(olderProblem).toMatchObject({ business: 'problem', reason: 'problem' });

    const kept = nextTriggerEpisode({ identity, previous: closed, evaluation: olderProblem });
    expect(kept).toBe(closed);
    expect(kept).toMatchObject({ state: 'closed', occurrence: 0, closed_at: NOW, recovery_count: 1 });
  });

  it('still transitions on a later evaluation', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;

    const laterRecovery = evaluate(snapshot, {
      now: LATER,
      last_seen_at: LATER_SEEN,
      previous: 'problem',
      samples: [near(60, { observed_at: LATER_SEEN })],
    });
    expect(Date.parse(laterRecovery.evaluated_at)).toBeGreaterThan(Date.parse(opened.last.at));
    const closedLater = nextTriggerEpisode({ identity, previous: opened, evaluation: laterRecovery })!;
    expect(closedLater).toMatchObject({ state: 'closed', closed_at: LATER, recovery_count: 1 });

    const laterProblem = evaluate(snapshot, {
      now: '2026-10-29T12:01:00.000Z',
      last_seen_at: '2026-10-29T12:00:55.000Z',
      previous: 'healthy',
      samples: [near(95, { observed_at: '2026-10-29T12:00:55.000Z' })],
    });
    const reopened = nextTriggerEpisode({ identity, previous: closedLater, evaluation: laterProblem })!;
    expect(reopened).toMatchObject({ state: 'open', occurrence: 1, recovery_count: 0 });
    expect(reopened.episode_id).not.toBe(opened.episode_id);
  });

  it('rejects unparsable times instead of ordering them', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;

    const unparsable = evaluate(snapshot, { now: 'not-a-time' });
    expect(unparsable.evaluated_at).toBe('not-a-time');
    expect(() => nextTriggerEpisode({ identity, previous: opened, evaluation: unparsable }))
      .toThrowError('TRIGGER_EPISODE_TIME');

    const brokenRecord = { ...opened, last: { ...opened.last, at: 'not-a-time' } };
    expect(() => nextTriggerEpisode({
      identity,
      previous: brokenRecord,
      evaluation: evaluate(snapshot, { previous: 'problem', samples: [near(60)] }),
    })).toThrowError('TRIGGER_EPISODE_TIME');

    // Without a previous record the watermark does not apply, so this evaluation
    // still opens nothing rather than starting an occurrence from a guessed time.
    expect(nextTriggerEpisode({ identity, previous: null, evaluation: unparsable })).toBeNull();
  });

  it('never uses another identity record as the watermark', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const opened = nextTriggerEpisode({ identity, previous: null, evaluation: evaluate(snapshot) })!;

    const otherIdentity: TriggerEpisodeIdentity = { ...identity, resource: { type: 'instance', id: '8' } };
    const olderProblem = evaluate(snapshot, {
      now: EARLIER,
      last_seen_at: EARLIER_SEEN,
      samples: [near(95, { observed_at: EARLIER_SEEN })],
    });
    expect(Date.parse(olderProblem.evaluated_at)).toBeLessThan(Date.parse(opened.last.at));

    const openedOther = nextTriggerEpisode({
      identity: otherIdentity, previous: opened, evaluation: olderProblem,
    })!;
    expect(openedOther.identity_hash).toBe(triggerEpisodeIdentityHash(otherIdentity));
    expect(openedOther).toMatchObject({ state: 'open', occurrence: 0, opened_at: EARLIER });
  });
});
