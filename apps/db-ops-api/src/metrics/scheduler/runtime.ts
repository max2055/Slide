import type { Pool } from 'mysql2/promise';
import { productionAccess } from '../config/access.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { MetricScheduler } from './service.js';
import { MysqlScheduleStore } from './store.js';
import { MetricSchedulerLifecycle, metricCollectionEnabled } from './lifecycle.js';
import { MetricFormalization } from '../rollout/formalization.js';
import { actorContextService } from '../../auth/actor-context.js';
import { productionCollectNowAuthorizer } from '../templates/collect-now.js';

export function createMetricSchedulerLifecycle(pool: Pool) {
  const packages = createConfigurationRegistry();
  return new MetricSchedulerLifecycle(new MetricScheduler(new MysqlScheduleStore(pool, packages, 'production'), packages, productionAccess,
    Date.now, undefined, new MetricFormalization(pool, packages), productionCollectNowAuthorizer(actorContextService)), {
    enabled: metricCollectionEnabled(process.env.METRICS_COLLECTION_ENABLED),
    report: event => { if (event.code !== 'METRIC_TICK_OK' || event.queued) console.info('[Metrics]', JSON.stringify(event)); },
  });
}

/**
 * Columns read/written by the scheduler, its formalization pass and collection
 * jobs. LIMIT 0 checks the live schema even if migration history is intact.
 * Keep explicit columns: SELECT * would accept a partially restored table.
 */
const schemaProbes = [
  'SELECT id, series_hash, stage, observed_at, stored_at, valid_value, payload, payload_hash, evidence_expires_at FROM metric_observations LIMIT 0',
  'SELECT id, payload, stored_at FROM metric_attempts LIMIT 0',
  'SELECT resource_hash, payload FROM metric_inventory LIMIT 0',
  'SELECT resource_key, group_id, payload, capabilities, item_attempt_ids FROM metric_policy_bindings LIMIT 0',
  'SELECT resource_key, metric_key, history_ms, trends_ms FROM metric_item_retention LIMIT 0',
  'SELECT id, payload FROM metric_policy_groups LIMIT 0',
  'SELECT id FROM metric_policy_lock LIMIT 0',
  'SELECT id, target, payload FROM metric_policy_audit LIMIT 0',
  'SELECT resource_key, revision, next_due_ms, last_end_ms, job_id, states, cadence FROM metric_schedule LIMIT 0',
  'SELECT resource_key, job_id, revision, code, uncertain, duration_ms, logical_reads FROM metric_schedule_events LIMIT 0',
  'SELECT id, resource_key, caller_key, actor_id, session_version, revision, resolution_identity, intent_digest, job_id, state, outcome, error_code, samples, attempts, created_at, started_at, finished_at FROM metric_collect_requests LIMIT 0',
  'SELECT series_hash, source, generation, read_mode, package_pin, published_revision, applied_revision, latest_payload, resource_type, resource_id FROM metric_rollout LIMIT 0',
  'SELECT resource_key, resource_type, resource_id, phase, revision, generation, gate_json, actor_id, request_id FROM metric_rollout_resources LIMIT 0',
  'SELECT observation_id, series_hash, generation, observed_at FROM metric_publications LIMIT 0',
  'SELECT resource_key, revision, payload, checked_at FROM metric_source_checks LIMIT 0',
  'SELECT resource_key, revision, generation, evidence FROM metric_source_acceptance LIMIT 0',
  'SELECT id, job_type, schema_version, payload, idempotency_key, state, attempts, max_attempts, available_at, lease_owner, lease_expires_at, fencing_token, last_error, completed_at FROM workflow_jobs LIMIT 0',
  'SELECT id, status, lifecycle_state FROM database_instances LIMIT 0',
  'SELECT id, collection_enabled FROM servers LIMIT 0',
  'SELECT id, collection_enabled FROM network_devices LIMIT 0',
  'SELECT device_id FROM network_device_credentials LIMIT 0',
  'SELECT id, instance_id, recorded_at FROM metrics_history LIMIT 0',
  'SELECT id, server_id, recorded_at FROM server_metrics LIMIT 0',
  'SELECT id, device_id, observed_at FROM network_device_observations LIMIT 0',
  'SELECT resource_key, template_id, rule_id, revision, payload FROM metric_discovery_states LIMIT 0',
  'SELECT resource_key, template_id, rule_id, payload, recorded_at FROM metric_discovery_audit LIMIT 0',
  'SELECT resource_key, config_revision, payload FROM metric_trigger_snapshots LIMIT 0',
  'SELECT identity_hash, resource_key, config_revision, rule_id, dimensions, payload, sample_watermark, source_watermarks FROM metric_trigger_heads LIMIT 0',
  'SELECT episode_id, identity_hash, resource_key, config_revision, event_id, alert_id, payload, snapshot FROM metric_trigger_episodes LIMIT 0',
  'SELECT identity_hash, sample_id, observed_at, payload FROM metric_trigger_inputs LIMIT 0',
  'SELECT id FROM alert_dependency_lock LIMIT 0',
  'SELECT payload FROM alert_dependencies LIMIT 0',
  'SELECT identity_hash, resource_key, payload FROM alert_dependency_decisions LIMIT 0',
];

/** initializeControlPlane runs migrations first; enabled collection must fail closed on incomplete schema. */
export async function assertMetricSchedulerSchema(pool: Pool): Promise<void> {
  try {
    for (const sql of schemaProbes) await pool.query(sql);
    // The singleton is runtime data required by every publication transaction.
    const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>('SELECT id FROM metric_policy_lock WHERE id = 1');
    if (rows.length !== 1) throw new Error('METRIC_POLICY_LOCK_MISSING');
  } catch { throw new Error('METRIC_SCHEMA_NOT_READY'); }
}
