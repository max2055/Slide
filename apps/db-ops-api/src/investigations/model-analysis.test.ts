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

it('bounds the advertised final analysis so the 8192 shared reasoning/output budget is not a 128k JSON target', () => {
  const validate = new Ajv2020({ strict: false }).compile(JSON.parse(MODEL_ANALYSIS_POLICY.split('analysis): ')[1]));
  const answer = { analysisVersion: 1, summary: '部分证据已读取，不能确认根因。',
    claims: [{ statement: '当前依据仅支持单点观察。', supportingToolCallIds: ['a'], contradictingToolCallIds: [] }],
    hypotheses: [], unresolvedQuestions: ['缺少可信重置来源。'], recommendations: [{ action: '核对只读生命周期来源。', priority: 'medium' }] };
  expect(validate(answer)).toBe(true);
  expect(modelAnalysis(JSON.stringify(answer), [{ id: 'evidence-a', metadata_json: { source: 'tool:a' } }])).not.toBeNull();
  expect(validate({ ...answer, claims: Array.from({ length: 16 }, () => answer.claims[0]) })).toBe(true);
  expect(validate({ ...answer, claims: Array.from({ length: 17 }, () => answer.claims[0]) })).toBe(false);
  expect(validate({ ...answer, summary: '中'.repeat(401) })).toBe(false);
  expect(validate({ ...answer, unresolvedQuestions: Array(5).fill('未知') })).toBe(false);
  // The publication parser remains backward compatible; this is a Provider
  // planning bound, not deletion of existing valid evidence or historical text.
  expect(modelAnalysis(JSON.stringify({ ...answer, summary: '中'.repeat(401) }), [{ id: 'e', metadata_json: { source: 'tool:a' } }])).not.toBeNull();
});

it('accepts one JSON code fence but rejects prose or trailing text around it', () => {
  const evidence = [{ id: 'evidence-a', metadata_json: { source: 'tool:a' } }];
  const answer = { analysisVersion: 1, summary: '单点观察。',
    claims: [{ statement: '当前依据仅支持单点观察。', supportingToolCallIds: ['a'], contradictingToolCallIds: [] }],
    hypotheses: [], unresolvedQuestions: [], recommendations: [] };
  const json = JSON.stringify(answer);
  expect(modelAnalysis('```json\n' + json + '\n```', evidence)).not.toBeNull();
  expect(modelAnalysis('```\n' + json + '\n```', evidence)).not.toBeNull();
  expect(modelAnalysis('结果如下：\n```json\n' + json + '\n```', evidence)).toBeNull();
  expect(modelAnalysis('```json\n' + json + '\n```\n以上。', evidence)).toBeNull();
  expect(modelAnalysis('```json\n' + json + '\n```\n```', evidence)).toBeNull();
});
