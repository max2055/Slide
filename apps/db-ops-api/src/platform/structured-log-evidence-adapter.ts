import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from '../security/log-redaction.js';

export interface PlatformLogInput {
  component: string; eventType: string; status: 'ok' | 'failed' | 'unknown';
  durationMs?: number; errorCode?: string; correlationId?: string; traceId?: string;
  releaseId?: string;
}
interface PlatformLogEntry extends PlatformLogInput { timestamp: string; level: 'info' | 'error' | 'warn'; }
const HOUR = 3_600_000;
const label = (value: string) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);

export class StructuredLogEvidenceAdapter {
  private entries: PlatformLogEntry[] = [];
  private droppedAt: number | null = null;
  private readonly startedAt: number;
  constructor(private readonly now: () => number = Date.now, private readonly capacity = 10_000) { this.startedAt = now(); }

  record(input: PlatformLogInput): void {
    if (!label(input.component) || !label(input.eventType) || !['ok', 'failed', 'unknown'].includes(input.status)
      || (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 0))) throw new Error('PLATFORM_LOG_INVALID');
    const safe = (value: string | undefined) => value && label(value) ? redactSensitiveText(value) : undefined;
    const entry: PlatformLogEntry = {
      timestamp: new Date(this.now()).toISOString(), level: input.status === 'failed' ? 'error' : input.status === 'unknown' ? 'warn' : 'info',
      component: input.component, eventType: input.eventType, status: input.status,
      durationMs: input.durationMs, errorCode: safe(input.errorCode), correlationId: safe(input.correlationId) ?? randomUUID(),
      traceId: safe(input.traceId), releaseId: safe(input.releaseId),
    };
    this.entries = this.entries.filter(entry => Date.parse(entry.timestamp) >= this.now() - HOUR);
    this.entries.push(entry);
    if (this.entries.length > this.capacity) { this.droppedAt = this.now(); this.entries.splice(0, this.entries.length - this.capacity); }
  }

  query(options: { from?: string; to?: string; component?: string }) {
    const now = this.now(); const to = options.to ? Date.parse(options.to) : now; const from = options.from ? Date.parse(options.from) : to - 300_000;
    if (!Number.isFinite(from) || !Number.isFinite(to) || (options.component !== undefined && !label(options.component))) throw new Error('PLATFORM_LOG_QUERY_INVALID');
    if (from > to || to > now || from < now - HOUR || to - from > HOUR) throw new Error('PLATFORM_LOG_WINDOW_INVALID');
    const rows = this.entries.filter(entry => Date.parse(entry.timestamp) >= from && Date.parse(entry.timestamp) <= to && (!options.component || entry.component === options.component));
    const groups = new Map<string, { component: string; eventType: string; errorCode?: string; count: number; failures: number; durationMs: number; lastObservedAt: string; correlationIds: string[] }>();
    let omittedGroups = false;
    for (const row of rows) {
      const key = JSON.stringify([row.component, row.eventType, row.errorCode ?? null]);
      if (!groups.has(key) && groups.size >= 100) { omittedGroups = true; continue; }
      const group = groups.get(key) ?? { component: row.component, eventType: row.eventType, errorCode: row.errorCode, count: 0, failures: 0, durationMs: 0, lastObservedAt: row.timestamp, correlationIds: [] };
      group.count++; group.failures += Number(row.status === 'failed'); group.durationMs += row.durationMs ?? 0; group.lastObservedAt = row.timestamp;
      if (group.correlationIds.length < 10 && row.correlationId && !group.correlationIds.includes(row.correlationId)) group.correlationIds.push(row.correlationId);
      groups.set(key, group);
    }
    const gaps: string[] = [];
    if (omittedGroups) gaps.push('LOG_GROUPS_TRUNCATED');
    if (!rows.length) gaps.push('LOG_EVIDENCE_MISSING');
    if (from < this.startedAt) gaps.push('LOG_WINDOW_PRECEDES_PROCESS');
    if (this.droppedAt !== null && this.droppedAt >= from) gaps.push('LOG_BUFFER_TRUNCATED');
    if (rows.some(row => row.status === 'unknown')) gaps.push('LOG_STATUS_UNKNOWN');
    if (rows.length && now - Date.parse(rows.at(-1)!.timestamp) > 300_000) gaps.push('LOG_EVIDENCE_STALE');
    return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), from: new Date(from).toISOString(), to: new Date(to).toISOString(),
      retentionSeconds: 3600, persistence: 'process-local', quality: !rows.length || gaps.includes('LOG_EVIDENCE_STALE') ? 'unknown' : gaps.length ? 'degraded' : 'good',
      groups: [...groups.values()], gaps };
  }
}

export const platformLogs = new StructuredLogEvidenceAdapter();
