import type { AgentRunSpec, LLMProvider } from './types.js';

export interface ModelCapabilities {
  model: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  preferredOutputTokens?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  source: 'configuration' | 'catalog' | 'conservative-fallback';
  version: string;
}
export const UNKNOWN_CONTEXT_WINDOW = 8192;
export function isNativeOpenAIEndpoint(baseURL?: string): boolean {
  if (!baseURL) return true;
  try { const url = new URL(baseURL); return url.protocol === 'https:' && url.hostname === 'api.openai.com'; }
  catch { return false; }
}
export function openAIModelCapabilities(model: string): ModelCapabilities | undefined {
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const context = ({ 'gpt-4.1': 1_000_000, 'gpt-4.1-mini': 1_000_000, 'gpt-4.1-nano': 1_000_000,
    'gpt-4o': 128_000, 'gpt-4o-mini': 128_000, 'gpt-4': 8192, 'gpt-4-turbo': 128_000, 'gpt-3.5-turbo': 16385 } as Record<string, number>)[base];
  if (!context) return undefined;
  return { model, contextWindowTokens: context, maxOutputTokens: base.startsWith('gpt-4.1') ? 32768 : base === 'gpt-4' ? 8192 : 16384,
    supportsTools: true, supportsVision: !['gpt-4', 'gpt-3.5-turbo'].includes(base), source: 'catalog', version: 'openai-context/v1' };
}
export function resolveContextConfig(spec: Pick<AgentRunSpec, 'model' | 'contextWindowTokens' | 'maxTokens'>, provider?: LLMProvider) {
  const profile = provider?.getModelCapabilities?.(spec.model);
  if (profile && profile.model !== spec.model) throw new Error('MODEL_CAPABILITY_MISMATCH');
  for (const value of [spec.contextWindowTokens, profile?.contextWindowTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('INVALID_MODEL_CONTEXT');
  }
  const configuredWindow = Math.min(spec.contextWindowTokens ?? Infinity, profile?.contextWindowTokens ?? Infinity);
  const contextWindowTokens = configuredWindow === Infinity ? UNKNOWN_CONTEXT_WINDOW : configuredWindow;
  const maxTokens = spec.maxTokens ?? profile?.preferredOutputTokens ?? Math.min(4096, contextWindowTokens - 1025, profile?.maxOutputTokens ?? Infinity);
  if (![contextWindowTokens, maxTokens, profile?.maxOutputTokens ?? 1].every(n => Number.isSafeInteger(n) && n > 0) ||
    maxTokens + 1024 >= contextWindowTokens || (profile?.maxOutputTokens !== undefined && maxTokens > profile.maxOutputTokens)) {
    throw new Error('INVALID_MODEL_CONTEXT');
  }
  return { contextWindowTokens, maxTokens,
    source: spec.contextWindowTokens !== undefined ? 'configuration' as const : profile?.source ?? 'conservative-fallback' as const,
    version: profile?.version ?? 'unknown-window/v1' };
}
