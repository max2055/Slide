import type { Catalog, RecommendationResult } from './metric-api.js';
import { metricName, packageName, resourceLabels } from './resource-metric-summary.js';

export type Release = Catalog['packages'][number];
export type PackageEvidence = RecommendationResult['packages'][number];
export const packageMetrics = (p: Release) => [...new Set([
  ...(p.package.collectors?.flatMap(c => c.mappings?.map(m => m.metric.id) ?? []) ?? []),
  ...(p.derived?.map(d => d.output.id) ?? []),
])];

// Ordering is only for browsing immutable releases; it does not establish compatibility.
const newestFirst = (a: Release, b: Release) => {
  const [av, ap] = a.package.version.split('-'), [bv, bp] = b.package.version.split('-');
  return bv.localeCompare(av, undefined, { numeric: true })
    || (ap === bp ? 0 : ap === undefined ? -1 : bp === undefined ? 1 : bp.localeCompare(ap, undefined, { numeric: true }));
};
export function packageGroups(packages: Release[], evidence: PackageEvidence[] = []) {
  const groups = new Map<string, Release[]>();
  for (const release of packages) {
    const versions = groups.get(release.package.id) ?? [];
    versions.push(release); groups.set(release.package.id, versions);
  }
  return [...groups].map(([id, releases]) => {
    const versions = [...releases].sort(newestFirst);
    const compatible = versions.filter(p => evidence.some(e => e.release.package.digest === p.package.digest && e.compatibility === 'compatible'));
    const primary = compatible.find(p => evidence.some(e => e.release.package.digest === p.package.digest && e.recommended))
      ?? compatible[0] ?? versions[0];
    return { id, versions, primary, others: versions.filter(p => p !== primary) };
  });
}

const engineNames: Record<string, string> = { mysql: 'MySQL', postgresql: 'PostgreSQL', oracle: 'Oracle', dameng: '达梦', linux: 'Linux', windows: 'Windows' };
export const applicabilityLabel = (attribute: string) => ({ 'db.engine': '数据库引擎', 'db.version': '数据库版本', 'os.family': '操作系统', 'snmp.version': 'SNMP 版本' }[attribute] ?? attribute);
export const scopeLabel = (p: Release) => p.package.applicability?.map(a =>
  `${applicabilityLabel(a.attribute)}：${a.values.map(v => engineNames[v] ?? v).join(' / ')}`).join(' · ')
  || resourceLabels[p.package.resource_type] || p.package.resource_type;

const directoryNames: Record<string, string> = { 'linux.uptime.seconds': '主机运行时长', 'linux.load.one_minute': '一分钟系统负载' };
export const directoryMetricName = (id: string) => directoryNames[id] ?? (metricName(id) === id ? '扩展指标（名称未提供）' : metricName(id));
export function templateName(id: string) {
  const engine = id.replace(/-diagnostics$/, '');
  return id.endsWith('-diagnostics') && engineNames[engine] ? `${engineNames[engine]} 诊断采集` : packageName(id) === id ? '扩展采集模板' : packageName(id);
}
export function packagePurpose(p: Release) {
  if (['mysql-diagnostics', 'postgresql-diagnostics', 'oracle-diagnostics', 'dameng-diagnostics'].includes(p.package.id)
    || p.package.id === 'linux-host' && p.package.version === '1.1.0') return '诊断采集';
  if (['mysql-basic', 'linux-basic', 'linux-host', 'if-mib-basic', 'snmp-standard', 'mysql-representative', 'postgresql-representative', 'oracle-representative', 'dameng-representative'].includes(p.package.id)) return '基础采集';
  return '扩展采集（用途以包说明为准）';
}
export const compatibilityLabel = (e?: PackageEvidence) => !e ? '兼容性待确认'
  : e.compatibility === 'compatible' ? e.recommended ? '此资源推荐 · 已验证兼容' : '与此资源兼容'
    : e.compatibility === 'incompatible' ? '与此资源不兼容' : '资源能力待验证';
