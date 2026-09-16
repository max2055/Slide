import type { LLMProvider } from '../llm-database-service.js';

export const LLM_SCENES = ['chat', 'sql_analysis', 'fault_diagnosis', 'health_check'] as const;
export type LLMScene = typeof LLM_SCENES[number];
export interface SceneBinding { scene: LLMScene; provider_id: number; model: string }
export interface SceneStore {
  getAllProviders(): Promise<LLMProvider[]>;
  getSceneBindings(): Promise<SceneBinding[]>;
}
export interface ModelRequirements {
  requiresFunctionCall?: boolean;
  requiresVision?: boolean;
  minContextWindow?: number;
}
export class LLMConfigurationError extends Error {}

export function sceneForPurpose(purpose?: string): LLMScene | undefined {
  if (LLM_SCENES.includes(purpose as LLMScene)) return purpose as LLMScene;
  if (['topsql_analysis', 'sql_audit', 'sql_approval', 'sql_generation'].includes(purpose || '')) return 'sql_analysis';
  if (['alert_rca', 'resource_diagnosis', 'log_analysis'].includes(purpose || '')) return 'fault_diagnosis';
  return undefined;
}

export function selectSceneModel(
  providers: LLMProvider[], bindings: SceneBinding[], purpose?: string,
  requirements: ModelRequirements = {}, override?: { provider?: string; model?: string },
) {
  const scene = sceneForPurpose(purpose);
  const binding = scene ? bindings.find(b => b.scene === scene) : undefined;
  // Existing explicit API overrides remain supported only when no scene is bound.
  const provider = binding ? providers.find(p => p.id === binding.provider_id)
    : override?.provider ? providers.find(p => p.name === override.provider)
    : providers.find(p => p.is_default);
  const fail = (message: string): never => { throw new LLMConfigurationError(`LLM 配置错误（${scene || '全局默认'}）：${message}`); };
  if (!provider) return fail(binding ? `绑定的提供商 #${binding.provider_id} 已删除` : '未配置提供商或全局默认');
  if (!provider.enabled) return fail(`提供商 ${provider.display_name || provider.name} 已禁用`);
  const model = binding?.model || override?.model || provider.default_model;
  if (!model?.trim()) return fail('未设置模型 ID');
  if (binding && model !== provider.default_model && !provider.models_supported?.some(m => m.id === model)) {
    return fail(`模型 ${model} 不在提供商模型列表中`);
  }
  if ((scene === 'chat' || requirements.requiresFunctionCall) && !provider.supports_function_call) return fail('提供商不支持工具调用');
  if (requirements.requiresVision && !provider.supports_vision) return fail('提供商不支持视觉输入');
  if (requirements.minContextWindow && provider.context_window < requirements.minContextWindow) return fail('提供商上下文窗口不足');
  return { provider, model, source: binding ? 'scene' as const : 'default' as const };
}

export async function resolveSceneModel(store: SceneStore, purpose?: string, requirements: ModelRequirements = {}, override?: { provider?: string; model?: string }) {
  const [providers, bindings] = await Promise.all([store.getAllProviders(), store.getSceneBindings()]);
  return selectSceneModel(providers, bindings, purpose, requirements, override);
}
