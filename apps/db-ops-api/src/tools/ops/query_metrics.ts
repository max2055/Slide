/** Canonical first; proprietary extensions require explicit discovery/selection. */
import { z } from 'zod';
import type { AnyAgentTool } from '../types.js';
import { toolCatalog } from '../catalog.js';
import { metricConsumerService } from '../../metrics-v2/consumers/runtime.js';
import type { MetricConsumerService } from '../../metrics-v2/consumers/service.js';
import { migrateReference } from '../../metrics-v2/consumers/migration.js';
import { PolicyError } from '../../metrics-v2/policy/model.js';
const Args = z.strictObject({
  instance_id: z.number().int().positive().optional(), resourceType: z.enum(['instance', 'server', 'network_device']).optional(), resourceId: z.number().int().positive().optional(),
  mode: z.enum(['realtime', 'history', 'discover', 'inventory']).default('realtime'),
  metric_ids: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/)).min(1).max(32).optional(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  period: z.enum(['1h', '6h', '24h', '7d']).optional(), interval: z.enum(['1m', '5m', '15m', '1h']).optional(),
});
export function createQueryMetricsTool(service: MetricConsumerService = metricConsumerService, clock = () => new Date().toISOString()): AnyAgentTool {
  return {
    name: 'query_metrics', group: 'db_ops',
    description: '查询标准指标（默认 Canonical/CoreProfile）。响应包含定义、单位、口径、时间覆盖、质量、新鲜度、来源与估算标记；缺失不代表无异常。专有 InnoDB 等问题先用 discover 发现当前资源模板的 Extension，再用明确 metric_ids 查询；未知指标不会编造值。db.version 等属性使用 inventory。',
    parameters: { type: 'object', properties: {
      instance_id: { type: 'number', description: '数据库实例 ID；或使用 resourceType/resourceId' },
      resourceType: { type: 'string', enum: ['instance', 'server', 'network_device'] }, resourceId: { type: 'number' },
      mode: { type: 'string', enum: ['realtime', 'history', 'discover', 'inventory'] },
      metric_ids: { type: 'array', items: { type: 'string' }, description: '明确 Canonical 或已发现的 Extension ID；不传默认产品核心指标' },
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
        if (args.mode === 'discover') return { success: true, data: await service.discover(context.actor, resource) };
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
        const data = await service.query(context.actor, { resource, metric_ids: ids, from, to, bucket_ms });
        const complete = data.metrics.length > 0 && data.metrics.every(m => m.state === 'available' && m.series.length > 0
          && m.series.every(s => s.buckets.length > 0 && s.buckets.every(b => b.value !== null && b.quality.status === 'good' && b.freshness === 'fresh' && b.accuracy === 'exact')));
        return { success: true, status: complete ? 'success' : 'warning', data: { ...data, migrations },
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
