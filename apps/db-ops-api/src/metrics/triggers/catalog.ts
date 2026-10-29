/**
 * MAX-239 — caller-side episode catalog for the internal template-trigger package.
 *
 * `episode.ts` answers what one evaluation does to one previous record, and it
 * deliberately knows nothing about where that record comes from. This module is
 * that caller side: it reads the previous record of one snapshot identity, hands
 * it to the accepted pure transition, and writes back the record for that same
 * identity — no more.
 *
 * The store is an in-memory map keyed by the identity hash
 * `(resource, rule_id/version, body_hash, scope)`. Within one process a repeated
 * problem keeps the same episode id, a recovery closes once, and a later problem
 * reads the closed record back and opens the next occurrence. It is *not* a
 * publisher: nothing is persisted, an empty catalog is the honest state after a
 * process restart (a new problem starts at occurrence 0 again), and this module
 * is not mounted on any runtime path.
 *
 * No I/O, no clock, no id generation, no event/outbox/notification and no
 * acknowledgement input: an acknowledgement can neither close an episode nor
 * prevent a close, because no such input exists here or in the transition.
 */
import type { HashId } from '../../contracts/metrics/templates.js';
import {
  nextTriggerEpisode, triggerEpisodeIdentityHash,
  type TriggerEpisodeIdentity, type TriggerEpisodeRecord,
} from './episode.js';
import type { TriggerEvaluationResult } from './evaluate.js';

export class TriggerEpisodeCatalog {
  private readonly records = new Map<HashId, TriggerEpisodeRecord>();

  /** The last record stored for this exact identity, or `null` when it has none. */
  get(identity: TriggerEpisodeIdentity): TriggerEpisodeRecord | null {
    return this.records.get(triggerEpisodeIdentityHash(identity)) ?? null;
  }

  /**
   * Read this identity's previous record, apply the accepted pure transition and
   * store the result under the same identity.
   *
   * Returns `null` — leaving the catalog untouched — when the transition records
   * nothing. A record the transition left unchanged (a close replay, unknown
   * evidence after a close, a missing rule) is returned without a rewrite. A
   * record of another identity — including the same resource under another body
   * hash — is never read, rewritten or closed here.
   */
  apply(identity: TriggerEpisodeIdentity, evaluation: TriggerEvaluationResult): TriggerEpisodeRecord | null {
    const previous = this.get(identity);
    const next = nextTriggerEpisode({ identity, previous, evaluation });
    if (next === null) return null;
    if (next !== previous) this.records.set(triggerEpisodeIdentityHash(identity), next);
    return next;
  }

  /** How many identities currently have a stored record. */
  get size(): number {
    return this.records.size;
  }
}
