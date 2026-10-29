import { authFetch } from '../../../api/index.js';
import type { Overrides } from './metric-policy-fields.js';

export type Pin = { id: string; version: string; digest: string };
export interface Applicability { attribute: string; value: string | number | boolean | null; supported_values: string[]; status: string }
export interface Resolved {
  applicability?: Applicability[];
  settings: Record<string, number | boolean>;
  sources: Record<string, { layer: string; id: string }>;
  metric_templates: Array<{ metric: { id: string; semantic_version: string }; enabled: boolean; decision: string;
    capability: { status: string; basis: unknown[]; evaluated_at: string; valid_until: string } }>;
  metric_sources: Record<string, { layer: string; id: string }>;
}
export interface Published {
  binding: { package: Pin; revision: number; group_id: string | null; overrides: Overrides };
  resolved: Resolved;
  application: { status: string; applied_revision: number | null };
}
export interface Catalog {
  packages: Array<{ package: Pin & { resource_type: string; applicability: Array<{ attribute: string; values: string[] }>;
    collectors?: Array<{ mappings?: Array<{ metric: { id: string } }> }> };
    derived?: Array<{ output: { id: string } }>; recommendations: Record<string, number | boolean>;
    documentation: Array<{ collector_id?: string; permissions?: string[]; discovery?: string }> }>;
  metrics: Array<{ id: string; category: string; semantic_version: string; unit: string; kind: string; resource_type: string }>;
}
/** Wire contract: MAX-189 configuration-status.ts, contract_version 1.0.0. */
export interface CollectionStatus {
  contract_version: '1.0.0';
  resource: { type: string; id: number };
  evaluated_at: string;
  can_manage: boolean;
  binding: { state: 'bound' | 'unbound'; package: Pin | null; published_revision: number | null; applied_revision: number | null; application: string };
  effective_enabled: { enabled: boolean; global_enabled: boolean; asset_enabled: boolean; policy_enabled: boolean; source: string };
  collection: { state: string; last_attempt_at: string | null; last_success_at: string | null; in_flight: boolean };
  formal_visibility: { state: string; source: string; last_observed_at: string | null; generation: number | null };
  blockers: string[];
  coverage: Array<{ metric: { id: string; semantic_version: string }; state: string; reason: string | null }>;
}
export interface Recommendation { package: Pin; status: string; recommended: boolean; applicability: Applicability[]; metrics: string[]; missing_core_metrics?: string[] }
export interface RecommendationResult {
  resource: { type: string; id: number }; evaluated_at: string;
  packages: Array<{ release: Catalog['packages'][number]; compatibility: 'compatible' | 'incompatible' | 'unknown';
    recommended: boolean; checks: Applicability[]; coverage: Array<{ id: string; semantic_version: string }>; missing_core_metrics: string[] }>;
}
/** Adapt recommendations once; no compatibility is inferred from package ordering. */
export const recommendationOptions = (data: RecommendationResult): Recommendation[] => data.packages.map(p => ({
  package: p.release.package, status: p.compatibility === 'compatible' ? 'supported' : p.compatibility === 'incompatible' ? 'unsupported' : 'unknown',
  recommended: p.recommended, applicability: p.checks, metrics: p.coverage.map(m => m.id), missing_core_metrics: p.missing_core_metrics ?? [],
}));
/** A missing template metric is a version limitation only when every release that
 * provides it is explicitly rejected for this resource version. */
export function coverageAvailability(status: CollectionStatus, data: RecommendationResult): CollectionStatus {
  return { ...status, coverage: status.coverage.map(c => {
    if (c.state !== 'not_covered') return c;
    const providers = data.packages.filter(p => p.coverage.some(m => m.id === c.metric.id));
    return providers.length && providers.every(p => p.compatibility === 'incompatible'
      && p.checks.some(check => check.attribute === 'db.version' && check.status === 'unsupported'))
      ? { ...c, state: 'unsupported', reason: 'VERSION_UNSUPPORTED' } : c;
  }) };
}
export async function readCollectionStatus(type: string, id: number): Promise<CollectionStatus> {
  const status = await metricRequest<CollectionStatus>(`${collectionRoot(type, id)}/status`);
  // Capacity is a separate product column. Preserve verified binding state when
  // supplementary recommendation metadata cannot be read; do not invent support.
  if (type !== 'instance') return status;
  try { return coverageAvailability(status, await metricRequest<RecommendationResult>(`${collectionRoot(type, id)}/recommendations`)); }
  catch (e) { if (e instanceof MetricRequestError && [401, 403, 404].includes(e.status)) throw e; return status; }
}
export interface PolicyGroup { id: string; label?: string; revision: number; can_manage?: boolean }
export class MetricRequestError extends Error {
  constructor(readonly status: number, readonly code?: string,
    /** Structured rejection fields (conflict item/setting, release, provider), never a driver message. */
    readonly details: Record<string, unknown> = {}) { super(String(status)); }
}
export async function metricRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await authFetch(`/api/metrics/${path}`, {
    signal: AbortSignal.timeout(35000),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const { error, ...details } = body && typeof body === 'object' ? body as Record<string, unknown> : {} as Record<string, unknown>;
    throw new MetricRequestError(response.status, typeof error === 'string' ? error : undefined, details);
  }
  const data = await response.json();
  if (path.endsWith('/status') && (!data || data.contract_version !== '1.0.0' || !data.binding
    || !['bound', 'unbound'].includes(data.binding.state) || !data.effective_enabled || !data.collection
    || !data.formal_visibility || typeof data.can_manage !== 'boolean'
    || !['enabled', 'global_enabled', 'asset_enabled', 'policy_enabled'].every(key => typeof data.effective_enabled[key] === 'boolean')
    || typeof data.effective_enabled.source !== 'string' || typeof data.binding.application !== 'string'
    || typeof data.collection.state !== 'string' || typeof data.formal_visibility.state !== 'string'
    || !Array.isArray(data.blockers) || !data.blockers.every((b: unknown) => typeof b === 'string')
    || !Array.isArray(data.coverage) || !data.coverage.every((c: CollectionStatus['coverage'][number]) =>
      c && typeof c.metric?.id === 'string' && typeof c.state === 'string'))) {
    throw new Error('METRIC_STATUS_CONTRACT');
  }
  return data;
}
export const metricError = (error: unknown) => ({
  '401': '登录已失效，请重新登录', '403': '没有此资源的操作权限', '404': '配置或资源不存在',
  '422': '配置或试采未通过，请检查兼容性和采集证据后重试',
  '409': '配置已变化或试采正在运行，请重新加载并预览、试采', '400': '配置不符合约束，请检查覆盖值和依赖',
}[error instanceof Error ? error.message : ''] ?? '暂时无法完成操作，请稍后重试');
export const collectionStatusLabels: Record<string, string> = {
  GLOBAL_COLLECTION_DISABLED: '全局采集已关闭，请联系运维启用采集服务',
  ASSET_COLLECTION_DISABLED: '资产采集已停用，模板启用不能覆盖资产停用', POLICY_COLLECTION_DISABLED: '策略采集已停用',
  APPLICATION_PENDING: '等待调度应用', APPLICATION_FAILED: '调度应用失败，请检查服务日志并重新检查配置',
  PACKAGE_INCOMPATIBLE: '模板与资源不兼容', CAPABILITY_UNKNOWN: '资源能力待验证', COLLECTION_FAILED: '最近采集失败',
  SOURCE_VALIDATION_PENDING: '正式来源验证中', SOURCE_VALIDATION_FAILED: '正式来源验证失败', AWAITING_SAMPLE: '等待正式样本', UNBOUND: '尚未绑定采集模板',
  global: '全局开关', validating: '来源验证中', running: '采集中', succeeded: '最近采集成功',
  bound: '已绑定', unbound: '未绑定', unknown: '未知', enabled: '启用', disabled: '已停用',
  pending: '等待应用', applied: '已应用', failed: '失败', ready: '正式可用', available: '正式可用',
  waiting: '待样本', waiting_sample: '待样本', verifying: '来源验证中', blocked: '存在阻塞',
  global_disabled: '全局采集已关闭，请联系运维启用采集服务', resource_disabled: '资源已停用',
  source_not_active: '正式来源尚未接管', source_verifying: '正式来源验证中',
  covered: '模板已覆盖', not_covered: '当前模板未覆盖', unsupported: '该版本不支持', stale: '观测已陈旧', partial: '部分覆盖',
  package: '模板推荐', platform: '平台默认', resource: '本资源覆盖', group: '策略组继承', asset: '资产开关',
};
export const statusLabel = (value?: string) => collectionStatusLabels[value ?? 'unknown'] ?? '待确认';
export const collectionRoot = (type: string, id: number) => `config/resources/${type}/${id}`;

/* --- Native fixed-version template bindings (MAX-238) --------------------- */

export interface TemplatePin { template_id: string; version: number; content_hash: string }
export interface TemplateVersionSummary { version: number; content_hash: string; status: 'published' | 'retired' }
export interface TemplateSummary {
  template_id: string; name: string; status: 'draft' | 'active' | 'deprecated' | 'archived';
  current_published_version: number | null; versions: TemplateVersionSummary[];
}
export interface TemplateCatalogPage { templates: TemplateSummary[]; next_cursor: string | null }
export interface TemplateParameterSpec { type: 'number' | 'integer' | 'boolean' | 'string'; min?: number; max?: number }
export interface TemplateVersionDetail {
  template_id: string; version: number; status: 'published' | 'retired'; content_hash: string;
  items: Array<{ item_id: string; version: number; display_name: string;
    canonical_metric: { id: string; semantic_version: string }; unit: string;
    dimensions: Record<string, string>; collector_ref: { package_release: string; implementation_id: string } }>;
  parameters: { schema: Record<string, TemplateParameterSpec>; defaults: Record<string, number | string | boolean> };
  source_chain: Record<string, unknown>; published_at: string;
}
export interface ResolvedParameter {
  name: string; type: TemplateParameterSpec['type'];
  default: number | string | boolean | null; override: number | string | boolean | null;
  effective: number | string | boolean; source: 'default' | 'override';
}
export interface TemplatePending {
  base_revision: number; target_revision: number; resolution_identity: string;
  decided_at: string; operation_key: string;
  plan: { settings: Record<string, number | boolean>; parameters: Array<{ pin: TemplatePin; parameters: ResolvedParameter[] }>;
    releases: unknown[]; excluded: unknown[] };
}
export interface TemplateBindingStatus {
  source: 'template' | 'package' | 'unbound'; revision: number | null;
  application: { status: string; applied_revision: number | null; reported_at: string | null; error_code: string | null } | null;
  template_pins: TemplatePin[]; pending: TemplatePending | null;
  /** The stored per-resource choice; an editor round-trips from this, never from a plan. */
  configuration: { overrides: Record<string, unknown>; group_id: string | null } | null;
  effective: { revision: number; resolution_identity: string | null } | null; published_at: string | null;
}
export interface TemplatePreviewItem {
  template_id: string; item_id: string; item_version: number;
  canonical_metric: { id: string; semantic_version: string }; unit: string; dimensions: Record<string, string>;
  release: { id: string; version: string; digest: string }; release_ref: string;
  collector_id: string; implementation_id: string; enabled: boolean;
  decision: 'collect' | 'derive' | 'disabled' | 'unsupported' | 'capability_unknown';
  capability: 'supported' | 'unsupported' | 'unknown';
}
export interface TemplateExclusion {
  pin: TemplatePin; template_id: string; item_id: string; item_version: number;
  release: { id: string; version: string; digest: string }; metric: { id: string; semantic_version: string };
  decision: 'disabled' | 'unsupported' | 'capability_unknown';
  reason: 'settings_disabled' | 'metric_disabled' | 'capability_unsupported' | 'capability_unknown';
  blocking: boolean;
}
export interface TemplatePreview {
  template: true; resource: { type: string; id: number }; revision: number; resolution_identity: string;
  executable: boolean; settings: Record<string, number | boolean>;
  parameters: Array<{ pin: TemplatePin; parameters: ResolvedParameter[] }>;
  releases: Array<{ release: { id: string; version: string; digest: string }; release_ref: string;
    interval_ms: number; timeout_ms: number; collector_ids: string[]; metric_keys: string[];
    requests_per_hour_estimate: number;
    applicability: Array<{ attribute: string; value: string | number | boolean | null; supported_values: string[]; status: string }> }>;
  items: TemplatePreviewItem[]; excluded: TemplateExclusion[];
  budget: { estimated_series_upper_bound: number; max_series_per_resource: number; requests_per_hour_estimate: number };
  plan: unknown;
}
export interface TemplateTrialSample {
  template_id: string; item_id: string; item_version: number;
  metric: { id: string; semantic_version: string }; value: unknown; unit: string; observed_at: string;
  quality: { status?: string; reason?: string } | null;
  read: { collector_id: string; attempt_ids: string[]; status: string };
  transform: { version: string }; unit_check: { input_unit: string; output_unit: string };
}
export interface TemplateTrial {
  trial: true; persisted: false; decision: 'attempted' | 'disabled' | 'unsupported' | 'capability_unknown';
  receipt_id: string; expires_at: string; resolution_identity: string;
  items: Array<{ template_id: string; item_id: string; item_version: number;
    phases: { read: boolean; transform: boolean; unit: boolean } }>;
  optional_exclusions: Array<{ template_id: string; item_id: string; item_version: number }>;
  samples: TemplateTrialSample[];
  attempts: Array<{ collector_id?: string; status: string; error?: string }>;
  releases: Array<{ release_ref: string; decision: string }>;
}
export type TemplateApplyResult =
  | { kind: 'legacy_delegate' }
  | { kind: 'replay'; base_revision: number; target_revision: number; candidate_digest: string;
      operation: { key: string; caller_key: string; receipt_id: string; status: 'committed' } }
  | { kind: 'operation_lookup_required'; candidate_digest: string;
      operation: { key: string; caller_key: string; status: 'unknown' } }
  | { kind: 'rejected'; code: string }
  | { kind: 'committed'; revision: number; resolution_identity: string;
      operation: { key: string; caller_key: string; receipt_id: string; status: 'committed' } }
  | { kind: 'rolled_back'; code: string }
  | { kind: 'commit_unknown'; cause: string;
      operation: { key: string; caller_key: string; status: 'unknown' } };
export interface TemplateOperationState {
  state: 'committed' | 'pending' | 'absent';
  operation: { resource: { type: string; id: number }; target_revision: number; candidate_digest: string;
    resolution_identity: string; status: 'committed' | 'unknown' | 'pending' } | null;
}
export interface TemplateBindingRequest {
  expected_revision: number; template_pins: TemplatePin[];
  overrides?: Record<string, unknown>; group_id?: string | null;
}
const queryString = (params: Record<string, string | number | undefined>) => {
  const query = Object.entries(params).filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
  return query ? `?${query}` : '';
};
export const listMetricTemplates = (params: { query?: string; status?: string; cursor?: string; limit?: number } = {}) =>
  metricRequest<TemplateCatalogPage>(`templates${queryString(params)}`);
export const getMetricTemplateVersion = (templateId: string, version: number) =>
  metricRequest<TemplateVersionDetail>(`templates/${encodeURIComponent(templateId)}/versions/${version}`);
export const readTemplateBinding = (type: string, id: number) =>
  metricRequest<TemplateBindingStatus>(`template-bindings/${type}/${id}`);
export const previewTemplateBinding = (type: string, id: number, body: TemplateBindingRequest) =>
  metricRequest<TemplatePreview>(`template-bindings/${type}/${id}/preview`, body);
export const trialTemplateBinding = (type: string, id: number, body: TemplateBindingRequest & { receipt_id: string }) =>
  metricRequest<TemplateTrial>(`template-bindings/${type}/${id}/trial`, body);
export const applyTemplateBinding = (type: string, id: number,
  body: TemplateBindingRequest & { receipt_id: string; caller_key: string }) =>
  metricRequest<TemplateApplyResult>(`template-bindings/${type}/${id}/apply`, body);
export const readTemplateOperation = (type: string, id: number, key: string) =>
  metricRequest<TemplateOperationState>(`template-bindings/${type}/${id}/operations/${encodeURIComponent(key)}`);
export type TemplateRepinResult = { unchanged: true; template_id: string; version: number } | {
  unchanged: false; template_id: string; from_version: number; to_version: number; content_hash: string;
  changes: Array<{ item_id: string;
    from: { version: number; release: string; implementation_id: string };
    to: { version: number; release: string; implementation_id: string };
    reason: 'target_version_incompatible' }>;
  pin: TemplatePin;
};
/** Publishes one new immutable template version for this target; never edits the old version. */
export const repinMetricTemplate = (templateId: string, resource: { type: string; id: number }) =>
  metricRequest<TemplateRepinResult>(`templates/${encodeURIComponent(templateId)}/repin`, { resource });
