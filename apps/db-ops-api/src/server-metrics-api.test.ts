import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../server.ts'), 'utf8');

function routeSource(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Route markers not found: ${start}`);
  return source.slice(startIndex, endIndex);
}

const summaryRoute = routeSource(
  "fastify.get('/api/servers/metrics/summary'",
  '// 获取服务器最新指标',
);
const latestRoute = routeSource(
  "fastify.get('/api/servers/:id/metrics'",
  '// 获取服务器指标历史',
);
const historyRoute = routeSource(
  "fastify.get('/api/servers/:id/metrics/history'",
  '// 手动触发单次采集',
);
const instanceLatestRoute = routeSource(
  "fastify.get('/api/database/instances/:id/metrics'",
  '// 获取实例历史指标',
);
const instanceHistoryRoute = routeSource(
  "fastify.get('/api/database/instances/:id/metrics/history'",
  '// 查询性能分析（QAN）',
);

describe('resource metric entrypoints use only the formal service', () => {
  it.each([['summary', summaryRoute], ['latest', latestRoute], ['history', historyRoute]])('%s preserves formal evidence through the shared adapter', (_name, route) => {
    expect(route).toContain('resourceMetricRead');
    expect(route).not.toContain('FROM server_metrics');
  });
  it.each([['latest', instanceLatestRoute], ['history', instanceHistoryRoute]])('%s instance route has no legacy fallback', (_name, route) => {
    expect(route).toContain('metricConsumerService.query');
    expect(route).toContain("source_contract: 'metrics'");
    expect(route).toContain('semantic_metrics');
    expect(route).not.toContain('getRealtimeMetrics');
    expect(route).not.toContain('getHistoricalMetricsWithRange');
  });
});
