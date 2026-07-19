import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import { MysqlCollectionScheduleStore, dueStoredMetricIds } from '../../apps/db-ops-api/src/collection-scheduler.js';

if (!await dbConnection.initialize()) throw new Error('qualification database connection failed');
const pool = dbConnection.getPool();
if (!pool) throw new Error('qualification database pool unavailable');
const store = new MysqlCollectionScheduleStore(() => pool as any);
const resourceId = 900_000 + (process.pid % 10_000);
const providerId = `qualification-${Date.now()}`;
const fast = { id: 'qualification_fast', default_interval: 30 };
const slow = { id: 'qualification_slow', default_interval: 120 };
const now = Date.now();

try {
  const firstDue = await dueStoredMetricIds(store, 'instance', resourceId, providerId, [fast, slow], now);
  if (firstDue.length !== 2) throw new Error('new metrics were not immediately due');
  await store.record('instance', resourceId, providerId, fast, now, true);
  await store.record('instance', resourceId, providerId, slow, now, true);
  const afterSuccess = await dueStoredMetricIds(store, 'instance', resourceId, providerId, [fast, slow], now + 31_000);
  if (afterSuccess.length !== 1 || afterSuccess[0] !== fast.id) throw new Error('per-metric interval was not persisted');
  await store.record('instance', resourceId, providerId, fast, now + 31_000, false);
  const afterFailure = await dueStoredMetricIds(store, 'instance', resourceId, providerId, [fast, slow], now + 33_000);
  if (!afterFailure.includes(fast.id) || afterFailure.includes(slow.id)) throw new Error('failed metric was not immediately retryable');
  const entries = await store.list('instance', resourceId, providerId);
  const failed = entries.find((entry) => entry.metricId === fast.id);
  const preserved = entries.find((entry) => entry.metricId === slow.id);
  if (failed?.lastResult !== 'failure' || !failed.lastSuccessMs || preserved?.lastResult !== 'success' || !preserved.lastSuccessMs) {
    throw new Error('collection schedule database readback was incomplete');
  }
  console.log(`collection schedule invariant valid: resource=${resourceId} fast=failure-retry slow=success-deferred`);
} finally {
  await pool.execute('DELETE FROM collection_schedule_state WHERE resource_type = ? AND resource_id = ? AND provider_id = ?', ['instance', resourceId, providerId]);
  await dbConnection.close();
}
