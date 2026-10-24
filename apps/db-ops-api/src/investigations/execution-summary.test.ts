import { describe, expect, it } from 'vitest';
import { investigationStop, executionSummary, toolReceiptSummary } from './execution-summary.js';
import { validateMachineResult } from './result-schema.js';
const subject = { kind: 'resource', resource: { type: 'instance', id: 1 } };
const run = { id: 'run', state: 'partial', finished_at: '2026-10-21T02:00:30.000Z', result_json: {
  resolution: { kind: 'partial', reasonCode: 'INVESTIGATION_TOOL_WINDOW_LIMIT' },
  investigationExecution: { usageUnknown: false, provenance: { modelVersion: 'deepseek-flash', promptVersion: 'ops@1:sha256:abc' },
    terminal: { stopReason: 'tool_error', reasonCode: 'INVESTIGATION_TOOL_WINDOW_LIMIT', source: 'tool_receipt' } },
} };
describe('durable investigation execution summary', () => {
  const analysis = { analysisVersion: 1, summary: '当前连接有观测，网络证据不足。',
    claims: [{ statement: '当前观测不足以确定根因。', supportingToolCallIds: ['read-1'], contradictingToolCallIds: [] }],
    hypotheses: [{ statement: '采集生命周期缺口可能导致网络指标不可用，尚待验证。', supportingToolCallIds: ['read-1'], contradictingToolCallIds: [] }],
    unresolvedQuestions: ['核对采集生命周期来源。'], recommendations: [{ action: '补齐只读生命周期来源后复核。', priority: 'medium' }] };
  const analysisEvidence = [{ id: 'e1', metadata_json: { source: 'tool:read-1', summary: '工具返回含 unknown。' } }];
  const completedAnalysis = (value: unknown) => ({ ...run, state: 'completed', result_json: {
    ...run.result_json, event: { finalContent: JSON.stringify(value) } } });
  it('binds completed model analysis to this execution evidence without promoting root cause or recovery', () => {
    const value = executionSummary(completedAnalysis(analysis), subject as any, analysisEvidence);
    expect(value.summary).toContain(analysis.summary);
    expect(value.claims).toEqual([{ statement: analysis.claims[0].statement, kind: 'inference', supportingEvidenceIds: ['e1'], contradictingEvidenceIds: [] }]);
    expect(value.hypotheses).toEqual([{ statement: analysis.hypotheses[0].statement, status: 'unknown', supportingEvidenceIds: ['e1'], contradictingEvidenceIds: [] }]);
    expect(value.rootCauseVerification).toEqual({ status: 'unverified' });
    expect(value.problemStatus).toBe('unconfirmed');
    expect(validateMachineResult(value, new Set(['e1'])).ok).toBe(true);
  });
  it.each(['unbound', 'expired', 'partial', 'extra-authority'])('does not publish structured analysis with %s evidence or authority', mode => {
    const input = mode === 'extra-authority' ? { ...analysis, rootCauseVerification: { status: 'human_confirmed' } } : analysis;
    const completed = completedAnalysis(input);
    const value = executionSummary(mode === 'partial' ? { ...completed, state: 'partial' } : completed, subject as any,
      mode === 'unbound' ? [] : mode === 'expired' ? [{ ...analysisEvidence[0], expired_at: new Date() }] : analysisEvidence);
    expect(value.claims).toEqual([]); expect(value.hypotheses).toEqual([]);
  });
  it.each(['extra-field', 'truncated', 'wrong-type', 'long', 'empty-basis', 'unbound'])('explicitly reports rejected final analysis: %s', mode => {
    const value: any = structuredClone(analysis);
    if (mode === 'extra-field') value.evidenceGaps = ['网络证据缺失'];
    if (mode === 'wrong-type') value.claims = 'invalid';
    if (mode === 'long') value.summary = 'x'.repeat(2001);
    if (mode === 'empty-basis') value.claims[0].supportingToolCallIds = [];
    if (mode === 'unbound') value.claims[0].supportingToolCallIds = ['another-run'];
    const terminal = completedAnalysis(value);
    if (mode === 'truncated') terminal.result_json.event.finalContent = '{"analysisVersion":1';
    const published = executionSummary(terminal, subject as any, analysisEvidence);
    expect(published.claims).toEqual([]); expect(published.hypotheses).toEqual([]);
    expect(published.summary).toContain('模型最终输出未通过');
    expect(published.summary).not.toContain('evidenceGaps');
    expect(published.unresolvedQuestions.join()).toContain('未发布');
    expect(published.facts).toHaveLength(1);
    expect(terminal.result_json.event.finalContent).toBe(mode === 'truncated' ? '{"analysisVersion":1' : JSON.stringify(value));
  });
  it('preserves the exact fatal tool receipt when Runtime omits resolution', () => {
    expect(investigationStop({ stopReason: 'tool_error', error: 'Error: Error: INVESTIGATION_TOOL_WINDOW_LIMIT' }))
      .toEqual({ stopReason: 'tool_error', reasonCode: 'INVESTIGATION_TOOL_WINDOW_LIMIT', source: 'tool_receipt' });
  });
  it.each(['MAX_TOOL_CALLS', 'RUN_DEADLINE', 'RECOVERY_LIMIT', 'CANCELLED_BY_ACTOR', 'INVESTIGATION_PROVIDER_UNKNOWN'])('retains %s without replay or guessed recovery', reasonCode => {
    expect(investigationStop({ stopReason: 'error', resolution: { reasonCode } })).toMatchObject({ reasonCode, source: 'runtime' });
  });
  it('uses terminal checkpoint evidence on recovery and never guesses a legacy cause', () => {
    expect(investigationStop({ stopReason: 'completed' })).toMatchObject({ reasonCode: 'RUNTIME_RESPONSE_READY' });
    expect(investigationStop({ stopReason: 'completed', completedToolResults: [{ content: 'Error: INVESTIGATION_TOOL_WINDOW_LIMIT' }] }))
      .toMatchObject({ reasonCode: 'RUNTIME_RESPONSE_READY' });
    expect(investigationStop({ terminal_resolution: { kind: 'partial' }, completedToolResults: [
      { content: 'Error: INVESTIGATION_TOOL_WINDOW_LIMIT' }] })).toMatchObject({ reasonCode: 'INVESTIGATION_RUNTIME_PARTIAL' });
    expect(investigationStop({ stopReason: 'error', error: 'password=do-not-copy' })).toMatchObject({ reasonCode: 'INVESTIGATION_RUNTIME_ERROR' });
  });
  it('does not infer Run termination from failed per-call receipts before later successful checks', () => {
    const summaries = [
      toolReceiptSummary('get_instance_summary', 'Error: repeated identical tool call blocked'),
      toolReceiptSummary('get_instance_summary', 'Error: INVESTIGATION_TOOL_WINDOW_LIMIT'),
      toolReceiptSummary('get_instance_summary', { success: true, summary: '后续检查成功' }),
    ];
    expect(summaries[0]).toContain('失败');
    expect(summaries.join()).not.toContain('执行已停止');
    const result = executionSummary({ ...run, result_json: { resolution: { reasonCode: 'MAX_MODEL_STEPS' } } }, subject as any,
      summaries.map((summary, i) => ({ id: `e${i}`, metadata_json: { summary } })));
    expect(result.summary).toContain('运行限制');
    expect(result.facts[2].statement).toContain('后续检查成功');
    expect(result.execution?.reasonCode).toBe('MAX_MODEL_STEPS');
  });
  it('binds completed checks to available evidence and separates business verification', () => {
    const result = executionSummary(run, subject as any, [{ id: 'e1', metadata_json: { summary: '正式观测检查：返回为空。' }, raw_json: { success: true, data: { observations: [] } } }]);
    expect(result.summary).toContain('时间范围'); expect(result.summary).toContain('1');
    expect(result.facts).toEqual([{ statement: '正式观测检查：返回为空。', evidenceIds: ['e1'] }]);
    expect(result.provenance).toMatchObject({ modelVersion: 'deepseek-flash', promptVersion: 'ops@1:sha256:abc' });
    expect(result.execution).toMatchObject({ reasonCode: 'INVESTIGATION_TOOL_WINDOW_LIMIT' });
    expect(result.recommendations.length).toBeGreaterThan(0); expect(result.rootCauseVerification.status).toBe('unverified');
    expect(result.problemStatus).toBe('unconfirmed'); expect(validateMachineResult(result, new Set(['e1'])).ok).toBe(true);
  });
  it('handles no evidence, expired evidence, failures and completed answers honestly', () => {
    const empty = executionSummary(run, subject as any, []);
    expect(empty.facts).toEqual([]); expect(empty.unresolvedQuestions.join()).toContain('证据');
    const expired = executionSummary(run, subject as any, [{ id:'old', expired_at: new Date(), metadata_json:{summary:'expired'} }]);
    expect(expired.facts).toEqual([]);
    const completed = executionSummary({ ...run, state: 'completed', result_json: { event: { finalContent: '已检查，仍需验证。' } } }, subject as any, []);
    expect(completed.summary).toContain('模型最终输出未通过'); expect(completed.provenance.modelVersion).toBe('unavailable');
    expect(completed.problemStatus).toBe('unconfirmed');
  });
});
