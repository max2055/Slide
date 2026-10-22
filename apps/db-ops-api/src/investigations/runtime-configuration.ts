import type {ModelCapabilities} from '@slide/agent-core';

export interface InvestigationRuntimeContext {
  contextWindowTokens: number;
  maxTokens: number;
  summaryMaxTokens?: number;
  contextBlockLimit?: number;
}
export type InvestigationRuntimeConfiguration = Partial<Pick<InvestigationRuntimeContext, 'contextWindowTokens' | 'maxTokens' | 'summaryMaxTokens'>>;

/** Server-owned, scoped to this API/worker deployment; never read from model or job payloads. */
export function investigationRuntimeConfiguration(): InvestigationRuntimeConfiguration {
  const result: InvestigationRuntimeConfiguration = {};
  for (const [key, name] of [['contextWindowTokens', 'INVESTIGATION_CONTEXT_WINDOW_TOKENS'], ['maxTokens', 'INVESTIGATION_OUTPUT_TOKENS'], ['summaryMaxTokens', 'INVESTIGATION_SUMMARY_OUTPUT_TOKENS']] as const) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!raw.trim() || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new Error('INVESTIGATION_CONTEXT_CONFIGURATION');
    result[key] = value;
  }
  return result;
}

/** Freeze the allocation before sending; recovery uses the durable allocation,
 * while current provider capacity can still reject it. No global provider edits. */
export function resolveInvestigationRuntime(
  capability?: ModelCapabilities,
  configured: InvestigationRuntimeConfiguration = {},
  persisted?: InvestigationRuntimeContext,
): InvestigationRuntimeContext {
  // Old in-flight executions retain their original min(2048, answer) ceiling.
  const selected = persisted ? {...persisted, summaryMaxTokens: persisted.summaryMaxTokens ?? Math.min(2048, persisted.maxTokens)} : {
    contextWindowTokens: configured.contextWindowTokens ?? Math.min(16_000, capability?.contextWindowTokens ?? 16_000),
    maxTokens: configured.maxTokens ?? Math.min(4096, capability?.preferredOutputTokens ?? 4096, capability?.maxOutputTokens ?? 4096),
    summaryMaxTokens: configured.summaryMaxTokens ?? 10240,
  };
  if (![selected.contextWindowTokens, selected.maxTokens, selected.summaryMaxTokens, selected.contextBlockLimit ?? 1].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1_000_000)
    || selected.maxTokens + 1024 >= selected.contextWindowTokens) throw new Error('INVESTIGATION_CONTEXT_CONFIGURATION');
  const explicit = !persisted && Object.keys(configured).length > 0;
  if ((explicit || selected.contextWindowTokens > 16_000) && (!capability || capability.source === 'conservative-fallback')
    || capability && (selected.contextWindowTokens > capability.contextWindowTokens || selected.maxTokens > (capability.maxOutputTokens ?? capability.preferredOutputTokens ?? 4096))) {
    throw new Error('INVESTIGATION_CONTEXT_CAPABILITY');
  }
  return {...selected};
}
