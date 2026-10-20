/** Transport-only types for the T11 registration port. No server IO dependency. */
export interface FeedbackVerification { method: string; from: string; to: string; evidenceIds: string[]; actionReport?: { id: string; version: number; hash: string }; }
interface FeedbackBinding { resultId: string; resultVersion: number; expectedVersion: number; note: string; }
export type InvestigationFeedbackRequest = FeedbackBinding & (
  | { kind: 'rating'; rating: 'helpful' | 'unhelpful' | 'incorrect' }
  | { kind: 'handling'; performedAt: string; evidenceIds: string[] }
  | { kind: 'root_cause' | 'recovery'; verification: FeedbackVerification }
  | { kind: 'close'; lifecycle: 'closed' | 'archived'; problemStatus: 'unconfirmed' | 'in_progress' | 'resolved' | 'not_applicable'; verification?: FeedbackVerification }
);
export interface InvestigationFeedbackRecord {
  id: string; investigationId: string; actorId: number; createdAt: string; version: number;
  command: InvestigationFeedbackRequest; staleResult: boolean; staleVerification?: boolean;
  references: Array<{ id: string; status: 'available' | 'expired'; contentHash: string }>;
  verification?: FeedbackVerification & { verifiedBy: number; verifiedAt: string; status: 'human_confirmed' };
}
