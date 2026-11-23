import { html, nothing, type TemplateResult } from 'lit';
import { formatDurationCompact } from '../../src/infra/format-time/format-duration.js';
import { showToast } from './app-toast-container.js';
import { formatDatabaseBytes } from './resource-metric-summary.js';
import type { MetricValue } from './semantic-metrics.js';

const connections = new Set(['mysql.connections.limit', 'mysql.threads.connected']);
const sessions = new Set(['mysql.processlist.count', 'custom.mysql.processlist_connections']);
const events = new Set([
  'mysql.queries.total', 'mysql.slow_queries.total', 'mysql.innodb.deadlocks_total',
  'mysql.transaction_commands.commit_total', 'mysql.transaction_commands.rollback_total',
  'mysql.handler.read_next_total', 'mysql.connections.aborted_total', 'custom.mysql.slow_queries_snapshot',
]);

const rateFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const smallRateFormat = new Intl.NumberFormat('zh-CN', { notation: 'scientific', maximumSignificantDigits: 3 });
const rate = (value: number) => value !== 0 && Math.abs(value) < 0.01
  ? smallRateFormat.format(value) : rateFormat.format(value);
function scaledBytes(value: number, suffix = '') {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let index = 0;
  while (Math.abs(value) >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${rate(value)} ${units[index]}${suffix}`;
}

export function metricValueText(value: number | string, unit: string, id: string): string {
  const labels: Record<string, string> = { s: '秒', ms: '毫秒', By: 'B', count: '计数', 'count/s': '次/秒' };
  const original = unit && unit !== '1' ? `${value} ${labels[unit] ?? unit}` : String(value);
  const bytes = unit === 'By' ? formatDatabaseBytes(value) : null;
  if (bytes) return bytes;
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) return original;
  switch (unit) {
    case 's': {
      if (number < 1 || !Number.isSafeInteger(Math.round(number * 1000))) return `${value} 秒`;
      const durationUnits: Record<string, string> = { d: '天', h: '小时', m: '分钟', s: '秒' };
      return formatDurationCompact(number * 1000, { spaced: true })!
        .replace(/(\d+)([dhms])/g, (_, amount, suffix) => `${amount} ${durationUnits[suffix]}`);
    }
    case 'count':
      return connections.has(id) ? `${value} 个连接` : sessions.has(id) ? `${value} 个会话`
        : events.has(id) ? `${value} 次` : original;
    case 'count/s': return `${rate(number)} 次/秒`;
    case 'bit/s': return `${rate(number)} bit/s`;
    case 'By': return number >= 0 ? scaledBytes(number) : original;
    case 'By/s': return scaledBytes(number, '/s');
    default: return original;
  }
}

export function renderMetricReading(value: MetricValue | null | undefined, unit: string, id: string, missing = '缺口') {
  const reading = value && value.value !== undefined
    ? metricValueText(value.value, unit, id)
    : value ? `${value.encoding} 记录` : missing;
  return html`<strong class="metric-reading">${reading}</strong>`;
}

export function renderMetricEvidence(
  definition: { id: string; semantic_version?: string; unit: string },
  dimensions: Record<string, string>,
  sample?: { value: MetricValue | null; unit: string; sources?: unknown[] },
  details: Record<string, unknown> = {},
  options?: { onOpen: () => void; status: TemplateResult | typeof nothing },
) {
  const evidence = JSON.stringify({
    metric: definition.id, semantic_version: definition.semantic_version ?? null, dimensions,
    unit: sample?.unit ?? definition.unit, value: sample?.value ?? null, ...details,
    ...(sample?.sources ? { sources: sample.sources } : {}),
  }, null, 2);
  return html`<details class="metric-evidence" @toggle=${options ? (event: Event) => {
    if ((event.currentTarget as HTMLDetailsElement).open) options.onOpen();
  } : nothing}><summary>原始值与来源</summary>
    ${options?.status ?? nothing}
    <button class="btn-ghost btn-sm" @click=${async () => {
      try { await navigator.clipboard.writeText(evidence); showToast('已复制指标证据', 'success'); }
      catch { showToast('复制失败，可选择下方内容手动复制', 'error'); }
    }}>复制证据</button>
    <pre>${evidence}</pre></details>`;
}

export const metricDimensionText = (dimensions: Record<string, string>) =>
  Object.entries(dimensions).map(([key, value]) => `${key}=${value}`).join(' / ');

export const metricPurpose = (definition: { id: string; unit: string }) => {
  if (definition.id.includes('uptime')) return '运行时长';
  if (definition.unit === 'By') return '存储与字节';
  if (definition.unit.endsWith('/s')) return '速率';
  if (definition.unit === 'count') return '数量';
  return '其他读数';
};
