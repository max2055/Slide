import { describe, expect, it } from 'vitest';
import { freezeEvidence } from './analysis-evidence.js';
import { AnalysisDispatchStore, type OwnedAnalysis } from './analysis-dispatch-store.js';

const envelope = { schemaVersion: 1, analysisType: 'fault_diagnosis', subject: { type: 'instance', id: 42 }, conclusions: ['finding'], hypotheses: [], evidenceRefs: [], confidence: .5, recommendations: [], displayMarkdown: 'finding', provenance: { modelVersion: 'forged', promptVersion: 'forged', toolVersions: {} }, createdAt: '2026-10-03T00:00:00Z' };
const owned = { analysisId: 1, request: { purpose: 'fault_diagnosis', subject: envelope.subject, authorizationVersion: 'a1', evidence: freezeEvidence(envelope.subject as any, 'a1', { database: { qps: 7 } }) } } as unknown as OwnedAnalysis;
// Database work is deliberately forbidden: invalid completion must fail before it.
const store = new AnalysisDispatchStore(() => { throw new Error('UNVALIDATED_DATABASE_WRITE'); });
describe('task-bound analysis completion', () => {
  it('rejects the wrong analysis type before writing', async () => {
    await expect(store.completeEnvelope(owned, { ...envelope, analysisType: 'topsql_analysis' })).resolves.toMatchObject({ success: false, error: 'ANALYSIS_TYPE_MISMATCH' });
  });
  it.each(['/database/madeUp', 'observation:cpu:99', 'a'.repeat(64), 'snapshot:other#/database/qps'])('rejects fabricated or foreign evidence %s before writing', async ref => {
    await expect(store.completeEnvelope(owned, { ...envelope, evidenceRefs: [{ ref, summary: 'claimed' }] })).resolves.toMatchObject({ success: false, error: 'ANALYSIS_EVIDENCE_REF_INVALID' });
  });
  it('rejects a wrong subject', async () => {
    await expect(store.completeEnvelope(owned, { ...envelope, subject: { type: 'instance', id: 43 } })).resolves.toMatchObject({ success: false, error: 'ANALYSIS_SUBJECT_MISMATCH' });
  });
});
