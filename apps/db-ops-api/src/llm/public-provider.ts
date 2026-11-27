import type { LLMProvider, ModelInfo } from '../llm-database-service.js';

const modelTextFields = ['id', 'name', 'desc', 'parameterProvider'];
const modelBooleanFields = ['recommended', 'supportsFunctionCall', 'supportsVision'];
const modelLimitFields = ['contextWindow', 'maxTokens'];
const modelPriceFields = ['input', 'output'];
const browserModelFields = new Set([...modelTextFields, ...modelBooleanFields, ...modelLimitFields, 'parameterSource', 'cost']);

/** Query names outside this public metadata contract may carry arbitrary secrets. */
function publicBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const original = url.toString();
    url.username = '';
    url.password = '';
    url.hash = '';
    const versions = url.searchParams.getAll('api-version')
      .filter(version => /^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(version));
    url.search = '';
    for (const version of versions) url.searchParams.append('api-version', version);
    return url.toString() === original ? value : url.toString();
  } catch {
    return null;
  }
}

function publicModel(model: Record<string, unknown>) {
  const metadata: Record<string, unknown> = {};
  for (const field of modelTextFields) {
    if (typeof model[field] === 'string') metadata[field] = model[field];
  }
  for (const field of modelBooleanFields) {
    if (typeof model[field] === 'boolean') metadata[field] = model[field];
  }
  for (const field of modelLimitFields) {
    const value = model[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) metadata[field] = value;
  }
  if (typeof model.parameterSource === 'string'
    && ['api', 'catalog', 'unknown', 'manual'].includes(model.parameterSource)) {
    metadata.parameterSource = model.parameterSource;
  }
  if (model.cost && typeof model.cost === 'object' && !Array.isArray(model.cost)) {
    const source = model.cost as Record<string, unknown>;
    const cost: Record<string, number> = {};
    for (const field of modelPriceFields) {
      const value = source[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) cost[field] = value;
    }
    metadata.cost = cost;
  }
  return metadata;
}

/** An edit from the public DTO can clear its own fields without dropping stored extensions. */
export function retainStoredModelMetadata(models: ModelInfo[], stored: ModelInfo[] | null): ModelInfo[] {
  if (!Array.isArray(stored)) return models;
  const storedById = new Map(stored.filter(model => typeof model?.id === 'string').map(model => [model.id, model]));
  return models.map(model => {
    const previous = storedById.get(model.id) as (ModelInfo & { cost?: unknown }) | undefined;
    if (!previous) return model;
    const hidden = Object.fromEntries(Object.entries(previous).filter(([field]) => !browserModelFields.has(field)));
    const next = { ...hidden, ...model } as ModelInfo & { cost?: unknown };
    if (previous.cost && typeof previous.cost === 'object' && !Array.isArray(previous.cost)) {
      const oldPrices = Object.entries(previous.cost).filter(([field]) => !modelPriceFields.includes(field));
      const supplied = next.cost;
      if (oldPrices.length && (supplied === undefined || supplied && typeof supplied === 'object' && !Array.isArray(supplied))) {
        next.cost = Object.fromEntries([...oldPrices, ...Object.entries(supplied ?? {})]);
      }
    }
    return next;
  });
}

/** Browser configuration metadata only; runtime services retain the full provider. */
export function publicLLMProvider(provider: LLMProvider) {
  const fields = [
    'id', 'name', 'display_name', 'deployment_type', 'api_format',
    'default_model', 'context_window', 'supports_function_call', 'supports_vision',
    'input_cost_per_1k', 'output_cost_per_1k', 'enabled', 'is_default', 'temperature',
    'max_tokens', 'timeout_ms', 'rate_limit_per_minute', 'daily_quota',
    'daily_quota_alert_threshold', 'created_at', 'updated_at',
  ] as const;
  const dto = Object.fromEntries(fields.map(field => [field, provider[field]]));
  return {
    ...dto,
    hasApiKey: Boolean(provider.api_key_encrypted),
    api_base_url: publicBaseUrl(provider.api_base_url),
    // Legacy JSON is not constrained by the TypeScript model interface.
    models_supported: Array.isArray(provider.models_supported)
      ? provider.models_supported.filter((model): model is typeof model & Record<string, unknown> =>
        Boolean(model) && typeof model === 'object' && !Array.isArray(model)
        && typeof model.id === 'string' && model.id.trim().length > 0).map(publicModel)
      : null,
  };
}
