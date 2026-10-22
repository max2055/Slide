import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { MODEL_ANALYSIS_POLICY, modelAnalysis } from './model-analysis.js';
import { executionSummary } from './execution-summary.js';
const b8 = JSON.parse(readFileSync(new URL('./fixtures/ops-final-b8-20261022.json', import.meta.url), 'utf8'));
describe('strict final output contract and original B8 rejection', () => {
  it('preserves the exact B8 answer as rejected, without stripping evidenceGaps or publishing raw assertions', () => {
    expect(createHash('sha256').update(b8.content).digest('hex')).toBe(b8.provenance.contentUtf8Sha256);
    expect(JSON.parse(b8.content).evidenceGaps.length).toBeGreaterThan(0);
    expect(modelAnalysis(b8.content, b8.evidence)).toBeNull();
    const result = executionSummary({ id: b8.provenance.run, state: 'completed', finished_at: '2026-10-22T09:00:00Z',
      result_json: { event: { finalContent: b8.content } } }, { kind: 'resource', resource: { type: 'instance', id: 1 } }, b8.evidence);
    expect(result.claims).toEqual([]); expect(result.hypotheses).toEqual([]);
    expect(result.summary).toContain('模型最终输出未通过'); expect(result.summary).not.toContain('evidenceGaps');
    expect(result.facts).toHaveLength(20);
  });
  it('advertises the actual strict schema and routes gaps into unresolvedQuestions, with executable limits', () => {
    const schema = JSON.parse(MODEL_ANALYSIS_POLICY.split('analysis): ')[1]);
    const validate = new Ajv2020({ strict: false }).compile(schema);
    // Authored offline positive, never presented as a repaired B8 response.
    const answer = { analysisVersion: 1, summary: '网络来源未核验。', claims: [], hypotheses: [], unresolvedQuestions: ['缺少可信接口生命周期。'], recommendations: [] };
    expect(validate(answer)).toBe(true); expect(modelAnalysis(JSON.stringify(answer), [])).not.toBeNull();
    expect(validate({ ...answer, evidenceGaps: ['missing'] })).toBe(false);
    expect(validate({ ...answer, summary: 'x'.repeat(2001) })).toBe(false);
    expect(validate({ ...answer, recommendations: [{ action: 'request', priority: 'medium', arbitrary: true }] })).toBe(false);
  });
});
