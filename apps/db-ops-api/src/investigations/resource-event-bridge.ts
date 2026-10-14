import type { ResourceRef } from '../resources/types.js';
import type { DatabaseAlertSource } from './alert-bridge.js';
import { InvestigationStoreError } from './store.js';

/** Only persisted resource columns determine authority; tags never grant it. */
export function alertResource(alert: DatabaseAlertSource): ResourceRef {
  const refs = ([['instance', alert.instance_id], ['server', alert.server_id], ['network_device', alert.network_device_id]] as const)
    .filter(([, id]) => id !== null && id !== undefined);
  if (refs.length !== 1 || !Number.isSafeInteger(refs[0][1]) || refs[0][1]! <= 0 || refs[0][1]! > 4_294_967_295)
    throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
  return { type: refs[0][0], id: refs[0][1]! };
}
const instant = (value: unknown): string | undefined => {
  if (!(typeof value === 'string' || value instanceof Date)) return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};
export function alertObservation(alert: DatabaseAlertSource) {
  let tags: Record<string, any> = {};
  try { const parsed = typeof alert.tags === 'string' ? JSON.parse(alert.tags) : alert.tags;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) tags = parsed;
  } catch { /* Historical malformed metadata remains unknown. */ }
  const occurredAt = instant(alert.created_at);
  if (!occurredAt) throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
  const suppliedTime = tags.observed_at ?? tags.collected_at;
  const rawTime = instant(suppliedTime);
  const observedAt = rawTime && rawTime <= occurredAt ? rawTime : undefined;
  const from = instant(tags.observed_from), to = instant(tags.observed_to);
  const validWindow = from && to && from <= to && to <= occurredAt
    && (suppliedTime == null || suppliedTime === '' || observedAt && from <= observedAt && observedAt <= to);
  const numeric = alert.metric_value == null || alert.metric_value === '' ? null : Number(alert.metric_value);
  const value = numeric !== null && Number.isFinite(numeric) ? numeric : null;
  const quality = (observedAt || validWindow) && value !== null && ['good','partial','unknown','error','unsupported'].includes(tags.quality)
    ? tags.quality as string : 'unknown';
  return { metric: alert.metric_name, value, ...(Number.isSafeInteger(tags.rule_window_seconds) && tags.rule_window_seconds >= 0 ? {ruleWindowSeconds:tags.rule_window_seconds} : {}), threshold: alert.threshold_value ?? null,
    observedAt: observedAt ?? null, from: validWindow ? from : observedAt ?? null,
    to: validWindow ? to : observedAt ?? null, quality,
    dimensions: tags.dimensions && typeof tags.dimensions === 'object' ? tags.dimensions : {},
    availability: alert.metric_name === 'unreachable' || alert.metric_name === 'network.device.status'
      ? quality === 'good' ? 'observed_status' : 'unknown' : 'not_observed' };
}
export function alertInvestigationInput(alert: DatabaseAlertSource) {
  const resource = alertResource(alert), observation = alertObservation(alert);
  const subject = { kind: 'resource' as const, resource };
  const context = { subject, ...(observation.from && observation.to ? { from: observation.from, to: observation.to } : {}) };
  const facts = JSON.stringify({ resource, observation });
  return { resource, observation, context, facts,
    message: `${alert.title}\n${alert.message}\n持久告警观测：${facts}\n缺指标、未知或过期观测不能证明正常或设备宕机；只读调查，根因待验证。`.slice(0, 2_000) };
}
