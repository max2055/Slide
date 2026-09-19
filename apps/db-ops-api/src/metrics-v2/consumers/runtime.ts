import type { RowDataPacket } from 'mysql2/promise';
import { dbConnection } from '../../db-connection.js';
import { CollectionAttemptSchema } from '../../contracts/metrics-v2/index.js';
import { MysqlMetricStorage } from '../storage.js';
import { policyService } from '../policy/service.js';
import { refKey, rule } from '../policy/model.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { MetricConsumerService, type ConsumerStore } from './service.js';
const pool = () => { const p = dbConnection.getPool(); rule(p, 'METRIC_STORE_UNAVAILABLE', 503); return p; };
const decode = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v;
export const consumerStore: ConsumerStore = {
  queryWindow: (...args) => new MysqlMetricStorage(pool()).queryWindow(...args),
  inventory: (...args) => new MysqlMetricStorage(pool()).inventory(...args),
  async dimensions(ref, d, from, to) {
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT DISTINCT JSON_EXTRACT(payload, '$.dimensions') AS dimensions
      FROM metric_v2_observations WHERE stage = 'normalized' AND payload IS NOT NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.resource_type')) = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.resource_id')) = ?
      AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.metric.id')) = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.metric.semantic_version')) = ?
      AND observed_at >= ? AND observed_at < ? LIMIT 101`, [ref.type, String(ref.id), d.id, d.semantic_version,
      new Date(Date.parse(from) - 86400000).toISOString().slice(0, 23).replace('T', ' '), new Date(to).toISOString().slice(0, 23).replace('T', ' ')]);
    return rows.map(r => decode(r.dimensions));
  },
  async attempts(ref) {
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT payload FROM metric_v2_attempts
      WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.binding_id')) = ? ORDER BY stored_at DESC LIMIT 100`, [refKey(ref)]);
    return rows.map(r => CollectionAttemptSchema.parse(decode(r.payload)));
  },
};
export const metricConsumerService = new MetricConsumerService(policyService, createConfigurationRegistry(), consumerStore);
