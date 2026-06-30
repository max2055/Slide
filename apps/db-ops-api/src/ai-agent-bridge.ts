/**
 * AI Agent Bridge — 统一 AI 分析入口。
 *
 * 通过 IAgentEngine.invoke() 派发 AI 分析任务，DirectAdapter 负责底层执行。
 *
 * Architecture:
 *   dispatchOrReuse()
 *     ├── cache lookup (TTL per analysis type)
 *     ├── create analysis record
 *     └── getAgentEngine('analysis').invoke()  (fire-and-forget)
 */
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import { getAgentEngine } from './adapter/get-agent-engine.js';

const DEFAULT_TTL: Record<string, number> = {
  alert_rca: 30 * 60 * 1000,
  fault_diagnosis: 60 * 60 * 1000,
  topsql_analysis: 24 * 60 * 60 * 1000,
  sql_approval: Infinity,
};

export async function dispatchOrReuse(params: {
  type: string; cacheKey: string; instanceId: number;
  sessionKey: string; userMessage: string; systemPrompt?: string;
  triggerType?: 'manual' | 'auto'; onCacheHit?: (result: any) => void;
  existingAnalysisId?: number;
}): Promise<{ analysisId: number; cached: boolean; success?: boolean; status?: string }> {
  const ttl = DEFAULT_TTL[params.type] ?? 30 * 60 * 1000;
  if (ttl !== Infinity) {
    const existing = await aiAnalysisDatabaseService.findRecentCompleted(params.cacheKey, ttl);
    if (existing) {
      params.onCacheHit?.(existing.result);
      return { analysisId: existing.analysisId!, cached: true, success: true, status: 'completed' };
    }
  }

  let analysisId: number;
  if (params.existingAnalysisId !== undefined) {
    analysisId = params.existingAnalysisId;
  } else {
    const created = await aiAnalysisDatabaseService.createAnalysis({
      analysis_type: params.type as any, instance_id: params.instanceId,
      trigger_type: params.triggerType ?? 'manual', cache_key: params.cacheKey,
      session_key: params.sessionKey,
    } as any);
    if (!created.success || !created.analysisId) throw new Error(`创建分析记录失败`);
    analysisId = created.analysisId;
  }

  // Dispatch via IAgentEngine.invoke() — adapter handles execution
  const basePrompt = params.systemPrompt || buildDefaultPrompt(params.type);
  const fullMessage = `${basePrompt}\n\n分析完成后必须调用 slide_complete_analysis 保存结果，analysisId = ${analysisId}。\n\n${params.userMessage}`;

  // Fire-and-forget the Agent invoke, then poll for completion with timeout fallback
  getAgentEngine()
    .then((engine) =>
      engine.invoke(params.sessionKey, fullMessage, basePrompt).then((result) => {
        if (result.content) {
          console.log(`[AI Bridge] Analysis agent completed: ${analysisId}`);
        }
      }),
    )
    .catch((err) => {
      console.error(`[AI Bridge] Analysis failed:`, err.message);
      aiAnalysisDatabaseService.failAnalysis(analysisId, err.message).catch(() => {});
    });

  // Poll for completion with timeout — caller can await or fire-and-forget
  aiAnalysisDatabaseService.waitForCompletion(analysisId, 120_000).then((record) => {
    if (record?.status === 'completed') {
      console.log(`[AI Bridge] Analysis ${analysisId} completed successfully`);
    } else if (record?.status === 'failed') {
      console.warn(`[AI Bridge] Analysis ${analysisId} failed: ${record.error_message}`);
    }
  }).catch(() => {});

  return { analysisId, cached: false };
}

function buildDefaultPrompt(type: string): string {
  const prompts: Record<string, string> = {
    alert_rca: `你是数据库运维专家。使用 db_health_check、db_performance_analysis、db_sql_execute、db_slow_queries 等工具采集数据，对告警进行根因分析。`,
    fault_diagnosis: `你是数据库故障诊断专家。使用 db_* 工具全面检查实例状态，诊断故障原因。`,
    topsql_analysis: `你是 SQL 优化专家。使用 db_slow_queries、db_sql_explain 等工具分析慢查询，给出索引和重写建议。`,
    sql_approval: `你是数据库安全审核专家。评估 SQL 风险并给出审批建议(approve/reject)。`,
  };
  return prompts[type] || prompts.alert_rca;
}
