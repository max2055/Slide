import type { RowDataPacket } from 'mysql2/promise';
import { dbConnection } from '../../db-connection.js';
import { CollectionAttemptSchema } from '../../contracts/metrics/index.js';
import { MysqlFormalMetricStore } from '../rollout/formal-store.js';
import { policyService } from '../policy/service.js';
import { refKey, rule, type Ref } from '../policy/model.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { configurationInventory } from '../config/inventory.js';
import { MetricConsumerService, type ConsumerStore, type TemplateQueryPort } from './service.js';
import { decodeBindingPayload } from '../bindings/persistence-codec.js';
const pool = () => { const p = dbConnection.getPool(); rule(p, 'METRIC_STORE_UNAVAILABLE', 503); return p; };
const decode = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v;
export const consumerStore: ConsumerStore = {
  queryWindow: (...args) => new MysqlFormalMetricStore(pool()).queryWindow(...args),
  inventory: (type, id) => configurationInventory({ type, id: Number(id) }),
  latestCapacity: (...args) => new MysqlFormalMetricStore(pool()).latestCapacity(...args),
  dimensions: (...args) => new MysqlFormalMetricStore(pool()).dimensions(...args),
  async attempts(ref) {
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT payload FROM metric_attempts
      WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.binding_id')) = ? ORDER BY stored_at DESC LIMIT 100`, [refKey(ref)]);
    return rows.map(r => CollectionAttemptSchema.parse(decode(r.payload)));
  },
};
/** Template rows answer from their exact pending plan; a package row is not this port's business. */
export const templateQueryPort: TemplateQueryPort = {
  async read(ref) {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
    if (!rows[0]) return null;
    const decoded = decodeBindingPayload(rows[0].payload);
    if (decoded.kind !== 'template_pending') return null;
    const plan = decoded.pending.plan;
    return {
      revision: decoded.binding.revision,
      settings: plan.settings,
      releases: plan.releases.map(release => ({ ...release.release })),
      items: plan.releases.flatMap(release => release.steps.flatMap(step => step.items.map(item => ({
        metric: { ...item.canonical_metric },
        source: { kind: 'collector' as const, collector_id: step.collector_id },
        enabled: true,
        capability: item.capability,
        release: { ...release.release },
      })))),
    };
  },
};
export const metricConsumerService = new MetricConsumerService(policyService, createConfigurationRegistry(), consumerStore,
  () => new Date().toISOString(), templateQueryPort);

export const operationalSource = (ref: Ref) => new MysqlFormalMetricStore(pool()).sourceState(ref);
