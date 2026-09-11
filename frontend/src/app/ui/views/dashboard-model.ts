export type ResourceType = 'instance' | 'server' | 'network_device';
export type Scope = 'all' | ResourceType;
export type RunState = 'normal' | 'abnormal' | 'unavailable' | 'unknown';
export interface Ref { type: ResourceType; id: number }
export interface Metric {
  metricId: string; value: number | null; quality: string; observedAt: string | null;
  validUntil: string | null; reason?: string; dimensions?: Record<string, string>;
}
export interface OverviewItem {
  resource: Ref; label: string; status: string; quality: string; freshness: 'fresh' | 'stale' | 'missing';
  observedAt: string | null; unresolvedAlerts: number; alertIds?: string[]; alertSeverity?: string;
  alertsTruncated?: boolean; relationCount: number; impactScope: Ref[]; gaps: string[];
  attributes?: Record<string, unknown>; observations?: Metric[]; alertsObservedAt?: string;
}
export interface Overview { unavailableTypes?: ResourceType[]; collectedAt: string; dataQuality: string; truncated?: boolean; limit?: number; items: OverviewItem[] }
export const resourceKey = (ref: Ref) => `${ref.type}:${ref.id}`;
export const resourceTypes: ResourceType[] = ['instance', 'server', 'network_device'];
export const metricConfig: Record<ResourceType, string[]> = {
  instance: ['cpu_usage', 'memory_usage', 'disk_usage', 'connections', 'qps'],
  server: ['cpu_usage', 'memory_usage', 'disk_usage'],
  network_device: ['device_cpu_percent', 'device_memory_percent', 'device_temperature_celsius'],
};
export function latestMetric(item: OverviewItem, id: string): Metric | undefined {
  return item.observations?.filter(metric => metric.metricId === id)
    .sort((a, b) => (Date.parse(b.observedAt ?? '') || 0) - (Date.parse(a.observedAt ?? '') || 0))[0];
}
export function usableMetric(metric: Metric | undefined, now = Date.now()): boolean {
  if (!metric || metric.value === null || !Number.isFinite(metric.value) || !['good', 'degraded'].includes(metric.quality)) return false;
  const observed = Date.parse(metric.observedAt ?? '');
  const expiry = Date.parse(metric.validUntil ?? '');
  return Number.isFinite(observed) && observed <= now && now - observed <= 300_000
    && Number.isFinite(expiry) && expiry > now;
}
export function freshness(item: OverviewItem, now = Date.now()): 'fresh' | 'stale' | 'missing' | 'failed' {
  if (item.gaps.includes('OBSERVATIONS_UNAVAILABLE')) return 'failed';
  const observed = Date.parse(item.observedAt ?? '');
  if (!Number.isFinite(observed) || observed > now || item.freshness === 'missing') return 'missing';
  return item.freshness === 'stale' || now - observed > 300_000 ? 'stale' : 'fresh';
}
export function runState(item: OverviewItem, now = Date.now()): RunState {
  const status = item.status.toLowerCase();
  const alertsUnavailable = item.gaps.includes('ALERTS_UNAVAILABLE');
  const reachable = latestMetric(item, 'device_reachability');
  if (usableMetric(reachable, now)) {
    if (reachable.value === 0) return 'unavailable';
    if (alertsUnavailable) return 'unknown';
    if (item.unresolvedAlerts > 0 && !alertsUnavailable) return 'abnormal';
    if (reachable.value === 1) return 'normal';
  }
  // Explicit inventory outages remain actionable even without collected metrics.
  if (['offline', 'down', 'unreachable', 'unavailable'].includes(status)) return 'unavailable';
  if (item.unresolvedAlerts > 0 && !alertsUnavailable) return 'abnormal';
  if (freshness(item, now) !== 'fresh') return 'unknown';
  if (['critical', 'error', 'warning', 'degraded', 'unhealthy'].includes(status)) return 'abnormal';
  if (alertsUnavailable) return 'unknown';
  if (['online', 'healthy', 'normal', 'ok', 'reachable'].includes(status) && item.quality === 'good') return 'normal';
  return 'unknown'; // configured "active" and lack of alarms are not health evidence
}
export const collectionRisk = (item: OverviewItem) => freshness(item) !== 'fresh' || item.quality !== 'good';
export const isRisk = (item: OverviewItem) => ['abnormal', 'unavailable'].includes(runState(item)) || collectionRisk(item) || item.gaps.includes('ALERTS_UNAVAILABLE');
export function compareRisk(a: OverviewItem, b: OverviewItem): number {
  const tier = (item: OverviewItem) => runState(item) === 'unavailable' || (!item.gaps.includes('ALERTS_UNAVAILABLE') && item.unresolvedAlerts > 0 && item.alertSeverity === 'critical') ? 0 : runState(item) === 'abnormal' ? 1 : isRisk(item) ? 2 : 3;
  const severity = (item: OverviewItem) => ({ critical: 0, error: 1, warning: 2, warn: 2, info: 3 }[item.alertSeverity ?? ''] ?? 4);
  return tier(a) - tier(b) || severity(a) - severity(b) || b.impactScope.length - a.impactScope.length || b.unresolvedAlerts - a.unresolvedAlerts || resourceKey(a.resource).localeCompare(resourceKey(b.resource));
}
export function scopedItems(overview: Overview | null, scope: Scope, search = '', engine = ''): OverviewItem[] {
  return [...new Map((overview?.items ?? []).map(item => [resourceKey(item.resource), item])).values()]
    .filter(item => (scope === 'all' || item.resource.type === scope)
      && (!engine || String(item.attributes?.dbType ?? 'unknown') === engine)
      && `${item.label} ${item.attributes?.host ?? ''} ${resourceKey(item.resource)}`.toLowerCase().includes(search.trim().toLowerCase()));
}
export function summarize(items: OverviewItem[]) {
  const available = items.filter(item => !item.gaps.includes('ALERTS_UNAVAILABLE'));
  const ids = new Set(available.flatMap(item => item.alertIds ?? []));
  const fallback = available.filter(item => !item.alertIds).reduce((sum, item) => sum + item.unresolvedAlerts, 0);
  return {
    total: items.length,
    abnormal: items.filter(item => ['abnormal', 'unavailable'].includes(runState(item))).length,
    unavailable: items.filter(item => runState(item) === 'unavailable').length,
    fresh: items.filter(item => freshness(item) === 'fresh').length,
    collection: items.filter(collectionRisk).length,
    alerts: ids.size + fallback,
    alertsIncomplete: items.some(item => item.alertsTruncated || item.gaps.includes('ALERTS_TRUNCATED') || !item.alertIds),
    alertsUnavailable: items.some(item => item.gaps.includes('ALERTS_UNAVAILABLE')),
  };
}
export function safeDashboardReturn(raw: string | null): string | null {
  if (!raw) return null;
  try { const url = new URL(raw, location.origin); return url.origin === location.origin && url.pathname === '/dashboard' ? url.pathname + url.search + url.hash : null; } catch { return null; }
}
export function returnToDashboard(): boolean {
  const target = safeDashboardReturn(new URL(location.href).searchParams.get('returnTo'));
  if (!target) return false;
  location.assign(target); return true;
}
