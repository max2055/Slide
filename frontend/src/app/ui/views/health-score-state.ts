import { runState, freshness, type OverviewItem } from './dashboard-model.js';

export interface HealthScoreInstanceState {
  health_status?: string | null;
  hasCredential?: boolean;
  status?: string | null;
  last_health_check_at?: unknown;
}

export const observationAgeLimit = 300_000;
export function observationTimeState(at: unknown, now = Date.now()): 'fresh' | 'stale' | 'missing' | 'future' {
  const timestamp = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(timestamp)) return 'missing';
  if (timestamp > now) return 'future';
  return now - timestamp > observationAgeLimit ? 'stale' : 'fresh';
}
export function evidenceTimeState(at: unknown, now = Date.now()): string {
  return ({ missing: '时间未知', future: '时间异常', stale: '已过期（超过5分钟）', fresh: '新鲜（5分钟内）' })[observationTimeState(at, now)];
}
export function evidenceTime(at: unknown): string {
  return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString('zh-CN') : '未知';
}

/** Current health uses the same formal observations as the resource overview. */
export type CurrentHealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown' | 'error';
export function currentHealthStatus(instance: HealthScoreInstanceState | null | undefined, evidence?: OverviewItem | null, now = Date.now()): CurrentHealthStatus {
  if (!instance || instance.hasCredential !== true || ['inactive', 'paused', 'disabled', 'pending_credentials'].includes(instance.status ?? '')) return 'unknown';
  if (instance.status === 'error') return 'error';
  if (!evidence || !Array.isArray(evidence.gaps) || !Number.isFinite(evidence.unresolvedAlerts)) return 'unknown';
  const state = runState(evidence, now);
  if (state === 'abnormal' && (['critical', 'error'].includes(evidence.status) || evidence.alertSeverity === 'critical')) return 'critical';
  return ({ normal: 'healthy', abnormal: 'warning', unavailable: 'critical', unknown: 'unknown' } as const)[state];
}

/** Stored scores become current only with fresh, complete, matching checks. */
export function resolveHealthScoreState(
  instance: HealthScoreInstanceState | null | undefined,
  latestScore: number | null | undefined,
  evidence?: OverviewItem | null,
  now = Date.now(),
) {
  const status = currentHealthStatus(instance, evidence, now);
  const ready = !!evidence && Array.isArray(evidence.gaps) && evidence.quality === 'good' && freshness(evidence, now) === 'fresh'
    && !evidence.gaps.some(gap => ['OBSERVATIONS_FUTURE', 'OBSERVATIONS_TRUNCATED', 'ALERTS_UNAVAILABLE', 'ALERTS_TRUNCATED'].includes(gap))
    && ['healthy', 'warning', 'critical'].includes(status)
    && status === instance?.health_status
    && observationTimeState(instance?.last_health_check_at, now) === 'fresh';
  return { ready, score: ready && typeof latestScore === 'number' && Number.isFinite(latestScore) && latestScore >= 0 && latestScore <= 100 ? latestScore : null, status };
}
