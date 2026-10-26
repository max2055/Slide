/**
 * Provider configuration backup / restore (issue #244).
 *
 * The artifact is deliberately secret-free:
 * - `api_key_encrypted` never leaves the database (only a `stored_auth` boolean);
 * - URL userinfo and credential query parameters are stripped from base URLs;
 * - a deny-list scan rejects any artifact that still looks like a secret.
 *
 * Restore only writes the non-secret provider fields. The encrypted key column
 * is preserved by provider name, so a same-environment restore keeps working
 * credentials, while a cross-environment restore must re-enter them.
 */
import { createHash } from 'node:crypto';
import type { LLMProvider, ModelInfo } from '../llm-database-service.js';
import { LLM_SCENES, LLMConfigurationError, selectSceneModel, type LLMScene, type SceneBinding } from './scene-routing.js';

export const PROVIDER_CONFIG_BACKUP_FORMAT = 'slide.llm-provider-config';
export const PROVIDER_CONFIG_BACKUP_VERSION = 1;

export type DeploymentType = 'local' | 'cloud' | 'api';
export type ApiFormat = 'openai-completions' | 'anthropic-messages' | 'google-generative-ai';
export type RedactionReason = 'url_userinfo' | 'url_query_credential';

export class ProviderConfigBackupError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderConfigBackupError';
  }
}

export interface ProviderConfigRecord {
  id?: number | string;
  name: string;
  display_name?: string | null;
  deployment_type?: string | null;
  api_format?: string | null;
  api_key_encrypted?: string | null;
  stored_auth?: boolean | number | string | null;
  api_base_url?: string | null;
  default_model?: string | null;
  models_supported?: ModelInfo[] | string | null;
  context_window?: number | string | null;
  supports_function_call?: boolean | number | string | null;
  supports_vision?: boolean | number | string | null;
  input_cost_per_1k?: number | string | null;
  output_cost_per_1k?: number | string | null;
  enabled?: boolean | number | string | null;
  is_default?: boolean | number | string | null;
  temperature?: number | string | null;
  max_tokens?: number | string | null;
  timeout_ms?: number | string | null;
  rate_limit_per_minute?: number | string | null;
  daily_quota?: number | string | null;
  daily_quota_alert_threshold?: number | string | null;
}

export interface ManagedProviderFields {
  display_name: string;
  deployment_type: DeploymentType;
  api_format: ApiFormat | null;
  api_base_url: string | null;
  default_model: string | null;
  models_supported: ModelInfo[] | null;
  context_window: number;
  supports_function_call: boolean;
  supports_vision: boolean;
  input_cost_per_1k: number;
  output_cost_per_1k: number;
  enabled: boolean;
  is_default: boolean;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  rate_limit_per_minute: number;
  daily_quota: number | null;
  daily_quota_alert_threshold: number;
}

export const PROVIDER_MANAGED_FIELDS: ReadonlyArray<keyof ManagedProviderFields> = [
  'display_name', 'deployment_type', 'api_format', 'api_base_url', 'default_model', 'models_supported',
  'context_window', 'supports_function_call', 'supports_vision', 'input_cost_per_1k', 'output_cost_per_1k',
  'enabled', 'is_default', 'temperature', 'max_tokens', 'timeout_ms', 'rate_limit_per_minute', 'daily_quota',
  'daily_quota_alert_threshold',
];

export interface ProviderBackupEntry extends ManagedProviderFields {
  name: string;
  source_id: number | null;
  stored_auth: boolean;
}

export interface SceneBindingBackupEntry {
  scene: LLMScene;
  provider: string | null;
  model: string;
  dangling_provider_id?: number;
}

export interface ProviderConfigBackupDocument {
  format: typeof PROVIDER_CONFIG_BACKUP_FORMAT;
  version: typeof PROVIDER_CONFIG_BACKUP_VERSION;
  created_at: string;
  source: { database: string };
  redactions: Array<{ field: string; reason: RedactionReason }>;
  providers: ProviderBackupEntry[];
  scene_bindings: SceneBindingBackupEntry[];
}

const DEPLOYMENT_TYPES: DeploymentType[] = ['local', 'cloud', 'api'];
const API_FORMATS: ApiFormat[] = ['openai-completions', 'anthropic-messages', 'google-generative-ai'];
const SENSITIVE_NAME_SEGMENTS = new Set([
  'key', 'token', 'secret', 'password', 'passwd', 'auth', 'authorization',
  'credential', 'credentials', 'signature', 'sig',
]);
const SENSITIVE_NAME_COMPOUND = /apikey|accesskey|subscriptionkey|clientsecret|secretkey|privatekey|accesstoken|authtoken|refreshtoken|sessiontoken|credential/;
// `max_tokens` / `maxTokens` are ordinary model limits, and `stored_auth` is
// the boolean "key exists" summary; neither is a credential.
const SECRET_KEY_ALLOWLIST = new Set(['maxtokens', 'storedauth']);

/**
 * Normalize separators/camelCase before matching so `x-api-key`,
 * `subscription-key`, `client_secret`, `clientSecret`, `secret_key`,
 * `access_key` and `accessToken` are all treated as credentials, while
 * `api-version` and ordinary words such as `author`, `monkey` or `hockey`
 * are not.
 */
export function isSensitiveCredentialName(name: string): boolean {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // Keep the raw name when it is not valid percent-encoding.
  }
  const normalized = decoded.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (SECRET_KEY_ALLOWLIST.has(normalized)) return false;
  if (SENSITIVE_NAME_COMPOUND.test(normalized)) return true;
  const segments = decoded
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(segment => segment.toLowerCase());
  return segments.some(segment => SENSITIVE_NAME_SEGMENTS.has(segment));
}

const SECRET_VALUE_RULES: ReadonlyArray<{ rule: string; test: (value: string) => boolean }> = [
  { rule: 'encrypted-v2', test: value => /^v2:[0-9a-f]{12}:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i.test(value) },
  { rule: 'encrypted-legacy', test: value => /^[0-9a-f]{32}:[0-9a-f]{16,}$/i.test(value) },
  { rule: 'provider-key', test: value => /^(sk|pk|rk|gsk|xai|glm)-[A-Za-z0-9_-]{16,}$/.test(value) },
  { rule: 'aws-key', test: value => /^AKIA[0-9A-Z]{16}$/.test(value) },
  { rule: 'github-token', test: value => /^gh[pousr]_[A-Za-z0-9]{20,}$/.test(value) },
  { rule: 'slack-token', test: value => /^xox[baprs]-[A-Za-z0-9-]{10,}$/.test(value) },
  { rule: 'jwt', test: value => /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value) },
  {
    rule: 'url-userinfo',
    test: value => /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i.test(value)
      || /^[^/\s@:]+:[^/\s@]+@[^/\s@]+$/.test(value),
  },
  {
    rule: 'inline-credential',
    test: value => {
      for (const match of value.matchAll(/[?&;]([^=&#\s]+)=/g)) {
        if (isSensitiveCredentialName(match[1])) return true;
      }
      return false;
    },
  },
  { rule: 'private-key', test: value => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) },
];

export interface SecretFinding {
  path: string;
  rule: string;
}

export function findSecretLeaks(value: unknown, path = '$'): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const visit = (current: unknown, currentPath: string) => {
    if (typeof current === 'string') {
      for (const rule of SECRET_VALUE_RULES) {
        if (rule.test(current)) findings.push({ path: currentPath, rule: rule.rule });
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}[${index}]`));
      return;
    }
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (isSensitiveCredentialName(key)) {
          findings.push({ path: `${currentPath}.${key}`, rule: 'sensitive-key' });
        }
        visit(child, `${currentPath}.${key}`);
      }
    }
  };
  visit(value, path);
  return findings;
}

/** Throws without echoing the offending value; only JSON path and rule are reported. */
export function assertNoSecrets(value: unknown): void {
  const findings = findSecretLeaks(value);
  if (findings.length === 0) return;
  const summary = findings.slice(0, 20).map(finding => `${finding.path}:${finding.rule}`).join(', ');
  throw new ProviderConfigBackupError(
    'PROVIDER_CONFIG_BACKUP_SECRET_DETECTED',
    `backup artifact contains secret-like data (${summary})`,
  );
}

export function sanitizeBaseUrl(value: string | null | undefined): {
  value: string | null;
  reasons: RedactionReason[];
} {
  if (!value) return { value: null, reasons: [] };
  const reasons: RedactionReason[] = [];
  let parsed: URL | null = null;
  try {
    parsed = new URL(value);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    let stripped = value;
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*@/i.test(stripped)) {
      stripped = stripped.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
      reasons.push('url_userinfo');
    }
    const withoutCredentials = stripped.replace(
      /([?&])([^=&#\s]+)=([^&#\s]*)/g,
      (match, _separator: string, key: string) => (isSensitiveCredentialName(key) ? '' : match),
    );
    if (withoutCredentials !== stripped) {
      reasons.push('url_query_credential');
      let cleaned = withoutCredentials.replace(/\?&/g, '?').replace(/&&/g, '&').replace(/\?$/, '').replace(/&$/, '');
      if (stripped.includes('?') && !cleaned.includes('?') && cleaned.includes('&')) cleaned = cleaned.replace('&', '?');
      return { value: cleaned, reasons };
    }
    return { value: reasons.length ? stripped : value, reasons };
  }
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
    reasons.push('url_userinfo');
  }
  let removedQuery = false;
  const sensitiveKeys: string[] = [];
  for (const key of parsed.searchParams.keys()) {
    if (isSensitiveCredentialName(key)) sensitiveKeys.push(key);
  }
  for (const key of sensitiveKeys) {
    parsed.searchParams.delete(key);
    removedQuery = true;
  }
  if (removedQuery) reasons.push('url_query_credential');
  return reasons.length ? { value: parsed.toString(), reasons } : { value, reasons };
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function asInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseModels(value: unknown): ModelInfo[] | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as ModelInfo[] : null;
    } catch {
      throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_INVALID_MODELS', 'models_supported is not valid JSON');
    }
  }
  return Array.isArray(value) ? value as ModelInfo[] : null;
}

function asDeploymentType(value: unknown): DeploymentType {
  if (!DEPLOYMENT_TYPES.includes(value as DeploymentType)) {
    throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_INVALID_PROVIDER', 'unsupported deployment_type');
  }
  return value as DeploymentType;
}

function asApiFormat(value: unknown): ApiFormat | null {
  if (value === null || value === undefined || value === '') return null;
  if (!API_FORMATS.includes(value as ApiFormat)) {
    throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_INVALID_PROVIDER', 'unsupported api_format');
  }
  return value as ApiFormat;
}

export function managedFields(record: ProviderConfigRecord): ManagedProviderFields {
  return {
    display_name: optionalText(record.display_name) ?? '',
    deployment_type: asDeploymentType(record.deployment_type ?? 'api'),
    api_format: asApiFormat(record.api_format),
    api_base_url: optionalText(record.api_base_url),
    default_model: optionalText(record.default_model),
    models_supported: parseModels(record.models_supported),
    context_window: asInteger(record.context_window, 4096),
    supports_function_call: asBoolean(record.supports_function_call),
    supports_vision: asBoolean(record.supports_vision),
    input_cost_per_1k: asNumber(record.input_cost_per_1k, 0),
    output_cost_per_1k: asNumber(record.output_cost_per_1k, 0),
    enabled: asBoolean(record.enabled),
    is_default: asBoolean(record.is_default),
    temperature: asNumber(record.temperature, 0.7),
    max_tokens: asInteger(record.max_tokens, 2048),
    timeout_ms: asInteger(record.timeout_ms, 30000),
    rate_limit_per_minute: asInteger(record.rate_limit_per_minute, 60),
    daily_quota: record.daily_quota === null || record.daily_quota === undefined ? null : asInteger(record.daily_quota, 0),
    daily_quota_alert_threshold: asInteger(record.daily_quota_alert_threshold, 80),
  };
}

export function storedAuth(record: ProviderConfigRecord): boolean {
  if (record.stored_auth !== undefined && record.stored_auth !== null) return asBoolean(record.stored_auth);
  return Boolean(record.api_key_encrypted);
}

function providerEntry(record: ProviderConfigRecord, redactions: ProviderConfigBackupDocument['redactions']): ProviderBackupEntry {
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_INVALID_PROVIDER', 'provider name is missing');
  const fields = managedFields(record);
  const baseUrl = sanitizeBaseUrl(fields.api_base_url);
  for (const reason of baseUrl.reasons) redactions.push({ field: `providers.${name}.api_base_url`, reason });
  const sourceId = Number(record.id);
  return {
    name,
    source_id: Number.isSafeInteger(sourceId) && sourceId > 0 ? sourceId : null,
    ...fields,
    api_base_url: baseUrl.value,
    stored_auth: storedAuth(record),
  };
}

function bindingEntry(binding: SceneBinding, providerName: string | null): SceneBindingBackupEntry {
  if (providerName) return { scene: binding.scene, provider: providerName, model: binding.model };
  return { scene: binding.scene, provider: null, model: binding.model, dangling_provider_id: binding.provider_id };
}

export function buildBackupDocument(
  providers: ProviderConfigRecord[],
  bindings: SceneBinding[],
  options: { database: string; now?: Date },
): ProviderConfigBackupDocument {
  const redactions: ProviderConfigBackupDocument['redactions'] = [];
  const seen = new Set<string>();
  const entries = providers
    .map(provider => providerEntry(provider, redactions))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_DUPLICATE_PROVIDER', `duplicate provider name: ${entry.name}`);
    }
    seen.add(entry.name);
  }
  const namesById = new Map<number, string>();
  for (const provider of providers) {
    const id = Number(provider.id);
    if (Number.isSafeInteger(id)) namesById.set(id, String(provider.name).trim());
  }
  const sceneOrder = new Map<string, number>(LLM_SCENES.map((scene, index) => [scene, index]));
  const sceneBindings = bindings
    .map(binding => bindingEntry(binding, namesById.get(binding.provider_id) ?? null))
    .sort((left, right) => (sceneOrder.get(left.scene) ?? 99) - (sceneOrder.get(right.scene) ?? 99));
  const document: ProviderConfigBackupDocument = {
    format: PROVIDER_CONFIG_BACKUP_FORMAT,
    version: PROVIDER_CONFIG_BACKUP_VERSION,
    created_at: (options.now ?? new Date()).toISOString(),
    source: { database: options.database },
    redactions,
    providers: entries,
    scene_bindings: sceneBindings,
  };
  assertNoSecrets(document);
  return document;
}

export function serializeBackupDocument(document: ProviderConfigBackupDocument): string {
  assertNoSecrets(document);
  return `${JSON.stringify(document, null, 2)}\n`;
}

function invalid(message: string): never {
  throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_INVALID_ARTIFACT', message);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(message);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) invalid(`invalid ${field}`);
  return value;
}

function requireInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) invalid(`invalid ${field}`);
  return Number(value);
}

function requireNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) invalid(`invalid ${field}`);
  return value;
}

function validateProvider(raw: unknown, index: number): ProviderBackupEntry {
  const entry = requireRecord(raw, `invalid providers[${index}]`);
  const allowed = new Set([
    'name', 'source_id', 'display_name', 'deployment_type', 'api_format', 'api_base_url', 'default_model',
    'models_supported', 'context_window', 'supports_function_call', 'supports_vision', 'input_cost_per_1k',
    'output_cost_per_1k', 'enabled', 'is_default', 'temperature', 'max_tokens', 'timeout_ms',
    'rate_limit_per_minute', 'daily_quota', 'daily_quota_alert_threshold', 'stored_auth',
  ]);
  for (const key of Object.keys(entry)) if (!allowed.has(key)) invalid(`unknown providers[${index}].${key}`);
  const name = requireString(entry.name, `providers[${index}].name`, 50);
  if (name !== name.trim()) invalid(`invalid providers[${index}].name`);
  const displayName = entry.display_name;
  if (typeof displayName !== 'string' || displayName.length > 100) invalid(`invalid providers[${index}].display_name`);
  const deploymentType = entry.deployment_type;
  if (!DEPLOYMENT_TYPES.includes(deploymentType as DeploymentType)) invalid(`invalid providers[${index}].deployment_type`);
  const apiFormat = entry.api_format;
  if (apiFormat !== null && !API_FORMATS.includes(apiFormat as ApiFormat)) invalid(`invalid providers[${index}].api_format`);
  const baseUrl = entry.api_base_url;
  if (baseUrl !== null && (typeof baseUrl !== 'string' || baseUrl.length > 255)) invalid(`invalid providers[${index}].api_base_url`);
  const defaultModel = entry.default_model;
  if (defaultModel !== null && (typeof defaultModel !== 'string' || !defaultModel.trim() || defaultModel.length > 100)) {
    invalid(`invalid providers[${index}].default_model`);
  }
  let models: ModelInfo[] | null = null;
  if (entry.models_supported !== null) {
    if (!Array.isArray(entry.models_supported)) invalid(`invalid providers[${index}].models_supported`);
    models = entry.models_supported.map((model, modelIndex) => {
      const item = requireRecord(model, `invalid providers[${index}].models_supported[${modelIndex}]`);
      // Legacy rows may carry an empty model id; restore must round-trip them.
      if (typeof item.id !== 'string' || item.id.length > 255) {
        invalid(`invalid providers[${index}].models_supported[${modelIndex}].id`);
      }
      return item as unknown as ModelInfo;
    });
  }
  const contextWindow = requireInteger(entry.context_window, `providers[${index}].context_window`, 1026, 10_000_000);
  const maxTokens = requireInteger(entry.max_tokens, `providers[${index}].max_tokens`, 1, 10_000_000);
  if (maxTokens + 1024 >= contextWindow) invalid(`invalid providers[${index}] context/max_tokens`);
  if (typeof entry.supports_function_call !== 'boolean' || typeof entry.supports_vision !== 'boolean'
    || typeof entry.enabled !== 'boolean' || typeof entry.is_default !== 'boolean' || typeof entry.stored_auth !== 'boolean') {
    invalid(`invalid providers[${index}] boolean fields`);
  }
  const sourceId = entry.source_id;
  if (sourceId !== null && (!Number.isSafeInteger(sourceId) || Number(sourceId) <= 0)) invalid(`invalid providers[${index}].source_id`);
  const dailyQuota = entry.daily_quota;
  if (dailyQuota !== null && (!Number.isSafeInteger(dailyQuota) || Number(dailyQuota) < 0)) invalid(`invalid providers[${index}].daily_quota`);
  return {
    name,
    source_id: sourceId as number | null,
    display_name: displayName,
    deployment_type: deploymentType as DeploymentType,
    api_format: apiFormat as ApiFormat | null,
    api_base_url: baseUrl as string | null,
    default_model: defaultModel as string | null,
    models_supported: models,
    context_window: contextWindow,
    supports_function_call: entry.supports_function_call,
    supports_vision: entry.supports_vision,
    input_cost_per_1k: requireNumber(entry.input_cost_per_1k, `providers[${index}].input_cost_per_1k`, 0, 10_000),
    output_cost_per_1k: requireNumber(entry.output_cost_per_1k, `providers[${index}].output_cost_per_1k`, 0, 10_000),
    enabled: entry.enabled,
    is_default: entry.is_default,
    temperature: requireNumber(entry.temperature, `providers[${index}].temperature`, 0, 9.99),
    max_tokens: maxTokens,
    timeout_ms: requireInteger(entry.timeout_ms, `providers[${index}].timeout_ms`, 1, 600_000),
    rate_limit_per_minute: requireInteger(entry.rate_limit_per_minute, `providers[${index}].rate_limit_per_minute`, 1, 100_000),
    daily_quota: dailyQuota as number | null,
    daily_quota_alert_threshold: requireInteger(entry.daily_quota_alert_threshold, `providers[${index}].daily_quota_alert_threshold`, 0, 100),
    stored_auth: entry.stored_auth,
  };
}

function validateBinding(raw: unknown, index: number): SceneBindingBackupEntry {
  const binding = requireRecord(raw, `invalid scene_bindings[${index}]`);
  const allowed = new Set(['scene', 'provider', 'model', 'dangling_provider_id']);
  for (const key of Object.keys(binding)) if (!allowed.has(key)) invalid(`unknown scene_bindings[${index}].${key}`);
  if (!LLM_SCENES.includes(binding.scene as LLMScene)) invalid(`invalid scene_bindings[${index}].scene`);
  const provider = binding.provider;
  if (provider !== null && (typeof provider !== 'string' || !provider.trim() || provider.length > 50)) {
    invalid(`invalid scene_bindings[${index}].provider`);
  }
  const model = requireString(binding.model, `scene_bindings[${index}].model`, 255);
  if (provider === null) {
    requireInteger(binding.dangling_provider_id, `scene_bindings[${index}].dangling_provider_id`, 0, Number.MAX_SAFE_INTEGER);
    return {
      scene: binding.scene as LLMScene,
      provider: null,
      model,
      dangling_provider_id: binding.dangling_provider_id as number,
    };
  }
  if (binding.dangling_provider_id !== undefined) invalid(`unexpected scene_bindings[${index}].dangling_provider_id`);
  return { scene: binding.scene as LLMScene, provider: provider as string, model };
}

export function parseBackupArtifact(text: string): ProviderConfigBackupDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_INVALID_ARTIFACT', 'artifact is not valid JSON');
  }
  assertNoSecrets(raw);
  const document = requireRecord(raw, 'artifact root must be an object');
  const allowed = new Set(['format', 'version', 'created_at', 'source', 'redactions', 'providers', 'scene_bindings']);
  for (const key of Object.keys(document)) if (!allowed.has(key)) invalid(`unknown artifact field: ${key}`);
  if (document.format !== PROVIDER_CONFIG_BACKUP_FORMAT) {
    throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_UNSUPPORTED', 'unsupported artifact format');
  }
  if (document.version !== PROVIDER_CONFIG_BACKUP_VERSION) {
    throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_UNSUPPORTED', 'unsupported artifact version');
  }
  if (typeof document.created_at !== 'string' || Number.isNaN(Date.parse(document.created_at))) invalid('invalid created_at');
  const source = requireRecord(document.source, 'invalid source');
  const database = requireString(source.database, 'source.database', 128);
  for (const key of Object.keys(source)) if (key !== 'database') invalid(`unknown source.${key}`);
  if (!Array.isArray(document.redactions)) invalid('invalid redactions');
  const redactions = document.redactions.map((rawRedaction, index) => {
    const redaction = requireRecord(rawRedaction, `invalid redactions[${index}]`);
    if (redaction.reason !== 'url_userinfo' && redaction.reason !== 'url_query_credential') invalid(`invalid redactions[${index}].reason`);
    return { field: requireString(redaction.field, `redactions[${index}].field`, 255), reason: redaction.reason as RedactionReason };
  });
  if (!Array.isArray(document.providers) || document.providers.length > 1000) invalid('invalid providers');
  const providers = document.providers.map(validateProvider);
  const names = new Set<string>();
  for (const provider of providers) {
    if (names.has(provider.name)) invalid(`duplicate provider: ${provider.name}`);
    names.add(provider.name);
  }
  if (!Array.isArray(document.scene_bindings) || document.scene_bindings.length > LLM_SCENES.length) invalid('invalid scene_bindings');
  const sceneBindings = document.scene_bindings.map(validateBinding);
  const scenes = new Set<string>();
  for (const binding of sceneBindings) {
    if (scenes.has(binding.scene)) invalid(`duplicate scene binding: ${binding.scene}`);
    scenes.add(binding.scene);
  }
  return {
    format: PROVIDER_CONFIG_BACKUP_FORMAT,
    version: PROVIDER_CONFIG_BACKUP_VERSION,
    created_at: document.created_at,
    source: { database },
    redactions,
    providers,
    scene_bindings: sceneBindings,
  };
}

export function backupChecksum(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function changedProviderFields(current: ProviderConfigRecord, entry: ProviderBackupEntry): Array<keyof ManagedProviderFields> {
  const currentFields = managedFields(current);
  return PROVIDER_MANAGED_FIELDS.filter(field => JSON.stringify(currentFields[field]) !== JSON.stringify(entry[field]));
}

export interface ProviderRestoreChange {
  name: string;
  changed_fields: Array<keyof ManagedProviderFields>;
}

export interface RestorePlan {
  create: string[];
  update: ProviderRestoreChange[];
  unchanged: string[];
  disable_extra: string[];
  credentials_required: string[];
  /** Providers whose stored base URL contains credentials that the backup removed. */
  base_url_redactions: string[];
  bindings_upsert: SceneBindingBackupEntry[];
  bindings_changed: LLMScene[];
  bindings_delete: LLMScene[];
  dangling_bindings: SceneBindingBackupEntry[];
}

export function buildRestorePlan(
  currentProviders: ProviderConfigRecord[],
  currentBindings: SceneBinding[],
  document: ProviderConfigBackupDocument,
): RestorePlan {
  const currentByName = new Map(currentProviders.map(provider => [provider.name, provider]));
  const backupNames = new Set(document.providers.map(provider => provider.name));
  const plan: RestorePlan = {
    create: [], update: [], unchanged: [], disable_extra: [], credentials_required: [], base_url_redactions: [],
    bindings_upsert: document.scene_bindings,
    bindings_changed: [],
    bindings_delete: [],
    dangling_bindings: document.scene_bindings.filter(binding => binding.provider === null),
  };
  for (const entry of document.providers) {
    const current = currentByName.get(entry.name);
    if (!current) {
      plan.create.push(entry.name);
    } else {
      const changed = changedProviderFields(current, entry);
      if (changed.length) plan.update.push({ name: entry.name, changed_fields: changed });
      else plan.unchanged.push(entry.name);
      const currentFields = managedFields(current);
      const sanitizedBase = sanitizeBaseUrl(currentFields.api_base_url);
      if (currentFields.api_base_url !== entry.api_base_url
        && sanitizedBase.reasons.length && sanitizedBase.value === entry.api_base_url) {
        plan.base_url_redactions.push(entry.name);
      }
    }
    if (entry.stored_auth && (!current || !storedAuth(current))) plan.credentials_required.push(entry.name);
  }
  for (const provider of currentProviders) {
    if (!backupNames.has(provider.name) && asBoolean(provider.enabled)) plan.disable_extra.push(provider.name);
  }
  const currentByScene = new Map(currentBindings.map(binding => [binding.scene, binding]));
  const backupScenes = new Set(document.scene_bindings.map(binding => binding.scene));
  for (const binding of document.scene_bindings) {
    const current = currentByScene.get(binding.scene);
    const provider = binding.provider ? currentByName.get(binding.provider) : undefined;
    const targetId = binding.provider === null ? binding.dangling_provider_id ?? 0 : Number(provider?.id ?? -1);
    if (!current || current.model !== binding.model || current.provider_id !== targetId) plan.bindings_changed.push(binding.scene);
  }
  plan.bindings_delete = currentBindings
    .map(binding => binding.scene)
    .filter(scene => !backupScenes.has(scene));
  return plan;
}

export interface VerificationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  provider?: string;
  scene?: string;
  fields?: string[];
}

export interface VerificationResult {
  ok: boolean;
  issues: VerificationIssue[];
  summary: {
    providers_expected: number;
    providers_present: number;
    extra_enabled: string[];
    bindings_expected: number;
    bindings_present: number;
    bindings_extra: LLMScene[];
    credentials_required: string[];
  };
}

function providersForRouting(records: ProviderConfigRecord[]): LLMProvider[] {
  return records.map(record => ({
    ...record,
    display_name: optionalText(record.display_name) ?? record.name,
    deployment_type: asDeploymentType(record.deployment_type ?? 'api'),
    api_format: asApiFormat(record.api_format),
    models_supported: parseModels(record.models_supported),
    context_window: asInteger(record.context_window, 4096),
    supports_function_call: asBoolean(record.supports_function_call),
    supports_vision: asBoolean(record.supports_vision),
    enabled: asBoolean(record.enabled),
    is_default: asBoolean(record.is_default),
    max_tokens: asInteger(record.max_tokens, 2048),
  })) as unknown as LLMProvider[];
}

const SCENE_REQUIREMENTS: Record<LLMScene | 'default', { requiresFunctionCall: boolean }> = {
  default: { requiresFunctionCall: false },
  chat: { requiresFunctionCall: true },
  sql_analysis: { requiresFunctionCall: true },
  fault_diagnosis: { requiresFunctionCall: true },
  health_check: { requiresFunctionCall: false },
};

export function verifyRestoredConfiguration(
  currentProviders: ProviderConfigRecord[],
  currentBindings: SceneBinding[],
  document: ProviderConfigBackupDocument,
  options: { requireCredentials?: boolean } = {},
): VerificationResult {
  const issues: VerificationIssue[] = [];
  const currentByName = new Map(currentProviders.map(provider => [provider.name, provider]));
  const backupNames = new Set(document.providers.map(provider => provider.name));
  const credentialsRequired: string[] = [];
  let present = 0;
  for (const entry of document.providers) {
    const current = currentByName.get(entry.name);
    if (!current) {
      issues.push({ code: 'PROVIDER_MISSING', severity: 'error', provider: entry.name, message: `提供商 ${entry.name} 未恢复` });
      continue;
    }
    present++;
    const changed = changedProviderFields(current, entry);
    if (changed.length) {
      issues.push({ code: 'PROVIDER_FIELD_MISMATCH', severity: 'error', provider: entry.name, fields: changed,
        message: `提供商 ${entry.name} 字段与备份不一致：${changed.join(', ')}` });
    }
    const currentFields = managedFields(current);
    const sanitizedBase = sanitizeBaseUrl(currentFields.api_base_url);
    if (currentFields.api_base_url !== entry.api_base_url
      && sanitizedBase.reasons.length && sanitizedBase.value === entry.api_base_url) {
      issues.push({
        code: 'BASE_URL_CREDENTIALS_REMOVED',
        severity: 'warning',
        provider: entry.name,
        message: `提供商 ${entry.name} 的 Base URL 含凭据；恢复会写入脱敏后的 URL，若连接依赖该凭据将不可用`,
      });
    }
    if (entry.stored_auth && !storedAuth(current)) {
      credentialsRequired.push(entry.name);
      issues.push({
        code: 'CREDENTIAL_REQUIRED',
        severity: options.requireCredentials ? 'error' : 'warning',
        provider: entry.name,
        message: `提供商 ${entry.name} 的密钥不在备份中，需要在管理界面重新录入`,
      });
    }
  }
  const extraEnabled = currentProviders
    .filter(provider => !backupNames.has(provider.name) && asBoolean(provider.enabled))
    .map(provider => provider.name);
  for (const name of extraEnabled) {
    issues.push({ code: 'EXTRA_PROVIDER_ENABLED', severity: 'error', provider: name,
      message: `提供商 ${name} 不在备份中但仍处于启用状态` });
  }
  const currentByScene = new Map(currentBindings.map(binding => [binding.scene, binding]));
  const backupScenes = new Set(document.scene_bindings.map(binding => binding.scene));
  const danglingScenes = new Set<LLMScene>();
  for (const binding of document.scene_bindings) {
    if (binding.provider === null) {
      danglingScenes.add(binding.scene);
      issues.push({
        code: 'DANGLING_BINDING',
        severity: 'warning',
        scene: binding.scene,
        message: `场景 ${binding.scene} 在备份时即指向已删除的提供商；恢复保留悬空引用，需管理员重新绑定`,
      });
    }
    const targetProvider = binding.provider ? currentByName.get(binding.provider) : undefined;
    const targetId = binding.provider === null ? binding.dangling_provider_id ?? 0 : Number(targetProvider?.id ?? NaN);
    if (binding.provider !== null && !targetProvider) {
      issues.push({ code: 'BINDING_PROVIDER_MISSING', severity: 'error', scene: binding.scene, provider: binding.provider,
        message: `场景 ${binding.scene} 绑定的提供商 ${binding.provider} 不存在` });
    }
    const current = currentByScene.get(binding.scene);
    if (!current || current.model !== binding.model || current.provider_id !== targetId) {
      issues.push({ code: 'BINDING_MISMATCH', severity: 'error', scene: binding.scene,
        message: `场景 ${binding.scene} 的绑定与备份不一致` });
    }
  }
  const extraBindings = currentBindings.filter(binding => !backupScenes.has(binding.scene)).map(binding => binding.scene);
  for (const scene of extraBindings) {
    issues.push({ code: 'BINDING_NOT_IN_BACKUP', severity: 'error', scene,
      message: `场景 ${scene} 的绑定不在备份中` });
  }
  const routingProviders = providersForRouting(currentProviders);
  for (const scene of LLM_SCENES) {
    if (danglingScenes.has(scene)) continue;
    try {
      selectSceneModel(routingProviders, currentBindings, scene, SCENE_REQUIREMENTS[scene]);
    } catch (error) {
      if (!(error instanceof LLMConfigurationError)) throw error;
      issues.push({ code: 'SCENE_UNRESOLVABLE', severity: 'error', scene,
        message: `场景 ${scene} 无法解析：${error.message}` });
    }
  }
  // The global default only matters as a fallback. When every scene is bound
  // explicitly, an unset default is a UI-only warning and must not fail restore.
  if (!LLM_SCENES.every(scene => backupScenes.has(scene))) {
    try {
      selectSceneModel(routingProviders, currentBindings, 'default', SCENE_REQUIREMENTS.default);
    } catch (error) {
      if (!(error instanceof LLMConfigurationError)) throw error;
      issues.push({ code: 'SCENE_UNRESOLVABLE', severity: 'error', scene: 'default',
        message: `全局默认无法解析：${error.message}` });
    }
  }
  return {
    ok: issues.every(issue => issue.severity !== 'error'),
    issues,
    summary: {
      providers_expected: document.providers.length,
      providers_present: present,
      extra_enabled: extraEnabled,
      bindings_expected: document.scene_bindings.length,
      bindings_present: document.scene_bindings.filter(binding => currentByScene.has(binding.scene)).length,
      bindings_extra: extraBindings,
      credentials_required: credentialsRequired,
    },
  };
}
