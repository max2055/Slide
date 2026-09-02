import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../../server.ts'), 'utf8');

function routeBlocks(prefix: string): Array<{ method: string; path: string; block: string }> {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`fastify\\.(get|post|put|delete)\\('(${escaped}[^']*)'`, 'g');
  return [...source.matchAll(pattern)].map((match) => {
    const start = match.index!;
    const next = source.indexOf('\n  fastify.', start + 1);
    return { method: match[1], path: match[2], block: source.slice(start, next === -1 ? source.length : next) };
  });
}

describe('server instance authorization coverage', () => {
  it('requires instance scope on every explicit database instance route', () => {
    const routes = routeBlocks('/api/database/instances/:id');
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes) {
      expect(route.block, route.path).toContain('requireInstanceAccess(');
      expect(route.block, route.path).toContain('requirePermission(');
    }
  });

  it('filters the database instance list by the authenticated actor scope', () => {
    const [route] = routeBlocks('/api/database/instances');
    expect(route.block).toContain("requirePermission('instance:view')");
    expect(route.block).toContain('filterByInstanceAccess((request as any).user, instances');
  });

  it('activates a reloaded instance before collecting and returns the first collection result', () => {
    const [route] = routeBlocks('/api/database/instances/:id/reload');
    const activeAt = route.block.indexOf('instanceDatabaseService.markInstanceActive(Number(id))');
    const collectAt = route.block.indexOf('monitorCollector.collectInstanceNow(Number(id))');

    expect(activeAt).toBeGreaterThan(-1);
    expect(collectAt).toBeGreaterThan(activeAt);
    expect(route.block).toContain("message: '连接已建立，首次采集已完成', collection");
  });

  it('protects alternate instance parameter routes', () => {
    for (const path of [
      '/api/metrics/:instanceId',
      '/api/baseline/:instanceId/:metricName',
      '/api/maintenance-windows/check/:instanceId',
      '/api/sql/audit/instance/:instanceId',
    ]) {
      const [route] = routeBlocks(path);
      expect(route?.block, path).toContain("requireInstanceAccess('read-only')");
    }
  });

  it('checks instance ownership for SQL audit bodies and record lookups', () => {
    expect(source).toContain("hasInstanceAccess((request as any).user, instance_id, 'read-only')");
    expect(source).toContain("hasInstanceAccess((request as any).user, Number(result.instance_id), 'read-only')");
    expect(source).toContain("hasInstanceAccess((request as any).user, Number(analysis.instance_id), 'read-only')");
  });

  it('requires collector management permission and rate limits global capacity collection', () => {
    const [route] = routeBlocks('/api/monitor/collect-capacity');
    expect(route.block).toContain('rateLimit: expensiveOperationRateLimitConfig');
    expect(route.block).toContain("requirePermission('collector:manage')");
    expect(route.block).toContain('requireUnrestrictedInstanceAccess()');
  });

  it('requires unrestricted instance authority for global side-effect operations', () => {
    for (const path of [
      '/api/collector/start',
      '/api/collector/stop',
      '/api/alert-engine/evaluate',
      '/api/baseline/compute',
      '/api/alerts/escalation/check',
      '/api/alerts/aggregate',
    ]) {
      expect(routeBlocks(path)[0]?.block, path).toContain('requireUnrestrictedInstanceAccess()');
    }
  });

  it('scopes aggregate dashboards, report statistics, alerts, and alert events', () => {
    expect(routeBlocks('/api/dashboard/capacity-trend')[0]?.block).toContain('getAccessibleInstanceIds(');
    expect(routeBlocks('/api/dashboard/ai-stats')[0]?.block).toContain('getAccessibleInstanceIds(');
    expect(routeBlocks('/api/reports/stats')[0]?.block).toContain('getAccessibleInstanceIds(');
    expect(routeBlocks('/api/alerts')[0]?.block).toContain('getAccessibleInstanceIds(');
    expect(routeBlocks('/api/alerts/events')[0]?.block).toContain('getAccessibleInstanceIds(');
  });

  it('checks instance ownership before reading or mutating alert event records', () => {
    for (const route of routeBlocks('/api/alerts/events/:id')) {
      expect(route.block, `${route.method} ${route.path}`).toContain('requireAlertEventAccess(');
    }
  });

  it('bounds manual log analysis identifiers', () => {
    const [route] = routeBlocks('/api/logs/analyze');
    expect(route.block).toContain('logIds.length > 100');
    expect(route.block).toContain('Number.isSafeInteger(id)');
  });

  it('scopes maintenance windows and silence records, including ID-based mutations', () => {
    expect(routeBlocks('/api/maintenance-windows')[0]?.block).toContain('getAccessibleInstanceIds(');
    for (const route of routeBlocks('/api/maintenance-windows/:id')) {
      expect(route.block, `${route.method} ${route.path}`).toContain('requireMaintenanceWindowAccess(');
    }
    expect(routeBlocks('/api/silence')[0]?.block).toContain('getAccessibleInstanceIds(');
    expect(routeBlocks('/api/silence/:id')[0]?.block).toContain('getSilenceInstanceId(');
  });

  it('scopes approval lists, details, events, and single or batch review', () => {
    expect(routeBlocks('/api/approval/pending')[0]?.block).toContain('getAccessibleInstanceIds(');
    expect(routeBlocks('/api/approval/history')[0]?.block).toContain('getAccessibleInstanceIds(');
    expect(routeBlocks('/api/approval/batch-review')[0]?.block).toContain('requireApprovalAccess(');
    for (const route of routeBlocks('/api/approval/:id')) {
      expect(route.block, `${route.method} ${route.path}`).toContain('requireApprovalAccess(');
    }
  });

  it('scopes cron job lists and every ID-based operation to the target instance', () => {
    expect(routeBlocks('/api/cron/jobs')[0]?.block).toContain('getAccessibleInstanceIds(');
    for (const route of routeBlocks('/api/cron/jobs/:id')) {
      expect(route.block, `${route.method} ${route.path}`).toContain('requireCronJobAccess(');
    }
  });

  it('validates alert rule instance sets and protects ID-based mutations', () => {
    expect(routeBlocks('/api/alert-rules')[0]?.block).toContain('filterAlertRulesForActor(');
    expect(routeBlocks('/api/alert-rules')[1]?.block).toContain('validateAlertRuleInstanceIds(');
    for (const route of routeBlocks('/api/alert-rules/:id')) {
      expect(route.block, `${route.method} ${route.path}`).toContain('requireAlertRuleAccess(');
    }
  });
});
