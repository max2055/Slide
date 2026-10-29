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
 * The identity carries the rule body hash, so a changed rule body — the 90 → 95
 * threshold example — can never share the episode of the old body. A previous
 * record whose identity differs is ignored rather than closed: a new snapshot
 * cannot rewrite the history of the old one. Closing a superseded identity is a
 * separate lifecycle decision, out of scope here.
 *
 * There is no acknowledgement input at all, so an acknowledgement can neither
 * close an episode nor prevent a close.
 */
import { z } from 'zod';
import { TriggerResourceSchema, type TriggerResource } from '../../contracts/metrics/triggers.js';
import {
  HashIdSchema, RuleIdSchema, TemplateTriggerScopeSchema, VersionNumberSchema,
} from '../../contracts/metrics/templates.js';
import type { HashId } from '../../contracts/metrics/templates.js';
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
}

export type TriggerEpisodeErrorCode = 'TRIGGER_EPISODE_IDENTITY';

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

  const evidence = evidenceOf(evaluation);

  if (owned !== null && owned.state === 'open') {
    if (evaluation.recovery) {
      return { ...owned, state: 'closed', closed_at: evidence.at, recovery_count: 1, last: evidence };
    }
    // Unknown, nodata, stale, missing input, a retained problem, or a healthy
    // verdict without recovery evidence all keep the same open episode.
    return { ...owned, last: evidence };
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
  };
}
