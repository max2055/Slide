import { describe, expect, it } from 'vitest';
import { asAnalysisView, validateAnalysisEnvelope } from './analysis-envelope.js';

const validEnvelope = {
  schemaVersion: 1,
  analysisType: 'alert_rca',
  subject: { type: 'instance', id: 42 },
  conclusions: ['CPU saturation is causing queueing'],
  hypotheses: [{ statement: 'A batch workload increased load', status: 'supported' }],
  evidenceRefs: [{ ref: 'observation:cpu:42', summary: 'CPU remained above 95%' }],
  confidence: 0.82,
  recommendations: [{ action: 'Throttle the batch job', priority: 'high' }],
  displayMarkdown: '## Root cause\nCPU saturation',
  provenance: { modelVersion: 'test-model', promptVersion: 'v2', toolVersions: { metrics: '1' } },
  createdAt: '2026-07-18T00:00:00.000Z',
};

describe('AnalysisEnvelope', () => {
  it('accepts network resources and canonical persisted evidence references', () => {
    expect(validateAnalysisEnvelope({ ...validEnvelope, subject: { type: 'network_device', id: 4 }, evidenceRefs: [{ ref: 'a'.repeat(64), summary: 'Observed reachability' }] }).ok).toBe(true);
  });
  it('accepts a versioned structured analysis envelope', () => {
    expect(validateAnalysisEnvelope(validEnvelope)).toEqual({ ok: true, value: validEnvelope });
  });

  it('rejects unsupported versions, malformed resource references, and oversized fields', () => {
    expect(validateAnalysisEnvelope({ ...validEnvelope, schemaVersion: 2 }).ok).toBe(false);
    expect(validateAnalysisEnvelope({ ...validEnvelope, subject: { type: 'database', id: 42 } }).ok).toBe(false);
    expect(validateAnalysisEnvelope({ ...validEnvelope, conclusions: ['x'.repeat(4_001)] }).ok).toBe(false);
  });

  it('keeps legacy Markdown displayable without inventing structured facts', () => {
    expect(asAnalysisView(null, '# Previous analysis')).toEqual({
      kind: 'legacy', displayMarkdown: '# Previous analysis', envelope: null,
    });
  });
});
