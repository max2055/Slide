/** Canonical first; proprietary extensions require explicit discovery/selection. */
import { z } from 'zod';
import type { AnyAgentTool } from '../types.js';
import { toolCatalog } from '../catalog.js';
import { metricConsumerService } from '../../metrics/consumers/runtime.js';
import type { MetricConsumerService } from '../../metrics/consumers/service.js';
import { migrateReference } from '../../metrics/consumers/migration.js';
import { PolicyError } from '../../metrics/policy/model.js';
import { metricDiscoveryPage } from '../../metrics/consumers/discovery.js';
const Args = z.strictObject({
  instance_id: z.number().int().positive().optional(), resourceType: z.enum(['instance', 'server', 'network_device']).optional(), resourceId: z.number().int().positive().optional(),
  mode: z.enum(['realtime', 'history', 'discover', 'inventory']).default('realtime'),
  metric_ids: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/)).min(1).max(32).optional(),
  series_index: z.number().int().min(0).max(99).optional(),
  discovery_offset: z.number().int().min(0).max(100000).optional(),
  discovery_limit: z.number().int().min(1).max(64).optional(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  period: z.enum(['1h', '6h', '24h', '7d']).optional(), interval: z.enum(['1m', '5m', '15m', '1h']).optional(),
}).refine(a => a.series_index === undefined || (a.metric_ids?.length === 1 && ['realtime', 'history'].includes(a.mode)), 'Series selection requires one explicit metric')
  .refine(a => (a.discovery_offset === undefined && a.discovery_limit === undefined) || (a.mode === 'discover' && !a.metric_ids), 'Discovery paging requires discover without metric_ids')
  .refine(a => a.mode !== 'discover' || !a.metric_ids || a.metric_ids.length === 1, 'Discover one complete definition at a time');
export function createQueryMetricsTool(service: MetricConsumerService = metricConsumerService, clock = () => new Date().toISOString()): AnyAgentTool {
  return {
    name: 'query_metrics', group: 'db_ops',
    description: '查询标准指标（默认 Canonical/CoreProfile）。响应包含定义、单位、口径、时间覆盖、质量、新鲜度、来源与估算标记；缺失不代表无异常。专有 InnoDB 等问题先用 discover 发现当前资源模板的 Extension，再用明确 metric_ids 查询；未知指标不会编造值。db.version 等属性使用 inventory。',
    parameters: { type: 'object', properties: {
      instance_id: { type: 'number', description: '数据库实例 ID；或使用 resourceType/resourceId' },
      resourceType: { type: 'string', enum: ['instance', 'server', 'network_device'] }, resourceId: { type: 'number' },
      mode: { type: 'string', enum: ['realtime', 'history', 'discover', 'inventory'] },
      metric_ids: { type: 'array', items: { type: 'string' }, description: '明确 Canonical 或已发现的 Extension ID；不传默认产品核心指标' },
      series_index: { type: 'integer', minimum: 0, maximum: 99, description: '仅选择一个明确指标的一条维度序列，0起始；响应保留真实dimensions和总序列数' },
      discovery_offset: { type: 'integer', minimum: 0, maximum: 100000, description: '仅discover索引分页，默认0；按next_offset接续，配置revision改变时重新发现' },
      discovery_limit: { type: 'integer', minimum: 1, maximum: 64, description: '仅discover索引页大小，默认64；discover配一个metric_ids读取完整定义，不能同时分页' },
      from: { type: 'string', description: 'UTC ISO 窗口起点，与 to 同时指定' }, to: { type: 'string', description: 'UTC ISO 窗口终点（不含）' },
      period: { type: 'string', enum: ['1h', '6h', '24h', '7d'] }, interval: { type: 'string', enum: ['1m', '5m', '15m', '1h'] },
    } },
    handler: async (input, context) => {
      if (!context?.actor) return { success: false, status: 'error', errorCode: 'AUTH_REQUIRED', error: '需要已认证的资源权限上下文' };
      try {
        const args = Args.parse(input);
        if (args.instance_id !== undefined && (args.resourceType !== undefined || args.resourceId !== undefined)) throw new Error('RESOURCE_AMBIGUOUS');
        const ref = { type: args.resourceType ?? 'instance' as const, id: args.resourceId ?? args.instance_id };
        if (!ref.id || Boolean(args.resourceType) !== Boolean(args.resourceId)) throw new Error('RESOURCE_INVALID');
        const resource = { ...ref, id: ref.id };
        if (args.mode === 'discover') {
          const catalog = await service.discover(context.actor, resource);
          const id = args.metric_ids?.[0];
          if (id && !catalog.definitions.some(d => d.id === id)) throw new PolicyError('UNKNOWN_METRIC');
          return { success: true, data: { resource, profile: catalog.profile,
            configuration_revision: catalog.effective?.published_revision ?? null,
            ...metricDiscoveryPage(catalog.definitions, args.discovery_offset, args.discovery_limit, id) } };
        }
        if (args.mode === 'inventory') return { success: true, data: await service.inventory(context.actor, resource) };
        let migrations: ReturnType<typeof migrateReference>[] = [];
        let ids = args.metric_ids;
        if (ids?.some(id => !id.includes('.'))) {
          const inventory = await service.inventory(context.actor, resource);
          const engine = String(inventory?.attributes['db.engine']?.value ?? 'unknown');
          migrations = ids.map(id => migrateReference(resource, engine, id));
          if (migrations.some(m => !m.metric_id)) return { success: false, status: 'error', errorCode: 'UNKNOWN_METRIC', data: { migrations }, error: '旧指标无等价标准定义，请使用 discover 查看可用指标' };
          ids = migrations.map(m => m.metric_id!);
        }
        const to = args.to ?? (args.mode === 'history' ? clock() : undefined);
        const hours = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 }[args.period ?? '24h'];
        const from = args.from ?? (args.mode === 'history' ? new Date(Date.parse(to!) - hours * 3600000).toISOString() : undefined);
        const interval = args.interval ?? (args.mode === 'history' ? hours <= 1 ? '1m' : hours <= 6 ? '5m' : hours <= 24 ? '15m' : '1h' : undefined);
        const bucket_ms = interval ? { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000 }[interval] : undefined;
        let data = await service.query(context.actor, { resource, metric_ids: ids, from, to, bucket_ms });
        let selection: { series_index: number; total_series: number } | undefined;
        if (args.series_index !== undefined) {
          const metric = data.metrics[0];
          if (data.metrics.length !== 1 || !metric || args.series_index >= Math.max(1, metric.series.length)) throw new Error('SERIES_INDEX_UNAVAILABLE');
          selection = { series_index: args.series_index, total_series: metric.series.length };
          data = { ...data, metrics: [{ ...metric, series: metric.series.length ? [metric.series[args.series_index]] : [] }] };
        }
        const complete = data.metrics.length > 0 && data.metrics.every(m => m.state === 'available' && m.series.length > 0
          && m.series.every(s => s.buckets.length > 0 && s.buckets.every(b => b.value !== null && b.quality.status === 'good' && b.freshness === 'fresh' && b.accuracy === 'exact')));
        return { success: true, status: complete ? 'success' : 'warning', data: { ...data, migrations, ...(selection ? { selection } : {}) },
          summary: complete ? '已获取标准指标，请按定义解释数值' : '指标证据不完整或包含估算，不能据此判断无异常',
          next_actions: complete ? [] : ['检查 capability、attempt、coverage 和 freshness；不要将缺失值补零'] };
      } catch (e) {
        return { success: false, status: 'error', errorCode: e instanceof PolicyError ? e.code : e instanceof z.ZodError ? 'INVALID_ARGUMENTS' : 'QUERY_METRICS_FAILED', error: '标准指标查询失败，未产生健康结论' };
      }
    },
  };
}
export const queryMetricsTool = createQueryMetricsTool();
toolCatalog.register(queryMetricsTool);
