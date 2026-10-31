/**
 * MAX-239 — caller-side episode catalog for the internal template-trigger package.
 *
 * `episode.ts` answers what one evaluation does to one previous record, and it
 * deliberately knows nothing about where that record comes from. This module is
 * that caller side: it reads the previous record of one snapshot identity, hands
 * it to the accepted pure transition, and writes back the record for that same
 * identity — no more.
 *
 * Records are keyed by the identity hash `(resource, rule_id/version, body_hash,
 * scope)` and live in the injected storage port, which defaults to the in-memory
 * map. Within one process a repeated problem keeps the same episode id, a
 * recovery closes once, and a later problem reads the closed record back and
 * opens the next occurrence. It is *not* a publisher: the in-memory default
 * persists nothing, an empty store is the honest state after a process restart
 * (a new problem starts at occurrence 0 again), and this module is not mounted on
 * any runtime path. A caller-supplied `TriggerEpisodeJournal` makes the read-back
 * cross a catalog instance; see `journal.ts`.
 *
 * No I/O of its own (the injected port owns any storage), no clock, no id
 * generation, no event/outbox/notification and no
 * acknowledgement input: an acknowledgement can neither close an episode nor
 * prevent a close, because no such input exists here or in the transition.
 */
import {
  nextTriggerEpisode, triggerEpisodeIdentityHash,
  type TriggerEpisodeIdentity, type TriggerEpisodeRecord,
} from './episode.js';
import type { TriggerEvaluationResult } from './evaluate.js';
import { InMemoryTriggerEpisodeStore, type TriggerEpisodeStore } from './journal.js';

export class TriggerEpisodeCatalog {
  constructor(private readonly store: TriggerEpisodeStore = new InMemoryTriggerEpisodeStore()) {}

  /** The last record stored for this exact identity, or `null` when it has none. */
  get(identity: TriggerEpisodeIdentity): TriggerEpisodeRecord | null {
    return this.store.read(triggerEpisodeIdentityHash(identity));
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
    if (next !== previous) this.store.write(next);
    return next;
  }

  /** How many identities currently have a stored record. */
  get size(): number {
    return this.store.size;
  }
}
