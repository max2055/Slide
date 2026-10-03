import type { LLMProvider, ModelInfo } from '../llm-database-service.js';
import { getAllProviders } from './provider-catalog.js';

// Reviewed 2026-10-01 against provider docs and models.dev; only exact IDs match.
// https://platform.stepfun.com/docs/zh/guides/models/step-3.5-flash.md
// https://api-docs.deepseek.com/quick_start/pricing
// https://models.dev/api.json (xiaomi / stepfun / deepseek)
const PROFILES: Record<string, ModelInfo[]> = {
  deepseek: [
    ['deepseek-flash', 1000000, 393216],
    ['deepseek-v4-flash', 1000000, 393216], ['deepseek-v4-pro', 1000000, 393216],
    ['deepseek-chat', 128000, 8192], ['deepseek-reasoner', 128000, 65536],
  ].map(([id, contextWindow, maxTokens]) => ({ id: String(id), name: String(id), contextWindow: Number(contextWindow), maxTokens: Number(maxTokens), supportsFunctionCall: true, supportsVision: id === 'deepseek-flash' })),
  stepfun: [
    ['step-3.5-flash', 256000, 256000, false], ['step-3.5-flash-2603', 256000, 256000, false],
    ['step-3.7-flash', 256000, 256000, true], ['step-5-preview', 1000000, 65536, true],
  ].map(([id, contextWindow, maxTokens, supportsVision]) => ({ id: String(id), name: String(id), contextWindow: Number(contextWindow), maxTokens: Number(maxTokens), supportsFunctionCall: true, supportsVision: Boolean(supportsVision) })),
  mimo: [
    ['mimo-v2-flash', 262144, 65536, false], ['mimo-v2-pro', 1048576, 131072, false],
    ['mimo-v2-omni', 262144, 65536, true], ['mimo-v2.5', 1048576, 131072, true],
    ['mimo-v2.5-pro', 1048576, 131072, false], ['mimo-v2.6-flash', 1048576, 131072, true],
    ['mimo-v2.6-pro', 1048576, 131072, true],
  ].map(([id, contextWindow, maxTokens, supportsVision]) => ({ id: String(id), name: String(id), contextWindow: Number(contextWindow), maxTokens: Number(maxTokens), supportsFunctionCall: true, supportsVision: Boolean(supportsVision) })),
};

export function modelProviderId(name: string, baseURL?: string, explicit?: string): string {
  if (explicit && ['deepseek', 'stepfun', 'mimo'].includes(explicit)) return explicit;
  try {
    const host = new URL(baseURL || '').hostname;
    if (host === 'api.deepseek.com') return 'deepseek';
    if (['api.stepfun.com', 'api.stepfun.ai'].includes(host)) return 'stepfun';
    if (host === 'api.xiaomimimo.com' || /^token-plan-(cn|ams|sgp)\.xiaomimimo\.com$/.test(host)) return 'mimo';
  } catch { /* A name can still identify a provider behind a custom proxy. */ }
  return ({ step: 'stepfun', stepfun: 'stepfun', xiaomi: 'mimo', xiaomimimo: 'mimo' } as Record<string, string>)[name.toLowerCase()] ?? name.toLowerCase();
}

export function modelParameterCatalog(providerId: string): ModelInfo[] {
  if (PROFILES[providerId]) return PROFILES[providerId].map(m => ({ ...m, parameterProvider: providerId, parameterSource: 'catalog' }));
  const provider = getAllProviders().find(p => p.id === providerId);
  return provider?.models.map(m => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens,
    supportsFunctionCall: true, supportsVision: m.input.includes('image'), parameterProvider: providerId, parameterSource: 'catalog' })) ?? [];
}

/** Persisted per-model limits are authoritative, including for bound non-default models. */
export function providerForModel(provider: LLMProvider, model: string): LLMProvider {
  const selected = provider.models_supported?.find(m => m.id === model);
  return { ...provider,
    context_window: selected?.contextWindow ?? provider.context_window,
    supports_function_call: selected?.supportsFunctionCall ?? provider.supports_function_call,
    supports_vision: selected?.supportsVision ?? provider.supports_vision,
  };
}
