import { aggregateHistory } from './history-query.js';
import type { ConfigurationAt } from '../../contracts/metrics/configuration-history.js';
import { MetricConsumerQuerySchema } from '../../contracts/metrics/history.js';
import { hasPermission } from '../../auth/require-permission.js';
import { historySampling, type HistoryContext } from './history-context.js';
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { canReadResource } from '../../resources/resource-service.js';
import { CONTRACT_VERSION, DimensionsSchema, MetricRefSchema, validateDimensions, type CollectionAttempt, type CoreProfile, type MetricDefinition, type NormalizedObservation } from '../../contracts/metrics/index.js';
import type { PolicyService } from '../policy/service.js';
import { PolicyError, RefSchema, metricKey, rule, type Ref } from '../policy/model.js';
import type { PackageRegistry } from '../packages/model.js';
import { canonicalDefinitions } from '../packages/builtins.js';
import { aggregate, SemanticQueryService, type QueryStore, type SemanticBucket } from '../query.js';
import { capacityDefinition } from '../database/catalog.js';
import { OBSERVATION_PAGE_DEFAULT_LIMIT, OBSERVATION_PAGE_MAX_LIMIT, OBSERVATION_PAGE_ORDER,
  decodeObservationCursor, encodeObservationCursor, observationCursorBinding, type ObservationPageResult } from '../observations/page.js';
import type { Series } from '../storage.js';

// Product-owned order. Package versions can supply values, never mutate these columns.
export const coreProfiles = {
  instance: [{ id: 'db.uptime_seconds', label: '数据库运行时长' }],
  server: [{ id: 'host.filesystem.used_bytes', label: '文件系统已用' }, { id: 'host.filesystem.size_bytes', label: '文件系统容量' }, { id: 'host.network.bytes_total', label: '接口字节速率' }],
  network_device: [{ id: 'network.interface.oper_up', label: '接口运行状态' }],
} as const;
export const ConsumerQuerySchema = MetricConsumerQuerySchema.refine(q => Boolean(q.from) === Boolean(q.to), 'Both window endpoints are required');
export type ConsumerQuery = z.input<typeof ConsumerQuerySchema>;
/** One page of formal raw observations; the cursor never carries an offset. */
export const ObservationPageQuerySchema = z.strictObject({
  resource: RefSchema, metric: MetricRefSchema, dimensions: DimensionsSchema.default({}),
  from: z.iso.datetime(), to: z.iso.datetime(),
  limit: z.number().int().min(1).max(OBSERVATION_PAGE_MAX_LIMIT).default(OBSERVATION_PAGE_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(4096).optional(),
});
export interface ConsumerStore extends QueryStore {
  historyMetrics?(ref: Ref, from: string, to: string): Promise<Array<{ id: string; semantic_version: string }>>;
  readHistoryWindow?(series: Series, from: string, to: string): Promise<NormalizedObservation[]>;
  historyDimensions?(ref: Ref, definition: MetricDefinition, from: string, to: string): Promise<Record<string, string>[]>;
  historyContext?(ref: Ref, from: string, to: string, revisions: number[], eventsReadable: boolean): Promise<HistoryContext>;
  dimensions(ref: Ref, definition: MetricDefinition, from: string, to: string): Promise<Record<string, string>[]>;
  attempts(ref: Ref): Promise<CollectionAttempt[]>;
  latestCapacity?(ref: Ref, definition: MetricDefinition, to: string, revision: number): Promise<NormalizedObservation | null>;
  readObservationPage?(series: Series, from: string, to: string,
    options: { limit: number; after: { at: string; id: string } | null }): Promise<ObservationPageResult>;
}
/**
 * The template binding as a consumer view. It carries exactly the plan facts the
 * query path uses (settings, selected items with their collector source and
 * capability, and the exact releases) — never a synthesized package binding.
 */
export interface TemplateQueryView {
  revision: number;
  settings: { enabled: boolean; interval_ms: number; stale_after_ms: number; max_counter_gap_ms: number };
  releases: Array<{ id: string; version: string; digest: string }>;
  items: Array<{
    metric: { id: string; semantic_version: string };
    source: { kind: 'collector'; collector_id: string };
    enabled: boolean;
    capability: { status: string } & Record<string, unknown>;
    release: { id: string; version: string; digest: string };
  }>;
}
export interface TemplateQueryPort { read(ref: Ref): Promise<TemplateQueryView | null> }
export interface ConsumerMetric {
  definition: MetricDefinition;
  capability: unknown;
  enabled: boolean;
  state: string;
  attempt: CollectionAttempt | null;
  observed_at?: string;
  series: Array<{ dimensions: Record<string, string>; buckets: SemanticBucket[] }>;
}
export class MetricConsumerService {
  constructor(private policy: Pick<PolicyService, 'assertAccess' | 'effective'>, private registry: PackageRegistry,
    private store: ConsumerStore, private clock = () => new Date().toISOString(),
    private readonly templateBindings?: TemplateQueryPort,
    private readonly reloadActor?: (actor: ActorContext) => Promise<ActorContext>,
    private readonly configurationAt?: (actor: ActorContext, ref: Ref, revision: number) => Promise<ConfigurationAt>) {}
  private async authorize(actor: ActorContext, ref: Ref) {
    const live = this.reloadActor ? await this.reloadActor(actor) : actor;
    await this.policy.assertAccess(live, ref, false);
    return live;
  }
  async discover(actor: ActorContext, ref: Ref) {
    actor = await this.authorize(actor, ref);
    let effective: Awaited<ReturnType<PolicyService['effective']>> | null = null;
    let template: TemplateQueryView | null = null;
    try { effective = await this.policy.effective(actor, ref); }
    catch (e) {
      if (e instanceof PolicyError && e.code === 'POLICY_NOT_FOUND') effective = null;
      else if (e instanceof PolicyError && e.code === 'TEMPLATE_BINDING_UNSUPPORTED' && this.templateBindings) {
        template = await this.templateBindings.read(ref);
        if (!template) throw e;
      } else throw e;
    }
    const canonical = canonicalDefinitions.filter(d => d.resource_type === ref.type);
    const pin = effective?.resolved.plan.binding.package;
    // A template binding may pin several releases; its extension definitions are
    // the union of those exact releases, never an inferred package.
    const extensions = template
      ? [...new Map(template.releases.flatMap(release => this.registry.get(release).extensions)
        .map(definition => [`${definition.id}@${definition.semantic_version}`, definition])).values()]
      : pin ? this.registry.get(pin).extensions : [];
    const inventory = ref.type === 'instance' ? await this.store.inventory(ref.type, String(ref.id)) : null;
    const size = capacityDefinition(String(inventory?.attributes['db.engine']?.value ?? ''));
    const definitions = [...canonical, ...extensions];
    if (size && !definitions.some(d => d.id === size.id)) definitions.push(size);
    const profile: CoreProfile = { id: `${ref.type}-core`, version: '1.0.0', owner: 'product', resource_type: ref.type,
      columns: [...coreProfiles[ref.type].map(c => ({ key: c.id, label: c.label, metric: { id: c.id, semantic_version: '1.0.0' } })),
        ...(size ? [{ key: 'database_size', label: '数据库大小', metric: { id: size.id, semantic_version: size.semantic_version } }] : [])] };
    if (size) profile.version = '1.1.0';
    // A template plan is exposed through the same read surface the query path
    // uses. It carries no package `application` acknowledgement: the accepted
    // envelope keeps `applied_revision` at the previous revision, so the view
    // reports it as pending instead of inventing an applied claim.
    const view = effective ?? (template ? {
      published_revision: template.revision,
      application: { status: 'pending' as const, applied_revision: null },
      resolved: {
        settings: template.settings,
        metric_templates: template.items,
        plan: { binding: { package: template.releases[0] ?? null } },
      },
    } as unknown as Awaited<ReturnType<PolicyService['effective']>> : null);
    await this.authorize(actor, ref);
    return { profile, definitions, effective: view };
  }
  async inventory(actor: ActorContext, ref: Ref) {
    actor = await this.authorize(actor, ref);
    const result = await new SemanticQueryService(this.store, async () => false,
      async (type, id) => canReadResource(actor, { type, id: Number(id) })).inventory(ref.type, String(ref.id));
    await this.authorize(actor, ref);
    return result;
  }
  async query(actor: ActorContext, input: unknown) {
    const q = ConsumerQuerySchema.parse(input), now = this.clock();
    actor = await this.authorize(actor, q.resource);
    const catalog = await this.discover(actor, q.resource);
    const definitions = q.history
      ? [...new Map([...catalog.definitions, ...this.registry.list().flatMap(r => r.extensions)]
        .filter(d => d.resource_type === q.resource.type).map(d => [metricKey(d), d])).values()]
      : catalog.definitions;
    const settings = catalog.effective?.resolved.settings;
    const interval = settings?.interval_ms ?? 60000;
    const to = q.to ?? now, from = q.from ?? new Date(Date.parse(to) - interval).toISOString();
    rule(Date.parse(from) < Date.parse(to) && Date.parse(to) <= Date.parse(now)
      && Date.parse(to) - Date.parse(from) <= 31 * 86400000, 'QUERY_WINDOW');
    const retained = q.history && this.store.historyMetrics ? await this.store.historyMetrics(q.resource, from, to) : null;
    const visible = definitions.filter(d => !q.history || retained === null
      || catalog.definitions.some(c => metricKey(c) === metricKey(d)) || retained.some(r => metricKey(r) === metricKey(d)));
    const ids = [...new Set(q.metric_ids ?? (q.view === 'core' ? catalog.profile.columns.map(c => c.metric.id)
      : visible.filter(d => q.view === 'all' || d.category === q.view).map(d => d.id)))];
    rule(ids.every(id => definitions.some(d => d.id === id)), 'UNKNOWN_METRIC');
    const attempts = await this.store.attempts(q.resource);
    const queryStore = q.history && this.store.readHistoryWindow
      ? { ...this.store, readWindow: this.store.readHistoryWindow.bind(this.store) } : this.store;
    const service = new SemanticQueryService(queryStore, async s => s.resource_type === q.resource.type
      && s.resource_id === String(q.resource.id) && canReadResource(actor, q.resource)
      && definitions.some(d => metricKey(d) === metricKey(s.metric)));
    const configurations = new Map<number, Promise<ConfigurationAt>>();
    const configurationAt = (revision: number) => {
      if (!configurations.has(revision)) {
        rule(configurations.size < 100, 'QUERY_LIMIT_EXCEEDED');
        configurations.set(revision, this.configurationAt!(actor, q.resource, revision));
      }
      return configurations.get(revision)!;
    };
    const metrics: ConsumerMetric[] = [];
    for (const definition of ids.flatMap(id => visible.filter(d => d.id === id))) {
      const id = definition.id;
      const template = catalog.effective?.resolved.metric_templates.find(t => metricKey(t.metric) === metricKey(definition));
      const collector = template?.source.kind === 'collector' ? template.source.collector_id : undefined;
      const attempt = attempts.filter(a => a.config_revision === catalog.effective?.published_revision && (!collector || a.collector_id === collector))
        .sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
      // The rate query supports byte/count units. Retain other cumulative evidence
      // (e.g. block I/O milliseconds) without making one unavailable operation fail
      // the whole resource or relabelling its value as a byte/count rate.
      const state = definition.kind === 'counter' && (!definition.aggregation.time.includes('rate') || !['By','count'].includes(definition.unit)) ? 'query_operation_unavailable' : !template ? 'not_covered' : !template.enabled || !settings?.enabled ? 'disabled'
        : attempt?.error === 'permission_denied' ? 'permission_denied'
        : template.capability.status === 'unsupported' ? 'unsupported'
        : attempt?.error || attempt && ['failed', 'partial', 'cancelled'].includes(attempt.status) ? 'temporary_failure' : template.capability.status === 'unknown' ? 'capability_unknown' : 'available';
      const metric: ConsumerMetric = { definition, capability: template?.capability ?? null,
        enabled: Boolean(template?.enabled && settings?.enabled), state, attempt, series: [] };
      if (q.latest_capacity && catalog.profile.columns.some(c => c.key === 'database_size' && c.metric.id === id)) {
        rule(!q.from && !q.to, 'LATEST_CAPACITY_WINDOW');
        if (template && !['unsupported', 'permission_denied', 'disabled'].includes(state)) {
          rule(this.store.latestCapacity, 'LATEST_CAPACITY_UNAVAILABLE', 503);
          const point = await this.store.latestCapacity(q.resource, definition, to, catalog.effective!.published_revision);
          if (point) {
            const series: Series = { resource_type: q.resource.type, resource_id: String(q.resource.id), metric: point.metric, dimensions: point.dimensions };
            metric.observed_at = point.observed_at;
            metric.series = [{ dimensions: point.dimensions, buckets: aggregate({ definition, series: [series], from: point.observed_at,
              to: new Date(Date.parse(point.observed_at) + 1).toISOString(), now, interval_ms: 1, bucket_ms: 1,
              max_gap_ms: settings!.max_counter_gap_ms, stale_after_ms: settings!.stale_after_ms, mode: 'last', space: 'none' }, [[point]]) }];
          }
        }
        metrics.push(metric);
        continue;
      }
      if (state !== 'query_operation_unavailable' && (q.history && (retained === null || retained.some(r => metricKey(r) === metricKey(definition))) || template && !['unsupported', 'permission_denied', 'disabled'].includes(state))) {
        const dimensions = definition.dimensions.keys.some(k => k.required)
          ? await (q.history && this.store.historyDimensions ? this.store.historyDimensions.bind(this.store) : this.store.dimensions.bind(this.store))(q.resource, definition, from, to) : [{}];
        rule(dimensions.length <= 100, 'QUERY_SERIES_LIMIT');
        for (const dimension of dimensions) {
          const series: Series = { resource_type: q.resource.type, resource_id: String(q.resource.id),
            metric: { id, semantic_version: definition.semantic_version }, dimensions: dimension };
          const request = { definition, series: [series], from, to, now,
            interval_ms: q.history ? historySampling.interval_ms : interval, max_gap_ms: q.history ? historySampling.max_gap_ms : settings!.max_counter_gap_ms, stale_after_ms: q.history ? historySampling.max_gap_ms : settings!.stale_after_ms,
            bucket_ms: q.bucket_ms ?? (q.history ? historySampling.interval_ms : interval), mode: definition.kind === 'counter' ? 'rate' as const : 'last' as const, space: 'none' as const };
          const buckets = q.history && this.configurationAt
            ? await aggregateHistory(request, await (queryStore.readWindow ? queryStore.readWindow(series, from, to) : queryStore.queryWindow(series, from, to)), configurationAt)
            : await service.query(request);
          metric.series.push({ dimensions: dimension, buckets });
        }
      }
      metrics.push(metric);
    }
    const revisions = [...new Set(metrics.flatMap(m => m.series.flatMap(s => s.buckets.flatMap(b => b.sources.map(s => s.versions.config_revision)))))];
    const context = q.history && this.store.historyContext
      ? await this.store.historyContext(q.resource, from, to, revisions, hasPermission(new Set(actor.permissions), 'alert:view')) : undefined;
    if (context) context.configurations = await Promise.all(configurations.values());
    // Recheck access after all storage waits, including the last page/context read.
    const live = await this.authorize(actor, q.resource);
    if (context && !hasPermission(new Set(live.permissions), 'alert:view')) { context.events = []; context.events_readable = false; }
    return { contract_version: '1.0.0', resource: q.resource, window: { from, to }, evaluated_at: now,
      ...(context ? { history_context: context } : {}),
      profile: catalog.profile, configuration_revision: catalog.effective?.published_revision ?? null, metrics };
  }
  /**
   * One page of formal raw observations. Authorization and metric identity are re-read
   * from this request on every page, so a cursor can neither widen access nor move to
   * another resource, metric, version, dimensions or window.
   */
  async observations(actor: ActorContext, input: unknown) {
    const q = ObservationPageQuerySchema.parse(input);
    const from = new Date(q.from).toISOString(), to = new Date(q.to).toISOString();
    rule(Date.parse(to) > Date.parse(from) && Date.parse(to) - Date.parse(from) <= 31 * 86400000, 'QUERY_WINDOW');
    actor = await this.authorize(actor, q.resource);
    const catalog = await this.discover(actor, q.resource);
    const definition = [...catalog.definitions, ...this.registry.list().flatMap(r => r.extensions)]
      .find(d => d.resource_type === q.resource.type && d.id === q.metric.id && d.semantic_version === q.metric.semantic_version);
    rule(definition, 'UNKNOWN_METRIC');
    try { validateDimensions(q.dimensions, definition); } catch { throw new PolicyError('QUERY_INPUT_INVALID', 400); }
    const series: Series = { resource_type: q.resource.type, resource_id: String(q.resource.id),
      metric: { id: definition.id, semantic_version: definition.semantic_version }, dimensions: q.dimensions };
    const binding = observationCursorBinding(series, from, to);
    const after = q.cursor ? decodeObservationCursor(q.cursor, binding) : null;
    rule(this.store.readObservationPage, 'OBSERVATION_PAGE_UNAVAILABLE', 503);
    const page = await this.store.readObservationPage(series, from, to, { limit: q.limit, after });
    await this.authorize(actor, q.resource);
    return { contract_version: CONTRACT_VERSION, resource: q.resource,
      metric: { id: definition.id, semantic_version: definition.semantic_version }, dimensions: q.dimensions,
      window: { from, to }, order: OBSERVATION_PAGE_ORDER, total: page.total, has_more: page.has_more,
      ...(page.next ? { next_cursor: encodeObservationCursor(page.next, binding) } : {}),
      observations: page.observations.map(o => ({ id: o.id, observed_at: o.observed_at, value: o.value, unit: o.unit,
        quality: o.quality, accuracy: o.accuracy, sources: [{ id: o.id, source: o.source, versions: o.versions }] })) };
  }
}
