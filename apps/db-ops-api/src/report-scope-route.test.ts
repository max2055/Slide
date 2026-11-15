import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { getAccessibleInstanceIds } from './auth/require-instance-access.js';
import { canReadResource } from './resources/resource-service.js';
import { assertReportTarget } from './report-target.js';

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
describe('MAX-618 production stats route resource boundaries', () => {
  it.each([
    [{ permissions: ['report:view'], instanceScopes: {} }, [], []],
    [{ permissions: ['report:view', 'servers:view'], instanceScopes: { 4: 'read-only' } }, [4], null],
    [{ permissions: ['*'], instanceScopes: {} }, null, null],
    [{ permissions: ['servers:view'], instanceScopes: { 4: 'read-only', 5: 'read-only' }, resourceBoundary: { instanceIds: [4], serverIds: [9], networkDeviceIds: [] } }, [4], [9]],
    [{ permissions: [], instanceScopes: {}, resourceBoundary: { instanceIds: [], serverIds: [9], networkDeviceIds: [] } }, [], []],
  ])('passes both server-owned scopes to SQL: %j', async (actor, instanceIds, serverIds) => {
    const start = source.indexOf("  fastify.get('/api/reports/stats'");
    const end = source.indexOf('  // 获取报表列表', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const service = { getReportStats: vi.fn(async () => ({total:0,completed:0,running:0,failed:0})) };
    const app = Fastify();
    new Function('fastify','verifyToken','requirePermission','reportDatabaseService','getAccessibleInstanceIds','canReadResource', code)(
      app, async (req: any) => { req.user = actor; }, () => async () => {}, service, getAccessibleInstanceIds, canReadResource,
    );
    try {
      expect((await app.inject({method:'GET', url:'/api/reports/stats'})).statusCode).toBe(200);
      expect(service.getReportStats).toHaveBeenCalledExactlyOnceWith(instanceIds, serverIds);
    } finally { await app.close(); }
  });
});
describe('MAX-621 scheduled target validation', () => {
  it.each(['701', 0, -1, 1.5, NaN, Infinity, null, undefined, true, [], {}])('rejects malformed server id %j', server_id => {
    expect(() => assertReportTarget({type:'server_health',server_id})).toThrow('REPORT_CONFIG_SERVER_TARGET_INVALID');
  });
  it.each(['health','performance','slow_query','capacity'])('accepts exactly one instance for %s', type => {
    expect(() => assertReportTarget({type,instance_id:701})).not.toThrow();
    expect(() => assertReportTarget({type,server_id:701})).toThrow('REPORT_CONFIG_INSTANCE_TARGET_INVALID');
  });
});
