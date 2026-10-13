import { describe, expect, it } from 'vitest';
import { validateMachineResult, resultEvidenceIds, resultView } from './result-schema.js';
const result = { schemaVersion: 2, subject: { kind: 'resource', resource: { type: 'instance', id: 1 } }, summary: 'Summary',
  facts: [], hypotheses: [{ statement: 'unknown', status: 'unknown', supportingEvidenceIds: [], contradictingEvidenceIds: [] }], claims: [],
  rootCauseVerification: { status: 'unverified' }, unresolvedQuestions: ['No data'], recommendations: [], problemStatus: 'unconfirmed',
  provenance: { modelVersion: 'unknown', promptVersion: 'v1', toolVersions: {}, runtimeRunId: 'run', usageStatus: 'unavailable' }, createdAt: '2026-10-13T00:00:00.000Z' };
describe('machine result boundary', () => {
  it('keeps unknown and counterevidence, and rejects unbound claims', () => {
    const r = { ...result, claims: [{ statement: 'refuted', kind: 'inference', supportingEvidenceIds: [], contradictingEvidenceIds: ['e'] }] };
    expect(resultEvidenceIds(r as any)).toEqual(['e']);
    expect(validateMachineResult(r, new Set(['e']))).toMatchObject({ ok: true });
    expect(validateMachineResult(r, new Set())).toMatchObject({ ok: false });
  });
  it('bound never manufactures human, experiment or business recovery verification', () => {
    expect(validateMachineResult({ ...result, rootCauseVerification: { status: 'human_confirmed' } }, new Set())).toMatchObject({ ok: false });
    expect(validateMachineResult({ ...result, problemStatus: 'resolved' }, new Set())).toMatchObject({ ok: false });
    expect(resultView(result, new Set()).rootCauseVerification).toEqual({ status: 'unverified' });
  });
  it('preserves old v1 data as read-only without exposing confidence as accuracy', () => {
    const old = { schemaVersion: 1, analysisType: 'fault_diagnosis', subject: { type: 'instance', id: 1 }, conclusions: ['old'], hypotheses: [],
      evidenceRefs: [], confidence: .99, recommendations: [], displayMarkdown: 'old', provenance: result.provenance, createdAt: result.createdAt };
    const view = resultView(old, new Set());
    expect(view).toMatchObject({ kind: 'v1', readOnly: true, summary: 'old', rootCauseVerification: { status: 'unverified' } });
    expect(view).not.toHaveProperty('confidence');
    expect(view.value).toEqual(old);
  });
});
