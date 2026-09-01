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

describe('server metrics API dimension contract', () => {
  it.each([
    ['summary', summaryRoute, 'GROUP BY server_id, metric_name'],
    ['latest', latestRoute, 'GROUP BY metric_name'],
  ])('%s returns every mount from only the latest metric snapshot', (_name, route, groupBy) => {
    expect(route).toContain('sm.dimensions');
    expect(route).toContain('MAX(recorded_at) AS max_time');
    expect(route).toContain(groupBy);
    expect(route).toContain('sm.recorded_at = latest.max_time');
    expect(route).not.toContain('JSON_CONTAINS');
    expect(route).not.toMatch(/GROUP BY[^\n]*dimensions/);
  });

  it('history returns dimensions in deterministic order and uses a valid fixed interval', () => {
    expect(historyRoute).toContain('dimensions');
    expect(historyRoute).toContain('ORDER BY recorded_at ASC, id ASC');
    expect(historyRoute).toContain('ORDER BY recorded_at DESC, id DESC');
    expect(historyRoute).toContain('const historyLimit = 30_000');
    expect(historyRoute).toContain('truncated');
    expect(historyRoute).toContain('DATE_SUB(NOW(), INTERVAL ? HOUR)');
    expect(historyRoute).toContain("'1h': 1");
    expect(historyRoute).toContain("'30d': 720");
  });

  it.each([
    ['summary', summaryRoute],
    ['latest', latestRoute],
  ])('%s reports the maximum response timestamp instead of the first sorted row', (_name, route) => {
    expect(source).toContain('const latestServerMetricRecordedAt =');
    expect(route).toContain('latestServerMetricRecordedAt(rows)');
    expect(route).not.toContain('rows[0].recorded_at');
  });
});
