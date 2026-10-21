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
it('terminal summary retains completed checks and real execution provenance', async () => {
  const { InvestigationResultStore } = await import('./result-schema.js');
  const store:any = Object.create(InvestigationResultStore.prototype);
  store.authorization={load:async()=>({id:'inv'}),authorize:async()=>{}};
  store.assertBinding=async()=>({run:{id:'run',state:'partial',finished_at:'2026-10-21T02:00:30.000Z',result_json:{
    resolution:{reasonCode:'INVESTIGATION_TOOL_WINDOW_LIMIT'},investigationExecution:{usageUnknown:false,provenance:{modelVersion:'deepseek-flash',promptVersion:'ops@1'}}}},snapshot:{context:{subject:result.subject}}});
  let saved:any; store.putOnConnection=async(...args:any[])=>{saved=args.at(-1);};
  const c:any={execute:async(sql:string)=>[sql.includes('MAX(version)')?[{version:0}]:sql.includes('investigation_evidence')?[{id:'e',metadata_json:{summary:'已检查正式观测，返回为空。'},raw_json:{success:true}}]:[]]};
  await store.persistExecutionSummary(c,{}, {investigationId:'inv',requestId:'req',runId:'run'});
  expect(saved.provenance.modelVersion).toBe('deepseek-flash');
  expect(saved.facts).toHaveLength(1); expect(saved.recommendations.length).toBeGreaterThan(0);
});
