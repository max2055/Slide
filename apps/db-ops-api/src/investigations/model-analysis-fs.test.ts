import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { MODEL_ANALYSIS_POLICY, modelAnalysis } from './model-analysis.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ops-fs-final-20261024.json', import.meta.url), 'utf8'));
const used = fixture.receipts.find((r: any) => r.arguments.metric_ids?.[0] === 'host.filesystem.used_bytes');
const size = fixture.receipts.find((r: any) => r.arguments.metric_ids?.[0] === 'host.filesystem.size_bytes' && r.arguments.mode === 'history');
const data = (r: any) => JSON.parse(r.rawContent).data;
const identity = (s: any) => JSON.stringify([s.dimensions.mount, s.dimensions.device, s.dimensions.fs_type]);
const evidence = fixture.receipts.map((r: any) => ({ id: `e-${r.id}`, metadata_json: { source: `tool:${r.id}` } }));
// Authored offline answer: demonstrates representability, never repairs or
// substitutes for the real model response. No production answer generation.
function positive() {
  const window = data(used).window;
  return { analysisVersion: 1,
    summary: `server:3 文件系统11组；窗口${window.from}—${window.to}；仅为当前观测，不能据此确认健康或根因。`,
    claims: data(used).metrics[0].series.map((u: any) => {
      const s = data(size).metrics[0].series.find((s: any) => identity(s) === identity(u));
      const a = u.buckets[0], b = s.buckets[0];
      expect(a.window).toEqual(b.window); expect(a.observed_at).toBe(b.observed_at);
      return { statement: `server:3 mount=${u.dimensions.mount}; device=${u.dimensions.device}; fs_type=${u.dimensions.fs_type}; used=${a.value.value} By; size=${b.value.value} By; observed_at=${a.observed_at}; quality=${a.quality.status}/${b.quality.status}; accuracy=${a.accuracy}/${b.accuracy}; coverage=${a.coverage}/${b.coverage}; freshness=${a.freshness}/${b.freshness}。仅描述此观测，不推断健康。`,
        supportingToolCallIds: [used.id, size.id], contradictingToolCallIds: [] };
    }), hypotheses: [], unresolvedQuestions: ['network采集失败；QPS为null，不是零或健康。未验证生命周期来源。'],
    recommendations: [{ action: '核查网络采集失败及QPS缺失输入。', priority: 'medium' }] };
}
const validate = new Ajv2020({ strict: false }).compile(JSON.parse(MODEL_ANALYSIS_POLICY.split('analysis): ')[1]));
describe('bounded complete FS presentation from actual final request', () => {
  it('retains the real final request, response, canonical contents and all eleven same-window identities', () => {
    expect(createHash('sha256').update(JSON.stringify([fixture.sent.messages, fixture.sent.tools])).digest('hex')).toBe(fixture.sent.requestHash);
    expect(createHash('sha256').update(fixture.received.response.content).digest('hex')).toBe('e23bd0f557d1f12b18120592945dd7285f25e09a02ceb240091f859158c2a267');
    expect(fixture.sent.tools).toEqual([]);
    expect(fixture.sent.messages.some((m: any) => m._extra?.reasoning_content)).toBe(true);
    for (const r of [used, size]) {
      const message = fixture.sent.messages.find((m: any) => m.tool_call_id === r.id);
      expect(message).toBeDefined();
      expect(data(r).metrics[0].series).toHaveLength(11);
    }
    expect(new Set(data(used).metrics[0].series.map(identity)).size).toBe(11);
    expect(data(size).metrics[0].series.map(identity).sort()).toEqual(data(used).metrics[0].series.map(identity).sort());
  });
  it('encodes all eleven identities and paired raw values within the advertised contract', () => {
    const answer = positive();
    expect(answer.claims).toHaveLength(11);
    expect(validate(answer), JSON.stringify(validate.errors)).toBe(true);
    const result = modelAnalysis(JSON.stringify(answer), evidence)!;
    expect(result.claims.map(c => c.statement)).toEqual(answer.claims.map((c: any) => c.statement));
    expect(result.claims.every(c => c.supportingEvidenceIds.length === 2)).toBe(true);
    expect(result.claims.some(c => c.statement.includes('used=0 By; size='))).toBe(true);
    expect(result.unresolvedQuestions).toEqual(answer.unresolvedQuestions);
    expect(result.recommendations).toEqual(answer.recommendations);
  });
  it('can preserve explicit gaps and literal edge semantics without manufacturing completeness', () => {
    // Authored counterexamples, not additional observations from the real run.
    const answer = positive();
    answer.claims[0].statement = 'server:3 mount=/zero device=tmpfs fs_type=tmpfs; used=0 By; size=0 By; 占用率未知，零容量不作除法或健康结论。';
    answer.claims[1].statement = 'server:3 mount=/null device=tmpfs fs_type=tmpfs; used=null By; size=1024 By; quality=unknown; null不是0。';
    answer.unresolvedQuestions = ['缺device或重复维度、错窗口/observed_at、单位不一致不能配对；保留未配对项。', 'network失败；真0不是失败，null不是0；缺失组未补齐，不宣称完整。'];
    const result = modelAnalysis(JSON.stringify(answer), evidence)!;
    expect(validate(answer)).toBe(true);
    expect(result.claims.map(c => c.statement)).toEqual(answer.claims.map((c: any) => c.statement));
    expect(result.unresolvedQuestions).toEqual(answer.unresolvedQuestions);
    expect(result).not.toHaveProperty('complete');
  });
  it('preserves the real incomplete answer, without inventing missing groups or complete status', () => {
    const original = fixture.received.response.content;
    const result = modelAnalysis(original, evidence)!;
    expect(result.claims).toHaveLength(4);
    expect(result.claims.map(c => c.statement)).toEqual(JSON.parse(original).claims.map((c: any) => c.statement));
    expect(result.claims.some(c => c.statement.includes('/run/user/991'))).toBe(false);
    expect(result).not.toHaveProperty('complete');
  });
  it.each(['unknown-key', 'unknown-reference', 'empty-reference', 'truncated'])('rejects %s without filling an answer', kind => {
    const answer: any = positive();
    if (kind === 'unknown-key') answer.claims[0].complete = true;
    if (kind === 'unknown-reference') answer.claims[0].supportingToolCallIds = ['older-run'];
    if (kind === 'empty-reference') answer.claims[0].supportingToolCallIds = [];
    const content = JSON.stringify(answer);
    expect(modelAnalysis(kind === 'truncated' ? content.slice(0, -1) : content, evidence)).toBeNull();
  });
  it('still bounds the planning subset and retains publication compatibility', () => {
    const answer = positive();
    expect(validate({ ...answer, claims: Array(17).fill(answer.claims[0]) })).toBe(false);
    expect(validate({ ...answer, claims: [{ ...answer.claims[0], statement: 'x'.repeat(801) }] })).toBe(false);
    expect(modelAnalysis(JSON.stringify({ ...answer, claims: [{ ...answer.claims[0], statement: 'x'.repeat(801) }] }), evidence)).not.toBeNull();
  });
});
