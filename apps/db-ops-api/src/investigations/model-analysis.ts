import { z } from 'zod';
import type { InvestigationResult } from './contracts.js';

const text = z.string().trim().min(1).max(2000);
const refs = z.array(z.string().min(1).max(128)).max(20);
const assertion = z.strictObject({ statement: text, supportingToolCallIds: refs, contradictingToolCallIds: refs });
const schema = z.strictObject({ analysisVersion: z.literal(1), summary: text,
  claims: z.array(assertion).max(30), hypotheses: z.array(assertion).max(20),
  unresolvedQuestions: z.array(text).max(30),
  recommendations: z.array(z.strictObject({ action: text, priority: z.enum(['low', 'medium', 'high', 'critical']) })).max(30),
});

export const MODEL_ANALYSIS_POLICY = `
先批量读取每个资源的默认观测，不要猜测或逐一枚举指标名。query_metrics 的 realtime 默认返回标准核心指标；discover 仅发现扩展，inventory 仅返回属性。已有缺口是证据，不反复查询同一缺口。完成必要检查后及时输出分析，保留预算用于最终回答。
最终回答只输出 JSON（不要代码围栏）：{"analysisVersion":1,"summary":"含时间、数值、单位、质量与缺口的中文摘要","claims":[{"statement":"有依据的判断，明确适用范围","supportingToolCallIds":["实际已返回的工具调用ID"],"contradictingToolCallIds":[]}],"hypotheses":[{"statement":"尚待验证的假设及验证条件","supportingToolCallIds":[],"contradictingToolCallIds":[]}],"unresolvedQuestions":["未解决问题"],"recommendations":[{"action":"具体建议","priority":"medium"}]}。
只引用当前执行实际已返回的工具调用 ID，不得编造 UUID、事实或验证状态。判断均作为推断、假设均为待验证保存；不得宣称已验证根因或业务恢复。没有证据的判断省略；unknown/临时失败/过期/真实零值分别解释。`;

/** The model supplies text, never authority or database identities. References
 * resolve exclusively through available evidence from the terminal execution. */
export function modelAnalysis(content: string, evidence: readonly any[]): Pick<InvestigationResult,
  'summary' | 'claims' | 'hypotheses' | 'unresolvedQuestions' | 'recommendations'> | null {
  let input: unknown;
  try { input = JSON.parse(content); } catch { return null; }
  const parsed = schema.safeParse(input);
  if (!parsed.success) return null;
  const bindings = new Map<string, string>();
  for (const row of evidence) {
    const metadata = typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json;
    if (typeof metadata?.source === 'string' && metadata.source.startsWith('tool:')) bindings.set(metadata.source.slice(5), row.id);
  }
  const value = parsed.data;
  if ([...value.claims, ...value.hypotheses].some(a => [...a.supportingToolCallIds, ...a.contradictingToolCallIds].some(id => !bindings.has(id)))) return null;
  // A claim needs an observed basis even though it remains an inference.
  if (value.claims.some(a => !a.supportingToolCallIds.length)) return null;
  const references = (a: z.infer<typeof assertion>) => ({ statement: a.statement,
    supportingEvidenceIds: [...new Set(a.supportingToolCallIds.map(id => bindings.get(id)!))],
    contradictingEvidenceIds: [...new Set(a.contradictingToolCallIds.map(id => bindings.get(id)!))] });
  return { summary: value.summary, claims: value.claims.map(a => ({ ...references(a), kind: 'inference' })),
    hypotheses: value.hypotheses.map(a => ({ ...references(a), status: 'unknown' })),
    unresolvedQuestions: value.unresolvedQuestions, recommendations: value.recommendations };
}
