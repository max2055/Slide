import type { RowDataPacket } from 'mysql2/promise';
import { dbConnection } from '../../db-connection.js';
import { CollectionAttemptSchema } from '../../contracts/metrics-v2/index.js';
import { MysqlFormalMetricStore } from '../rollout/formal-store.js';
import { policyService } from '../policy/service.js';
import { refKey, rule } from '../policy/model.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { MetricConsumerService, type ConsumerStore } from './service.js';
const pool = () => { const p = dbConnection.getPool(); rule(p, 'METRIC_STORE_UNAVAILABLE', 503); return p; };
const decode = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v;
export const consumerStore: ConsumerStore = {
  queryWindow: (...args) => new MysqlFormalMetricStore(pool()).queryWindow(...args),
  inventory: (...args) => new MysqlFormalMetricStore(pool()).inventory(...args),
  dimensions: (...args) => new MysqlFormalMetricStore(pool()).dimensions(...args),
  async attempts(ref) {
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT payload FROM metric_v2_attempts
      WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.binding_id')) = ? ORDER BY stored_at DESC LIMIT 100`, [refKey(ref)]);
    return rows.map(r => CollectionAttemptSchema.parse(decode(r.payload)));
  },
};
export const metricConsumerService = new MetricConsumerService(policyService, createConfigurationRegistry(), consumerStore);
