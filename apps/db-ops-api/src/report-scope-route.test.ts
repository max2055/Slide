import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { requirePermission } from './auth/require-permission.js';
import { getReportAccessScope } from './report-access.js';
import { assertReportTarget } from './report-target.js';

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
function registration(start: string) {
  const offset = source.indexOf(`  fastify.${start}`);
  const end = source.indexOf('\n  });', offset);
  if (offset < 0 || end < 0) throw new Error(`Missing report route: ${start}`);
  return source.slice(offset, end + '\n  });'.length);
}

describe('MAX-687 production report routes share the same resource boundary', () => {
  it.each([
    [{ permissions: ['report:view'], instanceScopes: {} }, [], []],
    [{ permissions: ['report:view', 'servers:view'], instanceScopes: { 4: 'read-only' } }, [4], null],
    [{ permissions: ['*'], instanceScopes: {} }, null, null],
    [{ permissions: ['report:view', 'report:create', 'servers:view'], instanceScopes: { 4: 'read-only', 5: 'read-only' }, resourceBoundary: { instanceIds: [4], serverIds: [9], networkDeviceIds: [] } }, [4], [9]],
    [{ permissions: [], instanceScopes: {}, resourceBoundary: { instanceIds: [], serverIds: [9], networkDeviceIds: [] } }, [], []],
  ])('passes both server-owned scopes to SQL: %j', async (actor, instanceIds, serverIds) => {
    const code = ts.transpileModule(registration("get('/api/reports/stats'"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const service = { getReportStats: vi.fn(async () => ({total:0,completed:0,running:0,failed:0})) };
    const app = Fastify();
    new Function('fastify','verifyToken','requirePermission','reportDatabaseService','getReportAccessScope', code)(
      app, async (req: any) => { req.user = actor; }, () => async () => {}, service, getReportAccessScope,
    );
    try {
      expect((await app.inject({method:'GET', url:'/api/reports/stats'})).statusCode).toBe(200);
      expect(service.getReportStats).toHaveBeenCalledExactlyOnceWith(instanceIds, serverIds);
    } finally { await app.close(); }
  });

  it('uses the current server-owned boundary before returning documents or mutating rows', async () => {
    const statements = [
      "get('/api/reports'", "get('/api/reports/configs'", "get('/api/reports/:id'",
      "get('/api/reports/:id/download'", "get('/api/reports/:id/notifications'",
      "delete('/api/reports/:id'", "delete('/api/reports/configs/:id'",
    ].map(registration).join('\n');
    const { outputText } = ts.transpileModule(statements, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
    const service = {
      getReportsByFilters: vi.fn(async () => []),
      getReportById: vi.fn(async () => null),
      getNotificationDeliveries: vi.fn(),
      deleteReport: vi.fn(async () => false),
      getConfigs: vi.fn(async () => []),
      deleteConfig: vi.fn(async () => false),
    };
    const actor = {
      permissions: ['report:view', 'report:create', 'servers:view'],
      instanceScopes: { 4: 'read-only', 5: 'read-only' },
      resourceBoundary: { instanceIds: [4], serverIds: [9], networkDeviceIds: [] },
    };
    const app = Fastify();
    new Function('fastify', 'verifyToken', 'requirePermission', 'reportDatabaseService', 'reportConfigService', 'getReportAccessScope', outputText)(
      app, async (req: any) => { req.user = actor; }, requirePermission, service, service, getReportAccessScope,
    );
    try {
      const scope = { instanceIds: [4], serverIds: [9] };
      expect((await app.inject('/api/reports?page=2&limit=1')).json()).toEqual([]);
      expect(service.getReportsByFilters).toHaveBeenCalledWith(expect.objectContaining({ offset: 1, limit: 1 }), scope);
      expect((await app.inject('/api/reports/configs')).json()).toEqual([]);
      expect(service.getConfigs).toHaveBeenCalledWith(scope);
      for (const suffix of ['', '/download', '/notifications']) {
        const response = await app.inject(`/api/reports/12${suffix}`);
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: '报表不存在' });
        expect(service.getReportById).toHaveBeenLastCalledWith(12, scope);
      }
      expect(service.getReportById).toHaveBeenCalledTimes(3);
      expect(service.getNotificationDeliveries).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'DELETE', url: '/api/reports/12' })).statusCode).toBe(404);
      expect(service.deleteReport).toHaveBeenCalledWith(12, scope);
      actor.permissions = ['report:view', 'report:create'];
      expect((await app.inject({ method: 'DELETE', url: '/api/reports/configs/12' })).statusCode).toBe(404);
      expect(service.deleteConfig).toHaveBeenCalledWith(12, { ...scope, serverIds: [] });
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
