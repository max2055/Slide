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
