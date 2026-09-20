import type { MetricResult, SemanticResult } from './semantic-metrics.js';
export const collectionLabels: Record<string, string> = {
  query_operation_unavailable: '不支持速率查询', loading: '正在读取', available: '采集正常', not_configured: '未配置', disabled: '已停用', unsupported: '不支持',
  permission_denied: '采集权限不足', temporary_failure: '采集失败', capability_unknown: '待验证',
  stale: '已过期', partial: '部分缺失', query_failed: '指标加载失败', forbidden: '无查看权限', unavailable: '资源不可用',
};
export const metricNames: Record<string, string> = {
  'db.uptime_seconds': '数据库运行时长', 'host.filesystem.used_bytes': '文件系统已用空间',
  'host.filesystem.size_bytes': '文件系统容量', 'host.network.bytes_total': '接口字节数',
  'network.interface.oper_up': '接口运行状态',
  'linux.cpu.user_system_percent': 'CPU 用户与系统使用率', 'linux.memory.used_percent': '内存使用率',
  'linux.filesystem.used_ratio': '文件系统使用比例', 'mysql.queries.total': 'MySQL 累计语句数',
  'mysql.queries.per_second': 'MySQL 每秒语句数', 'snmp.agent.uptime_seconds': '管理子系统运行时长',
  'snmp.interface.admin_up': '接口管理状态', 'snmp.interface.speed_bits_per_second': '接口标称带宽',
  'huawei.device.cpu_percent': '华为设备 CPU 使用率', 'huawei.device.memory_percent': '华为设备内存使用率',
};
export const resourceLabels: Record<string, string> = { instance: '数据库实例', server: '服务器', network_device: '网络设备' };
export const packageName = (id: string) => ({ 'mysql-basic': 'MySQL 基础采集', 'linux-basic': 'Linux 基础采集', 'linux-host': 'Linux 主机采集', 'if-mib-basic': '标准接口采集', 'snmp-standard': 'SNMP 标准采集' }[id] ?? '扩展采集包');
export const metricName = (id: string) => metricNames[id] ?? '扩展指标';
export type MetricRow = { result?: SemanticResult; state: string; lastSuccess?: string; timeUnavailable?: boolean };
export function collectionState(result: SemanticResult): string {
  const metrics = result.metrics;
  if (!metrics.length) return 'not_configured';
  for (const state of ['permission_denied', 'temporary_failure', 'capability_unknown']) if (metrics.some(m => m.state === state)) return state;
  if (metrics.every(m => m.state === metrics[0].state) && metrics[0].state !== 'available') return metrics[0].state;
  const buckets = metrics.flatMap(m => m.series.flatMap(s => s.buckets));
  if (buckets.some(b => b.freshness === 'stale')) return 'stale';
  if (metrics.some(m => m.state !== 'available' || !m.series.length) || !buckets.length || buckets.some(b => !b.value || b.quality.status !== 'good' || b.coverage < 1)) return 'partial';
  return 'available';
}
const latest = (m: MetricResult) => m.series.map(s => ({ dimensions: s.dimensions, bucket: s.buckets.at(-1) }));
export function metricSummary(result: SemanticResult | undefined, id: string): string {
  const m = result?.metrics.find(m => m.definition.id === id);
  if (!m) return '暂无观测';
  if (m.state !== 'available') return collectionLabels[m.state] ?? '待验证';
  const series = latest(m);
  const valid = series.filter(s => s.bucket?.value && ['good', 'partial'].includes(s.bucket.quality.status));
  if (id === 'network.interface.oper_up') {
    const online = valid.filter(s => String(s.bucket!.value!.value) === '1').length;
    const offline = valid.filter(s => String(s.bucket!.value!.value) === '0').length;
    return `已观测接口：在线 ${online} / ${series.length}，离线 ${offline}，未知 ${series.length - online - offline}（运行状态）`;
  }
  if (id === 'host.network.bytes_total') {
    const rates = valid.filter(s => ['By/s', 'bytes/s', 'B/s'].includes(s.bucket!.unit));
    return rates.length ? `查看 ${rates.length} 条接口方向速率` : '等待速率计算';
  }
  if (series.length > 1) return `查看 ${series.length} 个挂载点`;
  const b = valid[0]?.bucket;
  if (!b?.value || b.value.value === undefined) return '暂无有效值';
  let value = `${b.value.value} ${b.unit}`;
  if (id === 'db.uptime_seconds' && Number.isSafeInteger(Number(b.value.value))) {
    const seconds = Number(b.value.value);
    value = `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时`;
  }
  return `${value}${b.freshness === 'stale' ? ' · 已过期' : ''}${b.quality.status === 'partial' ? ' · 部分缺失' : ''}`;
}

export function diskSummary(result: SemanticResult | undefined): string {
  const used = result?.metrics.find(m => m.definition.id === 'host.filesystem.used_bytes');
  const size = result?.metrics.find(m => m.definition.id === 'host.filesystem.size_bytes');
  if (!used || used.state !== 'available' || !size || size.state !== 'available') return metricSummary(result, 'host.filesystem.used_bytes');
  const key = (dimensions: Record<string, string>) => JSON.stringify(Object.entries(dimensions).sort(([a], [b]) => a.localeCompare(b)));
  const ratios = latest(used).flatMap(u => {
    const s = latest(size).find(s => key(s.dimensions) === key(u.dimensions));
    const a = u.bucket, b = s?.bucket;
    if (!a?.value || !b?.value || a.quality.status !== 'good' || b.quality.status !== 'good'
      || a.freshness !== 'fresh' || b.freshness !== 'fresh' || a.unit !== 'By' || b.unit !== 'By'
      || a.window.from !== b.window.from || a.window.to !== b.window.to) return [];
    const occupied = Number(a.value.value), total = Number(b.value.value);
    if (!Number.isSafeInteger(occupied) || !Number.isSafeInteger(total) || occupied < 0 || total <= 0 || occupied > total) return [];
    return [{ ratio: occupied / total, mount: u.dimensions.mount ?? '未知挂载点' }];
  });
  // A partial set cannot establish the maximum for the observed filesystem scope.
  if (!ratios.length || ratios.length !== used.series.length || used.series.length !== size.series.length) return `查看 ${used.series.length} 个挂载点（缺少同窗口完整容量）`;
  const highest = ratios.sort((a, b) => b.ratio - a.ratio)[0];
  return `最高 ${(highest.ratio * 100).toFixed(1)}% · ${highest.mount}（已观测 ${ratios.length} 个挂载点）`;
}
