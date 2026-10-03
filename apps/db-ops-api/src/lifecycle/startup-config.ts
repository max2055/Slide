import { DEFAULT_RETRIEVAL_LIMITS } from '@slide/agent-core';
import { metricCollectionEnabled } from '../metrics-v2/scheduler/lifecycle.js';

/** Only this allowlisted summary may be logged; workspace identifiers stay private. */
export function startupConfig(env: NodeJS.ProcessEnv = process.env) {
  const metricsV2CollectionEnabled = metricCollectionEnabled(env.METRICS_V2_COLLECTION_ENABLED);
  const value = env.SLIDE_MEMORY_PIPELINE_ENABLED;
  if (value !== undefined && value !== 'true' && value !== 'false') throw new Error('MEMORY_PIPELINE_ENABLED_INVALID');
  const memoryPipelineEnabled = value === 'true';
  if (memoryPipelineEnabled && !env.SLIDE_MEMORY_WORKSPACE_ID?.trim()) throw new Error('MEMORY_WORKSPACE_ID_REQUIRED');
  const limits = {
    maxCount: Number(env.SLIDE_MEMORY_RETRIEVAL_MAX_COUNT ?? DEFAULT_RETRIEVAL_LIMITS.maxCount),
    maxTokens: Number(env.SLIDE_MEMORY_RETRIEVAL_MAX_TOKENS ?? DEFAULT_RETRIEVAL_LIMITS.maxTokens),
  };
  if (!Number.isSafeInteger(limits.maxCount) || limits.maxCount < 0 || limits.maxCount > 20
    || !Number.isSafeInteger(limits.maxTokens) || limits.maxTokens < 0 || limits.maxTokens > 32768) throw new Error('MEMORY_RETRIEVAL_LIMITS_INVALID');
  return { metricsV2CollectionEnabled, memoryPipelineEnabled, memoryWorkspaceConfigured: !!env.SLIDE_MEMORY_WORKSPACE_ID?.trim(),
    memoryRetrievalMaxCount: limits.maxCount, memoryRetrievalMaxTokens: limits.maxTokens };
}
