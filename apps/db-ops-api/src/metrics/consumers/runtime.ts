import { actorContextService } from '../../auth/actor-context.js';
import { readHistoryContext } from './history-context.js';
import type { RowDataPacket } from 'mysql2/promise';
import { dbConnection } from '../../db-connection.js';
import { type Capability, CollectionAttemptSchema } from '../../contracts/metrics/index.js';
import { MysqlFormalMetricStore } from '../rollout/formal-store.js';
import { policyService } from '../policy/service.js';
import { metricKey, refKey, rule, type Ref } from '../policy/model.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { configurationInventory } from '../config/inventory.js';
import { MetricConsumerService, type ConsumerStore, type TemplateQueryPort, type TemplateQueryView } from './service.js';
import { decodeBindingPayload } from '../bindings/persistence-codec.js';
import { itemIntervals } from '../bindings/plan.js';
const pool = () => { const p = dbConnection.getPool(); rule(p, 'METRIC_STORE_UNAVAILABLE', 503); return p; };
const decode = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v;
export const consumerStore: ConsumerStore = {
  historyMetrics: (...args) => new MysqlFormalMetricStore(pool()).historyMetrics(...args),
  readHistoryWindow: (...args) => new MysqlFormalMetricStore(pool()).readHistoryWindow(...args),
  readHistoryChart: (...args) => new MysqlFormalMetricStore(pool()).readHistoryChart(...args),
  historyDimensions: (...args) => new MysqlFormalMetricStore(pool()).historyDimensions(...args),
  historyContext: (...args) => readHistoryContext(pool(), ...args),
  queryWindow: (...args) => new MysqlFormalMetricStore(pool()).queryWindow(...args),
  readWindow: (...args) => new MysqlFormalMetricStore(pool()).readWindow(...args),
  readObservationPage: (...args) => new MysqlFormalMetricStore(pool()).readObservationPage(...args),
  inventory: (type, id) => configurationInventory({ type, id: Number(id) }),
  latestCapacity: (...args) => new MysqlFormalMetricStore(pool()).latestCapacity(...args),
  latestObservations: (...args) => new MysqlFormalMetricStore(pool()).latestObservations(...args),
  dimensions: (...args) => new MysqlFormalMetricStore(pool()).dimensions(...args),
  async attempts(ref) {
    const [rows] = await pool().execute<RowDataPacket[]>(`
      (SELECT payload FROM metric_attempts
        WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.binding_id')) = ? ORDER BY stored_at DESC LIMIT 100)
      UNION ALL
      (SELECT a.payload FROM metric_attempts a JOIN (
        SELECT DISTINCT i.attempt_id FROM metric_policy_bindings b
        JOIN JSON_TABLE(b.item_attempt_ids, '$.*' COLUMNS (attempt_id VARCHAR(256) PATH '$')) i
        WHERE b.resource_key = ?
      ) latest ON a.id = latest.attempt_id)`, [refKey(ref), refKey(ref)]);
    const attempts = rows.map(r => CollectionAttemptSchema.parse(decode(r.payload)));
    return [...new Map(attempts.map(attempt => [attempt.id, attempt])).values()];
  },
};
/** Template rows answer from their exact pending plan; a package row is not this port's business. */
const registry = createConfigurationRegistry();
export const templateQueryPort: TemplateQueryPort = {
  async read(ref) {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT payload, capabilities FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
    if (!rows[0]) return null;
    const decoded = decodeBindingPayload(rows[0].payload);
    if (decoded.kind !== 'template_pending') return null;
    const plan = decoded.pending.plan;
    const capabilities: Capability[] = rows[0].capabilities ? decode(rows[0].capabilities) : [];
    return {
      revision: decoded.binding.revision,
      settings: plan.settings,
      releases: plan.releases.map(release => ({ ...release.release })),
      items: plan.releases.flatMap(release => {
        const items: TemplateQueryView['items'] = release.steps.flatMap(step => step.items.map(item => ({
          metric: { ...item.canonical_metric },
          source: { kind: 'collector', collector_id: step.collector_id },
          enabled: true,
          ...(item.interval_ms === undefined ? {} : { interval_ms: item.interval_ms }),
          capability: capabilities.find(fact => fact.method === step.method && metricKey(fact.metric) === metricKey(item.canonical_metric))
            ?? item.capability, release: release.release,
        })));
        const derived = registry.get(release.release).derived.filter(node => release.metric_keys.includes(metricKey(node.output)));
        const intervals = itemIntervals([release]);
        for (const node of derived) {
          items.push({ metric: node.output, source: { kind: 'derived', derived_id: node.id },
            interval_ms: intervals.get(metricKey(node.output)),
            enabled: true, capability: capabilities.find(fact => fact.method === 'derived' && metricKey(fact.metric) === metricKey(node.output))
              ?? { status: 'unknown' }, release: release.release });
        }
        return items;
      }),
    };
  },
};
// Existing scheduler/report adapters construct resource-scoped internal actors;
// they are not authenticated user sessions. Keep their reader inside the server.
export const internalMetricConsumerService = new MetricConsumerService(policyService, registry, consumerStore,
  () => new Date().toISOString(), templateQueryPort);
// HTTP callers always use live user authentication before and after storage waits.
// Never select between these readers by trusting an actor field from a request.
export const metricConsumerService = new MetricConsumerService(policyService, registry, consumerStore,
  () => new Date().toISOString(), templateQueryPort, actor => actorContextService.revalidateActor(actor, actor.requestId),
  async (actor, ref, revision) => {
    const { templateBindingService } = await import('../templates/routes.js');
    return templateBindingService.readConfigurationAt(actor, ref, revision);
  });

export const operationalSource = (ref: Ref) => new MysqlFormalMetricStore(pool()).sourceState(ref);

/** Compatibility name for the authenticated HTTP registrar. */
export const authenticatedMetricConsumerService = metricConsumerService;
