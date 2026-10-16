import type { Pool, RowDataPacket } from 'mysql2/promise';
import { refKey } from '../policy/model.js';
import { assetCollectionEnabled } from './effective-state.js';
import { configurationInventory } from './inventory.js';
import { metricCollectionEnabled } from '../scheduler/lifecycle.js';
import type { ConfigurationReader } from './status.js';

export function configurationReader(pool: () => Pool): ConfigurationReader {
  return { inventory: configurationInventory, async evidence(ref, revision) {
    const connection = pool();
    const asset_enabled = await assetCollectionEnabled(connection, ref);
    const [jobs] = await connection.execute<RowDataPacket[]>(`SELECT j.state FROM metric_schedule s
      JOIN workflow_jobs j ON j.id = s.job_id WHERE s.resource_key = ? AND s.revision = ?`, [refKey(ref), revision]);
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT COUNT(DISTINCT r.series_hash) AS total,
      COUNT(DISTINCT CASE WHEN r.read_mode = 'semantic' AND r.source = 'semantic' AND r.published_revision = ? AND r.applied_revision = ?
        AND p.generation = r.generation AND JSON_EXTRACT(o.payload, '$.versions.config_revision') = r.published_revision THEN r.series_hash END) AS applied,
      MAX(r.generation) AS generation,
      MAX(CASE WHEN r.read_mode = 'semantic' AND r.published_revision = ? AND r.applied_revision = ?
        AND p.generation = r.generation AND JSON_EXTRACT(o.payload, '$.versions.config_revision') = ? THEN p.observed_at END) AS observed_at
      FROM metric_rollout r LEFT JOIN metric_publications p ON p.series_hash = r.series_hash
      LEFT JOIN metric_observations o ON o.id = p.observation_id
      WHERE r.resource_type = ? AND r.resource_id = ? AND r.source <> 'retired'`, [revision,revision,revision,revision,revision,ref.type,String(ref.id)]);
    const row = rows[0], observed = row?.observed_at ? new Date(row.observed_at).toISOString() : null;
    const [sources] = await connection.execute<RowDataPacket[]>('SELECT phase FROM metric_rollout_resources WHERE resource_key = ?', [refKey(ref)]);
    const [checks]=await connection.execute<RowDataPacket[]>('SELECT payload FROM metric_source_checks WHERE resource_key=? AND revision=?',[refKey(ref),revision]);
    const validation=checks[0]?(typeof checks[0].payload==='string'?JSON.parse(checks[0].payload):checks[0].payload):null;
    const sourceFailed=validation?.checks?.some((c:{state:string})=>c.state==='failed');
    return { asset_enabled, global_enabled: metricCollectionEnabled(process.env.METRICS_COLLECTION_ENABLED), in_flight: jobs[0]?.state === 'running',
      formal: { state: sourceFailed ? 'failed' : observed && Number(row.applied) === Number(row.total) ? 'available' : sources[0]?.phase === 'shadow' ? 'validating' : 'pending',
        last_observed_at: observed, generation: row?.generation == null ? null : Number(row.generation) } };
  } };
}
