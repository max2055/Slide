import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { MetricDefinition, NormalizedObservation } from '../../contracts/metrics/index.js';
import type { Ref } from '../policy/model.js';
import { stable } from '../packages/model.js';
import { migrateReference } from '../consumers/migration.js';

/** Evidence is private server output and must describe exactly the current committed snapshot. */
export function validSourceSnapshot(captured: any, ref: Ref, samples: NormalizedObservation[]): boolean {
  if (!captured || captured.mode !== 'same_actual_source_snapshot' || captured.remote_requests_added !== 0
    || stable(captured.resource) !== stable(ref) || !Array.isArray(captured.sample_ids)
    || !Array.isArray(captured.checks) || !Array.isArray(captured.semantic_differences)
    || !Number.isFinite(Date.parse(captured.measured_at))) return false;
  return samples.length > 0 && samples.every(o => {
    if (captured.revision !== o.versions.config_revision || !captured.sample_ids.includes(o.id)) return false;
    const checks = captured.checks.filter((c: any) => c.sample_id === o.id);
    if (checks.length) return checks.every((c: any) => c.state === 'passed' && c.metric_id === o.metric.id
      && c.unit === o.unit && stable(c.dimensions) === stable(o.dimensions));
    return captured.semantic_differences.some((d: any) => d.sample_id === o.id && d.metric_id === o.metric.id
      && typeof d.reason === 'string' && d.reason.length > 0);
  });
}

/** Historical labels alone cannot establish immutable implementation, quality, unit or epoch identity.
 * Never convert such records into accepted samples, or fabricate a successful shadow comparison. */
export async function sourceHistory(c: PoolConnection, ref: Ref, engine: string, samples: NormalizedObservation[], catalog: MetricDefinition[]) {
  const [rows] = ref.type === 'instance'
    ? await c.execute<RowDataPacket[]>('SELECT id,recorded_at AS observed_at FROM metrics_history WHERE instance_id=? ORDER BY id DESC LIMIT 1',[ref.id])
    : ref.type === 'server'
      ? await c.execute<RowDataPacket[]>('SELECT id,recorded_at AS observed_at FROM server_metrics WHERE server_id=? ORDER BY id DESC LIMIT 1',[ref.id])
      : await c.execute<RowDataPacket[]>('SELECT id,observed_at FROM network_device_observations WHERE device_id=? ORDER BY id DESC LIMIT 1',[ref.id]);
  const historical = rows[0];
  const [validations]=await c.execute<RowDataPacket[]>('SELECT payload FROM metric_source_checks WHERE resource_key=? AND revision=?',
    [`${ref.type}:${ref.id}`,samples[0]?.versions.config_revision??0]);
  const captured=validations[0]?(typeof validations[0].payload==='string'?JSON.parse(validations[0].payload):validations[0].payload):null;
  const comparisons=captured?.checks??[];
  const shadowFailed=!validSourceSnapshot(captured,ref,samples) || comparisons.some((check:{state:string})=>check.state!=='passed');
  const mappings = Object.fromEntries(['cpu_usage','memory_usage','disk_usage','connections','qps','tps','slow_queries','health_score',
    'uptime','load_1min','load_5min','load_15min','memory_used','memory_total','swap_usage','open_files','buffer_pool_hit_rate','table_open_cache_hit_rate',
    'key_blocks_usage','idx_scan_ratio','dead_tuples','cache_hit_ratio','vacuum_count','autovacuum_count','replication_lag_seconds',
    'device_uptime_seconds','interface_in_bps','interface_out_bps'].map(id=>[id,migrateReference(ref,engine,id)]));
  return {kind:historical?'historical_source_migration':'new_source_initialization',history_preserved:true,
    historical_reference:historical?{table:ref.type==='instance'?'metrics_history':ref.type==='server'?'server_metrics':'network_device_observations',
      last_id:String(historical.id),observed_at:new Date(historical.observed_at).toISOString()}:null,
    legacy_comparison:{state:shadowFailed?'failed':comparisons.length?'passed':'not_applicable',captured_snapshot:captured,reason:historical
      ? 'Equivalent gauge interpretations are replayed against the actual fixed source response and compared by value, unit, dimensions and quality. Historical rows remain unchanged; unlike formulas and untrustworthy counter epochs are explicit semantic differences, not equivalent samples.'
      : 'No historical measurements exist for this resource. Initialize only from actual raw lineage and successful attempts.',
      metrics:samples.map(o=>({metric:o.metric,definition:catalog.find(d=>d.id===o.metric.id&&d.semantic_version===o.metric.semantic_version)?.meaning,
        state:'direct_semantic_validation',sample_id:o.id,quality:o.quality,production:o.production,
        historical_identity:'unproven',history_converted:false})),reference_mapping:mappings}};
}
