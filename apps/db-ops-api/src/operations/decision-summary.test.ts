import { describe, expect, it } from 'vitest';
import { decisionSummary } from './decision-summary.js';

describe('MAX-683 authorized decision projection', () => {
  it('projects the bound result only when its evidence bindings validate', () => {
    const result = { schemaVersion: 2, subject: { kind: 'resource', resource: { type: 'server', id: 42 } },
      summary: 'CPU observed; cause unresolved', facts: [{ statement: 'CPU 95%', evidenceIds: ['e-1'] }],
      hypotheses: [], claims: [], rootCauseVerification: { status: 'unverified' }, unresolvedQuestions: [],
      recommendations: [{ action: 'Inspect process metrics', priority: 'medium' }], problemStatus: 'unconfirmed',
      provenance: { modelVersion: 'fixture', promptVersion: 'v1', toolVersions: {}, usageStatus: 'unavailable' },
      createdAt: '2026-11-17T00:00:00.000Z' };
    const input = { result, resultId: 'older-bound-result', resultVersion: 2, evidenceIds: ['e-1'], asOf: result.createdAt };
    expect(decisionSummary(input).conclusion).toBe(result.summary);
    expect(decisionSummary(input).recommendation).toBe('Inspect process metrics');
    expect(decisionSummary({ ...input, evidenceIds: [] }).conclusion).toBeNull();
  });
  it('keeps missing/legacy data unknown instead of inventing a conclusion or chart', () => {
    const summary = decisionSummary({ result: null, resultId: null, resultVersion: null, evidenceIds: [], asOf: null });
    expect(summary).toEqual({ conclusion: null, recommendation: null, asOf: null, sourceRef: null,
      targetRef: null, displayName: null, impact: null, stage: null });
    expect(summary).not.toHaveProperty('evidence');
  });
  it('does not project arbitrary result-shaped text without schema validation', () => {
    const summary = decisionSummary({ result: { summary: 'unvalidated', recommendations: [{ action: 'execute' }] },
      resultId: 'result', resultVersion: 2, evidenceIds: [], asOf: '2026-11-17T00:00:00.000Z' });
    expect(summary.conclusion).toBeNull();
    expect(summary.recommendation).toBeNull();
    expect(summary.sourceRef).toEqual({ type: 'investigation_result', id: 'result', version: 2 });
  });
});
