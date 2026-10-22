import type { InvestigationResult } from './contracts.js';
import { modelAnalysis } from './model-analysis.js';

const decode = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;
export interface InvestigationStop { stopReason: string; reasonCode: string; source: 'runtime' | 'tool_receipt' | 'checkpoint' | 'legacy'; }
/** Runtime's fatal-tool branch can omit resolution. Only retain machine codes,
 * never arbitrary provider errors, rejected answers or reasoning. */
export function investigationStop(value: any): InvestigationStop {
  const resolution = value.resolution ?? value.terminal_resolution;
  const stopReason = value.stopReason ?? resolution?.kind ?? 'unknown';
  if (resolution?.reasonCode) return { stopReason, reasonCode: resolution.reasonCode, source: value.terminal_resolution ? 'checkpoint' : 'runtime' };
  // Returned tool text does not establish a terminal state. Runtime's actual
  // fatal exception (or the executor's matching thrown-tool receipt) does.
  const errors = value.stopReason === 'tool_error' ? [value.error] : [];
  for (const error of errors) {
    const code = typeof error === 'string' && /^(?:Error:\s*)+(INVESTIGATION_[A-Z0-9_]+)\s*$/.exec(error)?.[1];
    if (code) return { stopReason, reasonCode: code, source: 'tool_receipt' };
  }
  const codes: Record<string, string> = { completed: 'RUNTIME_RESPONSE_READY', response_ready: 'RUNTIME_RESPONSE_READY',
    tool_error: 'TOOL_EXECUTION_FAILED', max_iterations: 'MAX_MODEL_STEPS',
    cancelled: 'CANCELLED_BY_ACTOR', timed_out: 'RUN_DEADLINE', output_limit: 'OUTPUT_LIMIT', error: 'INVESTIGATION_RUNTIME_ERROR' };
  return { stopReason, reasonCode: codes[stopReason] ?? 'INVESTIGATION_RUNTIME_PARTIAL', source: value.stopReason ? 'runtime' : 'legacy' };
}

export function stopExplanation(code: string): string {
  if (code === 'INVESTIGATION_TOOL_WINDOW_LIMIT') return '工具请求的时间范围超过调查限制，执行已停止';
  if (/UNKNOWN/.test(code)) return '执行结果尚未确认；原请求不会自动重放';
  if (/CANCEL/.test(code)) return '执行已取消，未确认的结果不会发布';
  if (/DEADLINE|TIMEOUT/.test(code)) return '执行达到时间限制，后续检查未完成';
  if (/BUDGET|MAX_|LIMIT/.test(code)) return '执行达到预算或运行限制，后续检查未完成';
  if (code === 'INVESTIGATION_RUNTIME_PARTIAL') return '执行只完成部分检查；历史记录未保留具体停止原因';
  if (/TOOL/.test(code)) return '工具检查失败，执行已停止';
  return '执行未完成，请核对停止原因与已保留的检查记录';
}

export function toolReceiptSummary(name: string | undefined, raw: any): string {
  const labels: Record<string, string> = { query_metrics: '指标检查', get_instance_summary: '资源信息检查',
    get_resource_observations: '正式观测检查', list_active_alerts: '告警检查', get_server_metrics: '服务器指标检查',
    get_server_alerts: '服务器告警检查', get_resource_relations: '资源关系检查' };
  const label = labels[name ?? ''] ?? '只读工具检查';
  // A tool result can be a nonfatal guard/returned error. Only the Run's
  // terminal receipt can say that execution stopped.
  if (typeof raw === 'string' && raw.startsWith('Error:')) return `${label}失败或被阻止；具体原因见关联证据。`;
  if (raw?.success === false || raw?.status === 'error') return `${label}失败；工具返回未提供可用观测，请查看证据详情。`;
  if (raw?.data?.observations?.length === 0) return `${label}已完成；本次查询返回 0 条观测，不能据此判断资源正常。`;
  return `${label}已返回${raw?.status === 'warning' ? '（存在证据缺口）' : ''}。${typeof raw?.summary === 'string' ? `工具报告：${raw.summary.slice(0, 1000)}` : '具体观测见关联证据。'}`;
}

/** Deterministic receipt summary; tool reports are attributed observations,
 * never model-generated root causes. Expired evidence cannot become new facts. */
export function executionSummary(run: any, subject: InvestigationResult['subject'], evidence: any[]): InvestigationResult {
  const result = decode(run.result_json) ?? {}, execution = result.investigationExecution;
  const terminal = execution?.terminal;
  const reasonCode = result.resolution?.reasonCode ?? terminal?.reasonCode ?? (run.state === 'completed' ? 'RUNTIME_RESPONSE_READY' : 'INVESTIGATION_RUNTIME_PARTIAL');
  const available = evidence.filter(e => !e.expired_at && (!e.expires_at || new Date(e.expires_at).getTime() > Date.now())).slice(0, 100);
  const facts = available.map(e => ({ statement: String(decode(e.metadata_json).summary).slice(0, 4000), evidenceIds: [e.id] }));
  const analysis = run.state === 'completed' && typeof result.event?.finalContent === 'string'
    ? modelAnalysis(result.event.finalContent, available) : null;
  const summary = run.state === 'completed'
    ? String(result.event?.finalContent || '只读检查执行完成。').slice(0, 3000)
    : `${stopExplanation(reasonCode)}。`;
  return {
    schemaVersion: 2, subject,
    summary: `${summary}\n已保留 ${facts.length} 项检查记录；根因与业务恢复尚未验证。`,
    facts, hypotheses: [], claims: [], rootCauseVerification: { status: 'unverified' }, problemStatus: 'unconfirmed',
    unresolvedQuestions: [facts.length ? '以上仅表示工具检查与返回内容；观测范围、缺失或过期的证据仍需核对。' : '没有可引用的有效检查证据，不能判断资源健康、根因或恢复。',
      ...(run.state === 'completed' ? [] : ['本次未完成后续分析；执行部分完成与业务问题未解决分别记录。'])],
    recommendations: [{ action: reasonCode === 'INVESTIGATION_TOOL_WINDOW_LIMIT'
      ? '按当前时间缩小只读检查窗口，核对采集状态和有效观测；需要时提交新的调查请求。'
      : /UNKNOWN/.test(reasonCode) ? '先核对原请求及用量，不重放结果未知的模型或工具调用。'
      : '核对证据覆盖、采集时间和检查失败项；需要时提交新的只读调查，保留原执行记录。', priority: 'medium' }],
    execution: { state: run.state, stopReason: terminal?.stopReason ?? (run.state === 'completed' ? 'completed' : 'unknown'),
      reasonCode, source: terminal?.source ?? 'legacy' },
    provenance: { modelVersion: execution?.provenance?.modelVersion ?? 'unavailable',
      promptVersion: execution?.provenance?.promptVersion ?? 'unavailable', toolVersions: {}, runtimeRunId: run.id,
      ...(execution?.provenance?.providerId === undefined ? {} : { providerId: execution.provenance.providerId }),
      ...(execution?.provenance?.routeVersion ? { routeVersion: execution.provenance.routeVersion } : {}),
      ...(execution?.provenance?.inputHash ? { inputHash: execution.provenance.inputHash } : {}),
      usageStatus: execution && !execution.usageUnknown ? 'available' : 'unavailable' },
    ...(analysis ?? {}),
    createdAt: new Date(run.finished_at).toISOString(),
  };
}
