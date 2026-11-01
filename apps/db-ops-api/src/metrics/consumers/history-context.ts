import type { ConfigurationAt } from '../../contracts/metrics/configuration-history.js';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { TriggerResourceSnapshotSchema, type TriggerResourceSnapshot } from '../../contracts/metrics/triggers.js';
import { verifyTriggerSnapshot } from '../triggers/compile.js';
import type { Ref } from '../policy/model.js';
import { configuredRetention } from '../retention.js';

export interface HistoryContext {
  configurations?: ConfigurationAt[];
  snapshots: TriggerResourceSnapshot[];
  missing_revisions: number[];
  events: Array<{ event_id: number; rule_id: string; version: number; config_revision: number;
    from: string; to: string | null; unknown_segments: Array<{ from: string; to: string | null; reason: string }> }>;
  events_readable: boolean;
  retention: ReturnType<typeof configuredRetention> & { cleanup_enabled: boolean };
  sampling: { interval_ms: number; max_gap_ms: number; basis: 'explicit_history_assumption' };
}
export const historySampling = { interval_ms: 60000, max_gap_ms: 180000, basis: 'explicit_history_assumption' as const };
const decode = (v: unknown): any => typeof v === 'string' ? JSON.parse(v) : v;
/** Read only facts from existing producers; no current-rule backfill and no event writes. */
export async function readHistoryContext(pool: Pool, ref: Ref, from: string, to: string,
  revisions: number[], eventsReadable: boolean): Promise<HistoryContext> {
  const key = `${ref.type}:${ref.id}`, unique = [...new Set(revisions)];
  if (unique.length > 100) throw new Error('QUERY_LIMIT_EXCEEDED');
  const snapshots: TriggerResourceSnapshot[] = [];
  if (unique.length) {
    const [rows] = await pool.execute<RowDataPacket[]>(`SELECT payload FROM metric_trigger_snapshots
      WHERE resource_key=? AND config_revision IN (${unique.map(() => '?').join(',')})`, [key, ...unique]);
    for (const row of rows) {
      const snapshot = verifyTriggerSnapshot(TriggerResourceSnapshotSchema.parse(decode(row.payload)));
      if (`${snapshot.resource.type}:${snapshot.resource.id}` !== key || !unique.includes(snapshot.config_revision))
        throw new Error('HISTORY_SNAPSHOT_IDENTITY');
      snapshots.push(snapshot);
    }
  }
  const events: HistoryContext['events'] = [];
  if (eventsReadable) {
    const [rows] = await pool.execute<RowDataPacket[]>(`SELECT event_id,config_revision,payload FROM metric_trigger_episodes
      WHERE resource_key=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.opened_at')) < ?
      AND (JSON_EXTRACT(payload,'$.closed_at') = CAST('null' AS JSON)
        OR JSON_UNQUOTE(JSON_EXTRACT(payload,'$.closed_at')) > ?)
      ORDER BY event_id LIMIT 201`, [key, to, from]);
    if (rows.length > 200) throw new Error('QUERY_LIMIT_EXCEEDED');
    for (const row of rows) {
      const e = decode(row.payload);
      if (`${e.resource.type}:${e.resource.id}` !== key) throw new Error('HISTORY_EVENT_IDENTITY');
      events.push({ event_id: Number(row.event_id), config_revision: Number(row.config_revision),
        rule_id: e.rule_id, version: e.version, from: e.opened_at, to: e.closed_at, unknown_segments: e.unknown_segments });
    }
  }
  return { snapshots, missing_revisions: unique.filter(r => !snapshots.some(s => s.config_revision === r)),
    events, events_readable: eventsReadable, retention: { ...configuredRetention(), cleanup_enabled: process.env.METRICS_RETENTION_ENABLED === 'true' && process.env.METRICS_RETENTION_MODE === 'apply' },
    sampling: historySampling };
}
