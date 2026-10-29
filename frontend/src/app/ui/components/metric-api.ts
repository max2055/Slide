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
/** Status strip only: recommendations are a separate product column and must not gate history. */
export const readCollectionSummary = (type: string, id: number) => metricRequest<CollectionStatus>(`${collectionRoot(type, id)}/status`);
/** Wire contract: MAX-189 CollectionAttemptSchema, newest first (LIMIT 20). */
export interface CollectionAttempt {
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
  started_at: string; ended_at?: string;
  error: 'timeout' | 'permission_denied' | 'connection_error' | 'parse_error' | 'cancelled' | null;
  evidence_code?: string;
}
export async function readCollectionAttempts(type: string, id: number): Promise<CollectionAttempt[]> {
  const rows = await metricRequest<CollectionAttempt[]>(`${collectionRoot(type, id)}/attempts`);
  if (!Array.isArray(rows)) throw new Error('METRIC_ATTEMPT_CONTRACT');
  return rows;
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
  constructor(readonly status: number, readonly code?: string) { super(String(status)); }
}
export async function metricRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await authFetch(`/api/metrics/${path}`, {
    signal: AbortSignal.timeout(35000),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new MetricRequestError(response.status, typeof body?.error === 'string' ? body.error : undefined);
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
