import type { Pool } from 'mysql2/promise';
import { productionAccess } from '../config/access.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { MetricScheduler } from './service.js';
import { MysqlScheduleStore } from './store.js';
import { MetricSchedulerLifecycle, metricCollectionEnabled } from './lifecycle.js';

export function createMetricSchedulerLifecycle(pool: Pool) {
  const packages = createConfigurationRegistry();
  return new MetricSchedulerLifecycle(new MetricScheduler(new MysqlScheduleStore(pool, packages, 'production'), packages, productionAccess), {
    enabled: metricCollectionEnabled(process.env.METRICS_V2_COLLECTION_ENABLED),
    report: event => { if (event.code !== 'METRIC_TICK_OK' || event.queued) console.info('[MetricsV2]', JSON.stringify(event)); },
  });
}

/** initializeControlPlane runs migrations first; enabled collection must fail closed on incomplete schema. */
export async function assertMetricSchedulerSchema(pool: Pool): Promise<void> {
  try {
    await pool.query('SELECT id, payload FROM metric_v2_observations LIMIT 0');
    await pool.query('SELECT resource_key, payload FROM metric_v2_policy_bindings LIMIT 0');
    await pool.query('SELECT resource_key, revision, states FROM metric_v2_schedule LIMIT 0');
    await pool.query('SELECT series_hash, generation, published_revision, applied_revision, resource_type, resource_id FROM metric_v2_rollout LIMIT 0');
    await pool.query('SELECT observation_id FROM metric_v2_publications LIMIT 0');
  } catch { throw new Error('METRIC_SCHEMA_NOT_READY'); }
}
