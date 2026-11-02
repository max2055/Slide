import type { PoolConnection } from 'mysql2/promise';
import { decode, instant, observationRows } from './observation-db.js';
import type { FeedbackVerification } from './feedback-types.js';

/** Caller holds the investigation lock. Observation time, not submission order
 * or evidence source, determines whether a recovery supersedes counterevidence.
 * Re-querying an old healthy window cannot erase a newer bad/unknown window. */
export async function currentRecoveryTimeline(c: PoolConnection, investigationId: string, scopeVersion: string,
  verification: FeedbackVerification, formalEvidenceIds: readonly string[]): Promise<boolean> {
  const rows = await observationRows(c, "SELECT payload FROM investigation_workflow_receipts WHERE investigation_id=? AND kind='retest' ORDER BY accepted_version DESC FOR SHARE", [investigationId]);
  const receipts = rows.map(row => decode(row.payload));
  if (formalEvidenceIds.length) {
    const head = receipts[0];
    if (!head || head.scopeVersion !== scopeVersion || head.conclusion !== 'recovered'
      || formalEvidenceIds.some(id => id !== head.evidenceId)) return false;
  }
  return receipts.filter(receipt => receipt.scopeVersion === scopeVersion).every(receipt => {
    if (!instant(receipt.from) || !instant(receipt.to) || Date.parse(receipt.from) >= Date.parse(receipt.to)) return false;
    // A recovered window can corroborate the same or a later recovery window.
    // A bad/unknown window must finish before the new verification starts.
    return receipt.conclusion === 'recovered'
      ? Date.parse(verification.from) >= Date.parse(receipt.from) && Date.parse(verification.to) >= Date.parse(receipt.to)
      : Date.parse(verification.from) >= Date.parse(receipt.to);
  });
}
