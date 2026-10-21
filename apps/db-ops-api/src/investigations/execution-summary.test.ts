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
    expect(completed.summary).toContain('已检查，仍需验证'); expect(completed.provenance.modelVersion).toBe('unavailable');
    expect(completed.problemStatus).toBe('unconfirmed');
  });
});
