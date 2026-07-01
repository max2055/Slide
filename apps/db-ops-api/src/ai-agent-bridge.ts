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
 *
 * Prompt 管理：
 *   - 默认从 prompts/versions/ 加载 v2 版提示词
 *   - 通过 PROMPT_VERSION 环境变量切换版本（export PROMPT_VERSION=1）
 *   - 通过 PROMPT_AB_TEST=true 启用 A/B 测试（v1/v2 随机各 50%）
 */
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import { getAgentEngine } from './adapter/get-agent-engine.js';
import { promptManager } from './prompts/prompt-manager.js';

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

  // Invoke Agent, then always persist result regardless of slide_complete_analysis
  getAgentEngine()
    .then((engine) =>
      engine.invoke(params.sessionKey, fullMessage, basePrompt).then((result) => {
        console.log(`[AI Bridge] Analysis agent completed: ${analysisId}, finalContent=${(result.content || '').substring(0, 80)}`);
        // Always persist: if Agent already called slide_complete_analysis, this is a no-op overwrite
        // If not, this saves the agent's response as the diagnosis result
        aiAnalysisDatabaseService.completeAnalysis(analysisId, {
          result: result.content || '',
          executionTrace: result.toolEvents ? {
            tools_used: [...new Set((result.toolEvents || []).map(e => e.name))],
            tool_events: result.toolEvents,
            stop_reason: result.stopReason || 'completed',
            iteration_count: result.iterationCount || 0,
          } : null,
        }).then(() => {
          console.log(`[AI Bridge] Persisted analysis ${analysisId} result (length=${(result.content || '').length})`);
        });
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
  // 转换类型名：underscore → hyphen，与 prompts/versions/ 目录文件名匹配
  const promptType = type.replace(/_/g, '-');
  const managed = promptManager.getPrompt(promptType);
  if (managed) return managed;

  // 再试原始类型名
  const managed2 = promptManager.getPrompt(type);
  if (managed2) return managed2;

  // 兜底：没有 prompt 文件时的默认提示
  const prompts: Record<string, string> = {
    alert_rca: `你是数据库运维专家。分析告警的根因并给出修复建议。`,
    fault_diagnosis: `你是数据库故障诊断专家。对数据库实例进行全面诊断，分析故障原因并给出修复建议。`,
    topsql_analysis: `你是 SQL 优化专家。分析慢查询数据并给出优化建议。`,
    sql_approval: `你是数据库安全审核专家。评估 SQL 风险并给出审批建议(approve/reject)。`,
  };
  return prompts[type] || prompts.alert_rca;
}
