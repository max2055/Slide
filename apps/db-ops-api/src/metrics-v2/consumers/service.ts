import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { canReadResource } from '../../resources/resource-service.js';
import type { CollectionAttempt, CoreProfile, MetricDefinition } from '../../contracts/metrics-v2/index.js';
import type { PolicyService } from '../policy/service.js';
import { PolicyError, RefSchema, metricKey, rule, type Ref } from '../policy/model.js';
import type { PackageRegistry } from '../packages/model.js';
import { canonicalDefinitions } from '../packages/builtins.js';
import { SemanticQueryService, type QueryStore, type SemanticBucket } from '../query.js';
import type { Series } from '../storage.js';

// Product-owned order. Package versions can supply values, never mutate these columns.
export const coreProfiles = {
  instance: [{ id: 'db.uptime_seconds', label: '数据库运行时长' }],
  server: [{ id: 'host.filesystem.used_bytes', label: '文件系统已用' }, { id: 'host.filesystem.size_bytes', label: '文件系统容量' }, { id: 'host.network.bytes_total', label: '接口字节速率' }],
  network_device: [{ id: 'network.interface.oper_up', label: '接口运行状态' }],
} as const;
export const ConsumerQuerySchema = z.strictObject({
  resource: RefSchema, from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  metric_ids: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/)).min(1).max(32).optional(),
  view: z.enum(['core', 'canonical', 'extension', 'all']).default('core'),
  bucket_ms: z.number().int().positive().max(86400000).optional(),
}).refine(q => Boolean(q.from) === Boolean(q.to), 'Both window endpoints are required');
export type ConsumerQuery = z.input<typeof ConsumerQuerySchema>;
export interface ConsumerStore extends QueryStore {
  dimensions(ref: Ref, definition: MetricDefinition, from: string, to: string): Promise<Record<string, string>[]>;
  attempts(ref: Ref): Promise<CollectionAttempt[]>;
}
export interface ConsumerMetric {
  definition: MetricDefinition;
  capability: unknown;
  enabled: boolean;
  state: string;
  attempt: CollectionAttempt | null;
  series: Array<{ dimensions: Record<string, string>; buckets: SemanticBucket[] }>;
}
export class MetricConsumerService {
  constructor(private policy: Pick<PolicyService, 'assertAccess' | 'effective'>, private registry: PackageRegistry,
    private store: ConsumerStore, private clock = () => new Date().toISOString()) {}
  async discover(actor: ActorContext, ref: Ref) {
    await this.policy.assertAccess(actor, ref, false);
    let effective: Awaited<ReturnType<PolicyService['effective']>> | null = null;
    try { effective = await this.policy.effective(actor, ref); }
    catch (e) { if (!(e instanceof PolicyError && e.code === 'POLICY_NOT_FOUND')) throw e; }
    const canonical = canonicalDefinitions.filter(d => d.resource_type === ref.type);
    const pin = effective?.resolved.plan.binding.package;
    const extensions = pin ? this.registry.get(pin).extensions : [];
    const profile: CoreProfile = { id: `${ref.type}-core`, version: '1.0.0', owner: 'product', resource_type: ref.type,
      columns: coreProfiles[ref.type].map(c => ({ key: c.id, label: c.label, metric: { id: c.id, semantic_version: '1.0.0' } })) };
    return { profile,
      definitions: [...canonical, ...extensions], effective };
  }
  async inventory(actor: ActorContext, ref: Ref) {
    await this.policy.assertAccess(actor, ref, false);
    return new SemanticQueryService(this.store, async () => false,
      async (type, id) => canReadResource(actor, { type, id: Number(id) })).inventory(ref.type, String(ref.id));
  }
  async query(actor: ActorContext, input: unknown) {
    const q = ConsumerQuerySchema.parse(input), now = this.clock();
    const catalog = await this.discover(actor, q.resource);
    const settings = catalog.effective?.resolved.settings;
    const interval = settings?.interval_ms ?? 60000;
    const to = q.to ?? now, from = q.from ?? new Date(Date.parse(to) - interval).toISOString();
    rule(Date.parse(from) < Date.parse(to) && Date.parse(to) <= Date.parse(now)
      && Date.parse(to) - Date.parse(from) <= 31 * 86400000, 'QUERY_WINDOW');
    const ids: string[] = q.metric_ids ?? (q.view === 'core' ? catalog.profile.columns.map(c => c.metric.id)
      : catalog.definitions.filter(d => q.view === 'all' || d.category === q.view).map(d => d.id));
    rule(ids.every(id => catalog.definitions.some(d => d.id === id)), 'UNKNOWN_METRIC');
    const attempts = await this.store.attempts(q.resource);
    const service = new SemanticQueryService(this.store, async s => s.resource_type === q.resource.type
      && s.resource_id === String(q.resource.id) && canReadResource(actor, q.resource)
      && catalog.definitions.some(d => metricKey(d) === metricKey(s.metric)));
    const metrics: ConsumerMetric[] = [];
    for (const id of ids) {
      const definition = catalog.definitions.find(d => d.id === id)!;
      const template = catalog.effective?.resolved.metric_templates.find(t => metricKey(t.metric) === metricKey(definition));
      const collector = template?.source.kind === 'collector' ? template.source.collector_id : undefined;
      const attempt = attempts.filter(a => a.config_revision === catalog.effective?.published_revision && (!collector || a.collector_id === collector))
        .sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
      const state = definition.kind === 'counter' && !definition.aggregation.time.includes('rate') ? 'query_operation_unavailable' : !template ? 'not_configured' : !template.enabled || !settings?.enabled ? 'disabled'
        : attempt?.error === 'permission_denied' ? 'permission_denied'
        : template.capability.status === 'unsupported' ? 'unsupported'
        : attempt?.error || attempt && ['failed', 'partial', 'cancelled'].includes(attempt.status) ? 'temporary_failure' : template.capability.status === 'unknown' ? 'capability_unknown' : 'available';
      const metric: ConsumerMetric = { definition, capability: template?.capability ?? null,
        enabled: Boolean(template?.enabled && settings?.enabled), state, attempt, series: [] };
      if (template && state !== 'unsupported' && state !== 'permission_denied' && state !== 'disabled' && state !== 'query_operation_unavailable') {
        const dimensions = definition.dimensions.keys.some(k => k.required)
          ? await this.store.dimensions(q.resource, definition, from, to) : [{}];
        rule(dimensions.length <= 100, 'QUERY_SERIES_LIMIT');
        for (const dimension of dimensions) {
          const series: Series = { resource_type: q.resource.type, resource_id: String(q.resource.id),
            metric: { id, semantic_version: definition.semantic_version }, dimensions: dimension };
          metric.series.push({ dimensions: dimension, buckets: await service.query({ definition, series: [series], from, to, now,
            interval_ms: interval, max_gap_ms: settings!.max_counter_gap_ms, stale_after_ms: settings!.stale_after_ms,
            bucket_ms: q.bucket_ms ?? interval, mode: definition.kind === 'counter' ? 'rate' : 'last', space: 'none' }) });
        }
      }
      metrics.push(metric);
    }
    return { contract_version: '1.0.0', resource: q.resource, window: { from, to }, evaluated_at: now,
      profile: catalog.profile, configuration_revision: catalog.effective?.published_revision ?? null, metrics };
  }
}
