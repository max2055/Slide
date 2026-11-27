import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { IdSchema } from '../../contracts/metrics/definitions.js';
import { ObservationRefSchema } from '../../contracts/metrics/observations.js';
import type { Ref } from '../policy/model.js';
import { configuredRetention, retentionSqlTime } from '../retention.js';

const MAX_OBSERVATIONS = 4096;
const MAX_DEPTH = 16;
const SampleIds = z.array(IdSchema).min(1).max(MAX_OBSERVATIONS);
const Lineage = z.array(ObservationRefSchema).min(1).max(MAX_OBSERVATIONS);
type ObservationRef = z.infer<typeof ObservationRefSchema>;
interface SourceRow extends RowDataPacket {
  id: string;
  stage: ObservationRef['stage'];
  retained: number;
  expired: number | null;
  lineage: unknown;
}
export type TriggerSourceAvailability = 'available' | 'expired' | 'unknown';
const refKey = (ref: ObservationRef) => `${ref.stage}:${ref.id}`;

/** Read only the retention and lineage metadata of the event resource. */
export async function readTriggerSourceAvailability(
  connection: Pick<PoolConnection, 'execute'>,
  resource: Ref,
  sampleIds: unknown,
  now = new Date(),
): Promise<TriggerSourceAvailability> {
  const samples = SampleIds.safeParse(sampleIds);
  if (!samples.success) return 'unknown';

  const { rawMs } = configuredRetention();
  const cutoff = retentionSqlTime(new Date(now.getTime() - rawMs));
  const roots = samples.data.map(id => ({ id, stage: 'normalized' as const }));
  const seen = new Set<string>();
  const lineage = new Map<string, ObservationRef[]>();
  const available = new Set<string>();
  let frontier: ObservationRef[] = roots;

  for (let depth = 0; depth <= MAX_DEPTH && frontier.length; depth++) {
    const refs = new Map(frontier.map(ref => [refKey(ref), ref]));
    for (const key of seen) refs.delete(key);
    if (!refs.size || seen.size + refs.size > MAX_OBSERVATIONS) break;
    for (const key of refs.keys()) seen.add(key);
    const ids = [...new Set([...refs.values()].map(ref => ref.id))];
    const [rows] = await connection.execute<SourceRow[]>(`
      SELECT id, stage, payload IS NOT NULL AS retained, JSON_EXTRACT(payload, '$.lineage') AS lineage,
        stage = 'raw' AND (tombstone->>'$.reason' = 'raw_retention_expired'
          OR evidence_expires_at <= ? OR stored_at <= ?) AS expired
      FROM metric_observations
      WHERE id IN (${ids.map(() => '?').join(',')})
        AND JSON_UNQUOTE(JSON_EXTRACT(COALESCE(payload, tombstone), '$.resource_type')) = ?
        AND JSON_UNQUOTE(JSON_EXTRACT(COALESCE(payload, tombstone), '$.resource_id')) = ?
    `, [retentionSqlTime(now), cutoff, ...ids, resource.type, String(resource.id)]);
    frontier = [];
    for (const row of rows) {
      const key = refKey(row);
      if (!refs.has(key)) continue;
      if (row.stage === 'raw') {
        if (row.expired) return 'expired';
        if (row.retained) available.add(key);
      } else {
        const sources = Lineage.safeParse(typeof row.lineage === 'string' ? JSON.parse(row.lineage) : row.lineage);
        if (!sources.success) continue;
        lineage.set(key, sources.data);
        frontier.push(...sources.data);
      }
    }
  }

  // Resolve from known raw leaves. A missing record or a cycle cannot prove availability.
  for (let depth = 0; depth < MAX_DEPTH && lineage.size; depth++) {
    for (const [key, sources] of lineage) {
      if (sources.every(source => available.has(refKey(source)))) {
        available.add(key);
        lineage.delete(key);
      }
    }
  }
  return roots.every(root => available.has(refKey(root))) ? 'available' : 'unknown';
}
