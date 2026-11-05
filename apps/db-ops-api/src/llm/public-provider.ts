import type { LLMProvider } from '../llm-database-service.js';

/** Browser configuration metadata only; runtime services retain the full provider. */
export function publicLLMProvider(provider: LLMProvider) {
  const fields = [
    'id', 'name', 'display_name', 'deployment_type', 'api_format', 'api_base_url',
    'default_model', 'context_window', 'supports_function_call', 'supports_vision',
    'input_cost_per_1k', 'output_cost_per_1k', 'enabled', 'is_default', 'temperature',
    'max_tokens', 'timeout_ms', 'rate_limit_per_minute', 'daily_quota',
    'daily_quota_alert_threshold', 'created_at', 'updated_at',
  ] as const;
  const dto = Object.fromEntries(fields.map(field => [field, provider[field]]));
  return {
    ...dto,
    hasApiKey: Boolean(provider.api_key_encrypted),
    // Stored JSON may contain arbitrary fields. Apply the boundary recursively.
    models_supported: provider.models_supported?.map(model => {
      const fields = [
        'id', 'name', 'recommended', 'desc', 'contextWindow', 'maxTokens',
        'supportsFunctionCall', 'supportsVision', 'parameterProvider', 'parameterSource',
      ] as const;
      const metadata = Object.fromEntries(fields.map(field => [field, model[field]]));
      const cost = (model as typeof model & { cost?: { input?: number; output?: number } }).cost;
      return { ...metadata, ...(cost ? { cost: { input: cost.input, output: cost.output } } : {}) };
    }) ?? null,
  };
}
