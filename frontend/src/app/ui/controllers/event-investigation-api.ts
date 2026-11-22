import { authFetch } from '../../../api/index.js';
import type { EventInvestigationResponse } from '../../../api/generated/public-api.ts';
import { metricDisplayName } from '../components/metric-display.js';
import { workspaceReturnTo } from '../workbench-routing.ts';

export interface QueueEvent {
  id: string | number;
  title: string;
  severity: string;
  status: string;
  source_type?: string;
  instance_name?: string | null;
  created_at: string;
}
export type LinkedInvestigation = NonNullable<EventInvestigationResponse['investigation']>;
export type LinkedInvestigationState = LinkedInvestigation['state'];
export const linkedInvestigationLabels: Record<LinkedInvestigationState, string> = {
  not_started: '尚未开始', running: '正在调查', completed: '已完成', insufficient: '证据不足', failed: '执行未完成',
};
export const eventStatusLabels: Record<string, string> = {
  open: '待处理', investigating: '处理中', handled: '已处理', resolved: '已解决', closed: '已关闭',
};
export function readEventId(value: string | number | null): number {
  if (!/^[1-9]\d*$/.test(String(value))) return 0;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : 0;
}
export function eventDisplayTitle(event: QueueEvent) {
  const metric = event.source_type === 'template-trigger' ? /^模板事件：([a-z][a-z0-9_.]*)$/.exec(event.title)?.[1] : undefined;
  if (!metric) return event.title;
  const label = metricDisplayName(metric);
  return label === metric ? event.title : `${label}阈值事件`;
}
export function eventDetailUrl(id: number, origin?: string) {
  const query = new URLSearchParams({view:'aggregate', eventId:String(id)});
  const returnTo = origin && workspaceReturnTo(origin);
  if (returnTo) query.set('returnTo', returnTo);
  return '/events?' + query;
}
export class EventReadError extends Error {
  constructor(readonly status: number) { super('EVENT_READ_FAILED'); }
}
export const eventReadDenied = (error: unknown) =>
  error instanceof EventReadError && [401,403,404].includes(error.status);
async function readJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await authFetch(path, {signal});
  if (!res.ok) throw new EventReadError(res.status);
  return res.json();
}
function isEvent(value: unknown): value is QueueEvent {
  if (typeof value !== 'object' || !value) return false;
  const event = value as QueueEvent;
  return !!readEventId(event.id) && typeof event.title === 'string' && typeof event.status === 'string' && typeof event.created_at === 'string';
}
export async function readQueue(page: number, size: number, query: string, signal?: AbortSignal) {
  const exact = readEventId(query.replace(/^#\s*/, ''));
  if (exact) {
    try {
      const event = await readJson(`/api/alerts/events/${exact}`, signal);
      if (!isEvent(event) || readEventId(event.id) !== exact) throw new EventReadError(502);
      return {items:[event], more:false};
    } catch (error) {
      if (error instanceof EventReadError && error.status === 404) return {items:[],more:false};
      throw error;
    }
  }
  const params = new URLSearchParams({limit:String(size + 1),offset:String(page * size)});
  if (query) params.set('keyword', query);
  const path = '/api/alerts/events';
  const result = await readJson(`${path}?${params}`, signal);
  const items = Array.isArray(result) ? result : (result as {items?:unknown} | null)?.items;
  if (!Array.isArray(items) || !items.every(isEvent)) throw new EventReadError(502);
  return {items:items.slice(0, size),more:items.length > size};
}
function isLinked(value: unknown): value is LinkedInvestigation | null {
  if (value === null) return true;
  if (typeof value !== 'object' || !value) return false;
  const link = value as LinkedInvestigation;
  return typeof link.id === 'string' && !!link.id && typeof link.title === 'string'
    && Object.hasOwn(linkedInvestigationLabels, link.state)
    && (link.conclusion === null || typeof link.conclusion === 'string')
    && (link.recommendation === null || typeof link.recommendation === 'string');
}
export async function readEventInvestigation(eventId: number, signal?: AbortSignal) {
  const result = await readJson(`/api/alerts/events/${eventId}/investigation`, signal) as {investigation?: unknown};
  if (!isLinked(result?.investigation)) throw new EventReadError(502);
  return result.investigation;
}
export async function readEventInvestigations(ids: number[], signal?: AbortSignal) {
  if (!ids.length) return new Map<number, LinkedInvestigation | null>();
  const params = new URLSearchParams({ids:ids.join(',')});
  const result = await readJson('/api/alerts/events/investigations?' + params, signal) as {items?: unknown};
  if (!Array.isArray(result?.items)) throw new EventReadError(502);
  const entries = new Map<number, LinkedInvestigation | null>();
  for (const row of result.items) {
    if (!row || !ids.includes(row.eventId) || entries.has(row.eventId) || !isLinked(row.investigation)) throw new EventReadError(502);
    entries.set(row.eventId,row.investigation);
  }
  return entries;
}
