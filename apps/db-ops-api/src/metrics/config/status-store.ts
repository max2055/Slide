import { NormalizedObservationSchema } from '../../contracts/metrics/index.js';
import { legacyConfigurationMigration } from './migration.js';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { refKey } from '../policy/model.js';
import { assetCollectionEnabled } from './effective-state.js';
import { configurationInventory } from './inventory.js';
import { metricCollectionEnabled } from '../scheduler/lifecycle.js';
import { decodeBindingPayload } from '../bindings/persistence-codec.js';
import type { ConfigurationReader } from './status.js';

export function configurationReader(pool: () => Pool): ConfigurationReader {
  return { migration: ref => legacyConfigurationMigration(pool(),ref), inventory: configurationInventory,
    async template(ref) {
      const [rows] = await pool().execute<RowDataPacket[]>('SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
      if (!rows[0]) return null;
      const decoded = decodeBindingPayload(rows[0].payload);
      if (decoded.kind !== 'template_pending') return null;
      const plan = decoded.pending.plan;
      const metrics: Array<{ metric: { id: string; semantic_version: string }; enabled: boolean;
        decision: 'collect' | 'derive' | 'disabled' | 'unsupported' | 'capability_unknown';
        capability: 'supported' | 'unsupported' | 'unknown' }> = [];
      for (const release of plan.releases) for (const step of release.steps) for (const item of step.items) {
        metrics.push({ metric: item.canonical_metric, enabled: true,
          decision: item.capability.status === 'unsupported' ? 'unsupported'
            : item.capability.status === 'unknown' ? 'capability_unknown' : 'collect',
          capability: item.capability.status });
      }
      for (const excluded of plan.excluded) {
        metrics.push({ metric: excluded.metric, enabled: false, decision: excluded.decision,
          capability: excluded.decision === 'unsupported' ? 'unsupported'
            : excluded.decision === 'capability_unknown' ? 'unknown' : 'supported' });
      }
      return {
        revision: decoded.pending.target_revision,
        published_at: decoded.published_at,
        application: { status: decoded.application.status, applied_revision: decoded.application.applied_revision },
        settings: plan.settings,
        enabled_overridden: Object.hasOwn(decoded.binding.overrides, 'enabled'),
        metrics,
      };
    },
    async evidence(ref, revision) {
    const connection = pool();
    const asset_enabled = await assetCollectionEnabled(connection, ref);
    // Job IDs are opaque, exact identifiers. Existing tables can have different
    // collations; binary comparison avoids both SQL 1267 and case/padding aliases.
    const [jobs] = await connection.execute<RowDataPacket[]>(`SELECT j.state FROM metric_schedule s
      JOIN workflow_jobs j ON CAST(j.id AS BINARY) = CAST(s.job_id AS BINARY)
      WHERE s.resource_key = ? AND s.revision = ?`, [refKey(ref), revision]);
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
    // Template normal writes already commit exact source-check ids. Read those through
    // this existing configuration-status entry; do not infer semantic rollout publication.
    if (Array.isArray(validation?.sample_ids) && validation.sample_ids.length > 0 && validation.sample_ids.length <= 4096
      && validation.sample_ids.every((id:unknown) => typeof id === 'string')) {
      const [bindings] = await connection.execute<RowDataPacket[]>('SELECT payload FROM metric_policy_bindings WHERE resource_key=?',[refKey(ref)]);
      const binding = bindings[0] ? decodeBindingPayload(bindings[0].payload) : null;
      if (binding?.kind === 'template_pending' && binding.application.status === 'applied'
        && binding.application.applied_revision === revision && binding.binding.revision === revision) {
        const [formal] = await connection.execute<RowDataPacket[]>(`SELECT payload FROM metric_observations
          WHERE stage='normalized' AND id IN (${validation.sample_ids.map(()=>'?').join(',')})`,validation.sample_ids);
        const samples = formal.map(record => NormalizedObservationSchema.safeParse(typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload));
        if (samples.length === validation.sample_ids.length && samples.every(s => s.success
          && s.data.resource_type === ref.type && s.data.resource_id === String(ref.id) && s.data.versions.config_revision === revision)) {
          const latest = samples.flatMap(s=>s.success ? [s.data.observed_at] : []).sort().at(-1)!;
          return {asset_enabled,global_enabled:metricCollectionEnabled(process.env.METRICS_COLLECTION_ENABLED),in_flight:jobs[0]?.state==='running',
            formal:{state:sourceFailed?'failed' as const:'available' as const,last_observed_at:latest,generation:null}};
        }
      }
    }
    return { asset_enabled, global_enabled: metricCollectionEnabled(process.env.METRICS_COLLECTION_ENABLED), in_flight: jobs[0]?.state === 'running',
      formal: { state: sourceFailed ? 'failed' : observed && Number(row.applied) === Number(row.total) ? 'available' : sources[0]?.phase === 'shadow' ? 'validating' : 'pending',
        last_observed_at: observed, generation: row?.generation == null ? null : Number(row.generation) } };
  } };
}
