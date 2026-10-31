/**
 * MAX-239 — pure episode transition for the internal template-trigger package.
 *
 * This module answers one question: given the accepted snapshot identity and the
 * last stored episode record (if any), what does one {@link TriggerEvaluationResult}
 * do to that record? It is a pure projection: no store, no clock of its own, no
 * id counter, no event/outbox write and no notification. Nothing here is mounted.
 *
 * The episode id is derived, not generated: `hash(identity, occurrence)` where
 * the identity is exactly `(resource, rule_id/version, body_hash, scope)` and the
 * occurrence only increments when a closed episode is followed by a new definite
 * problem. Replaying the same evaluations, or restarting the process, therefore
 * reconstructs the same id from the same stored record — there is no random id
 * and no in-memory counter that a restart could reset.
 *
 * Only recovery closes an open episode. Unknown, nodata, stale, missing and
 * low-quality evidence keep it open (an interruption is not a recovery), and a
 * healthy verdict without recovery evidence is not a close either. A closed
 * episode never reopens: replaying its recovery is a no-op, and a later problem
 * opens the next occurrence under a new id.
 *
 * What fired the problem is frozen on the record: a new occurrence copies the
 * item identity, the metric identity, the hit value, the reason and the time of
 * the evaluation that opened it into `opened`. Later evaluations keep moving
 * `last` — a repeated problem overwrites its value, a recovery overwrites its
 * reason — but `opened` stays the evidence of the opening evaluation for the
 * whole episode, including after the close. The next occurrence takes its own
 * `opened` from its own opening evaluation; nothing is inherited.
 *
 * An interruption is recorded, not just tolerated: evidence whose quality is
 * unknown on an already open episode opens an unknown interval on the record,
 * anchored at the first such evidence's time and reason, and the interval closes
 * at the first evidence whose quality is no longer unknown — a retained problem
 * and a recovery close it alike. Consecutive unknown evidence keeps the first
 * `from` and the first `reason`; a closed record keeps its intervals, and the
 * next occurrence starts with none. Recorded intervals are episode history only:
 * they notify nothing, suppress nothing and back-fill nothing.
 *
 * The identity carries the rule body hash, so a changed rule body — the 90 → 95
 * threshold example — can never share the episode of the old body. A previous
 * record whose identity differs is ignored rather than closed: a new snapshot
 * cannot rewrite the history of the old one. Closing a superseded identity is a
 * separate lifecycle decision, out of scope here.
 *
 * Late and out-of-order evaluations are bounded by a watermark on the record's
 * own `last.at`: an evaluation whose `evaluated_at` is strictly earlier than the
 * time the stored record already carries is a historical judgement. It still
 * exists upstream, but here it returns the stored record unchanged — an older
 * recovery cannot close an open episode, an older problem cannot open the next
 * occurrence, and `last` never moves backwards. Unparsable times are rejected
 * rather than guessed at. No historical notification is produced or suppressed:
 * there is no notification here at all.
 *
 * There is no acknowledgement input at all, so an acknowledgement can neither
 * close an episode nor prevent a close.
 */
import { z } from 'zod';
import {
  TriggerResourceSchema, type TriggerItemIdentity, type TriggerResource,
} from '../../contracts/metrics/triggers.js';
import {
  HashIdSchema, RuleIdSchema, TemplateTriggerScopeSchema, VersionNumberSchema,
} from '../../contracts/metrics/templates.js';
import type { HashId } from '../../contracts/metrics/templates.js';
import type { MetricRef } from '../templates/model.js';
import type {
  TriggerBusinessState, TriggerEvaluationReason, TriggerEvaluationResult, TriggerEvidenceQuality,
} from './evaluate.js';
import { hashOf } from './model.js';

/** The accepted snapshot identity an episode belongs to. */
export const TriggerEpisodeIdentitySchema = z.strictObject({
  resource: TriggerResourceSchema,
  rule_id: RuleIdSchema,
  version: VersionNumberSchema,
  body_hash: HashIdSchema,
  scope: TemplateTriggerScopeSchema,
  /** Runtime isolation (configuration revision, item and dimensions); omitted by legacy callers. */
  context_hash: HashIdSchema.optional(),
});
export type TriggerEpisodeIdentity = z.infer<typeof TriggerEpisodeIdentitySchema>;

/** The verdict the transition last observed; evidence, not a second state. */
export interface TriggerEpisodeEvidence {
  business: TriggerBusinessState;
  quality: TriggerEvidenceQuality;
  reason: TriggerEvaluationReason;
  nodata: boolean;
  value: number | null;
  dimensions: Record<string, string> | null;
  at: string;
}

/**
 * One interval in which the episode was open while the evidence could not be
 * judged. `from` and `reason` are the first unknown evidence's time and reason;
 * `to` is the time of the first evidence that was no longer unknown, and stays
 * `null` while the interval is still open.
 */
export interface TriggerEpisodeUnknownSegment {
  from: string;
  to: string | null;
  reason: TriggerEvaluationReason;
}

/**
 * The evidence the episode opened with, copied from the evaluation that opened
 * it and never rewritten afterwards. It is the same evidence `last` carries at
 * that instant, frozen before the next evaluation can overwrite it.
 */
export interface TriggerEpisodeOpening {
  item: TriggerItemIdentity;
  metric: MetricRef;
  value: number | null;
  reason: TriggerEvaluationReason;
  at: string;
}

export interface TriggerEpisodeRecord {
  episode_id: HashId;
  /** The identity hash this episode belongs to. */
  identity_hash: HashId;
  resource: TriggerResource;
  rule_id: string;
  version: number;
  body_hash: HashId;
  scope: string;
  state: 'open' | 'closed';
  /** 0-based occurrence of this identity; the episode after a close gets the next one. */
  occurrence: number;
  opened_at: string;
  closed_at: string | null;
  /** 0 or 1 by construction: a recovery closes an episode at most once. */
  recovery_count: 0 | 1;
  last: TriggerEpisodeEvidence;
  /**
   * The evidence this occurrence opened with; `at` is this record's `opened_at`.
   * Later evaluations update `last` only, so this survives the whole episode.
   */
  opened: TriggerEpisodeOpening;
  /**
   * Intervals observed on this episode while the evidence was unknown. The last
   * one is still open while its `to` is `null`, which `unknown_open_from` marks.
   */
  unknown_segments: TriggerEpisodeUnknownSegment[];
  /** First unknown evidence's time while an interval is open, else `null`. */
  unknown_open_from: string | null;
}

export type TriggerEpisodeErrorCode = 'TRIGGER_EPISODE_IDENTITY' | 'TRIGGER_EPISODE_TIME';

export class TriggerEpisodeError extends Error {
  constructor(public readonly code: TriggerEpisodeErrorCode) {
    super(code);
    this.name = 'TriggerEpisodeError';
  }
}

export interface TriggerEpisodeTransition {
  identity: TriggerEpisodeIdentity;
  previous: TriggerEpisodeRecord | null;
  evaluation: TriggerEvaluationResult;
}

export const triggerEpisodeIdentityHash = (identity: TriggerEpisodeIdentity): HashId =>
  hashOf({
    kind: 'trigger_episode_identity',
    resource: identity.resource,
    rule_id: identity.rule_id,
    version: identity.version,
    body_hash: identity.body_hash,
    scope: identity.scope,
    ...(identity.context_hash ? { context_hash: identity.context_hash } : {}),
  });

const episodeIdOf = (identityHash: HashId, occurrence: number): HashId =>
  hashOf({ kind: 'trigger_episode', identity_hash: identityHash, occurrence });

const evidenceOf = (evaluation: TriggerEvaluationResult): TriggerEpisodeEvidence => ({
  business: evaluation.business,
  quality: evaluation.quality,
  reason: evaluation.reason,
  nodata: evaluation.nodata,
  value: evaluation.value,
  dimensions: evaluation.dimensions,
  at: evaluation.evaluated_at,
});

/** The same evidence `last` carries at opening, frozen as it was at that instant. */
const openingOf = (evaluation: TriggerEvaluationResult): TriggerEpisodeOpening => ({
  item: evaluation.item,
  metric: evaluation.metric,
  value: evaluation.value,
  reason: evaluation.reason,
  at: evaluation.evaluated_at,
});

/** A comparable instant, or a stable error instead of a guessed ordering. */
const instantOf = (value: string): number => {
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) throw new TriggerEpisodeError('TRIGGER_EPISODE_TIME');
  return instant;
};

/**
 * Fold one piece of evidence into the unknown intervals of an already open
 * episode. The first unknown evidence of an interval supplies both its `from`
 * and its `reason`; a consecutive unknown evidence must move neither. The
 * interval closes at the first evidence whose quality is no longer unknown —
 * whatever its business verdict — and stays on the record afterwards.
 */
const unknownIntervalsAfter = (
  record: TriggerEpisodeRecord,
  evidence: TriggerEpisodeEvidence,
): Pick<TriggerEpisodeRecord, 'unknown_segments' | 'unknown_open_from'> => {
  if (evidence.quality === 'unknown') {
    if (record.unknown_open_from !== null) {
      return { unknown_segments: record.unknown_segments, unknown_open_from: record.unknown_open_from };
    }
    return {
      unknown_segments: [...record.unknown_segments, { from: evidence.at, to: null, reason: evidence.reason }],
      unknown_open_from: evidence.at,
    };
  }
  if (record.unknown_open_from === null) {
    return { unknown_segments: record.unknown_segments, unknown_open_from: null };
  }
  // Close the still-open last interval at this evidence's time; the finished
  // interval stays on the record, including after the episode closes.
  const open = record.unknown_segments.at(-1);
  // A record whose open marker has no interval behind it (a hand-edited journal
  // file) must not fabricate a segment out of nothing.
  if (open === undefined) return { unknown_segments: record.unknown_segments, unknown_open_from: null };
  return {
    unknown_segments: [...record.unknown_segments.slice(0, -1), { ...open, to: evidence.at }],
    unknown_open_from: null,
  };
};

/**
 * Apply one evaluation to the last episode record of one incident identity.
 * Returns `null` when the identity has no episode and this evaluation does not
 * start one, and the unchanged record when a closed episode is not followed by a
 * new definite problem.
 */
export function nextTriggerEpisode(transition: TriggerEpisodeTransition): TriggerEpisodeRecord | null {
  const parsed = TriggerEpisodeIdentitySchema.safeParse(transition.identity);
  if (!parsed.success) throw new TriggerEpisodeError('TRIGGER_EPISODE_IDENTITY');
  const identity = parsed.data;
  const { previous, evaluation } = transition;
  const identityHash = triggerEpisodeIdentityHash(identity);
  // A record of another identity is not this identity's previous episode: it is
  // left untouched and this evaluation starts from nothing.
  const owned = previous !== null && previous.identity_hash === identityHash ? previous : null;

  // A rule missing from the snapshot has no accepted identity to attach an
  // episode to; nothing transitions, and this identity's open record is not dropped.
  if (evaluation.reason === 'rule_not_found') return owned;

  if (evaluation.rule.rule_id !== identity.rule_id
    || evaluation.rule.version !== identity.version
    || evaluation.scope !== identity.scope) {
    throw new TriggerEpisodeError('TRIGGER_EPISODE_IDENTITY');
  }

  // Watermark over this identity's own record only: an evaluation from before
  // the time the record already holds is a historical judgement. The stored
  // record is returned as the very same object, so a caller that writes only
  // when `next !== previous` leaves the stored bytes unchanged — an older
  // recovery does not close the open episode, an older problem does not open the
  // next occurrence, and `last` does not move backwards. Equal and later times
  // keep the accepted transition below.
  if (owned !== null
    && instantOf(evaluation.evaluated_at) < instantOf(owned.last.at)) {
    return owned;
  }

  const evidence = evidenceOf(evaluation);

  if (owned !== null && owned.state === 'open') {
    // Only an already open episode records unknown intervals, and the interval is
    // folded in before the verdict decides open versus closed, so a recovery
    // closes the interval it ends and a retained problem closes it too.
    const unknown = unknownIntervalsAfter(owned, evidence);
    if (evaluation.recovery) {
      return {
        ...owned, ...unknown, state: 'closed', closed_at: evidence.at, recovery_count: 1, last: evidence,
      };
    }
    // Unknown, nodata, stale, missing input, a retained problem, or a healthy
    // verdict without recovery evidence all keep the same open episode.
    return { ...owned, ...unknown, last: evidence };
  }

  // A closed (or unrelated) episode never reopens, and unknown evidence while it
  // is closed records nothing. Only a definite problem opens a new occurrence.
  if (evaluation.business !== 'problem') return owned;

  const occurrence = owned === null ? 0 : owned.occurrence + 1;
  return {
    episode_id: episodeIdOf(identityHash, occurrence),
    identity_hash: identityHash,
    resource: identity.resource,
    rule_id: identity.rule_id,
    version: identity.version,
    body_hash: identity.body_hash,
    scope: identity.scope,
    state: 'open',
    occurrence,
    opened_at: evidence.at,
    closed_at: null,
    recovery_count: 0,
    last: evidence,
    // The opening evidence is this evaluation's, not the closed record's.
    opened: openingOf(evaluation),
    // Opening is a definite problem with usable evidence; a new occurrence does
    // not inherit the unknown intervals of the previous one.
    unknown_segments: [],
    unknown_open_from: null,
  };
}
