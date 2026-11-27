import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { requirePermission } from './auth/require-permission.js';
import { hasInstanceAccess } from './auth/require-instance-access.js';
import { ActorAuthenticationError } from './auth/actor-context.js';
import { PolicyError } from './metrics/policy/model.js';
import { canReadResource } from './resources/resource-service.js';
import { registerHttpSecurity } from './security/http-security.js';
import { dbConnection } from './db-connection.js';
import { getReportAccessScope } from './report-access.js';
import { reportDatabaseService } from './report-database-service.js';
import { reportAttachmentDisposition } from './report-download.js';
import { reportExporter } from './report-exporter.js';
import { reportConfigService, ReportConfigTargetConflictError } from './report-config-database-service.js';
import { assertReportTarget } from './report-target.js';
import { InvalidReportCronError } from './report-cron.js';

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

it('P04 excludes expired reports from history, details, and attachments without expiring legacy rows', async () => {
  const code = ts.transpileModule([
    "get('/api/reports'", "get('/api/reports/:id'", "get('/api/reports/:id/download'", "get('/api/reports/stats'",
  ].map(registration).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const actor = { permissions: ['report:view'], instanceScopes: { 4: 'read-only' } };
  const now = '2026-11-25 12:00:00';
  const row = {
    id: 4, instance_id: 4, name: '可下载报表', type: 'health', format: 'html',
    content: '<p>报表验收正文</p>', data: null, status: 'completed',
    expires_at: null as string | null,
  };
  const visible = (sql: string) => !sql.includes('(r.expires_at IS NULL OR r.expires_at > UTC_TIMESTAMP())')
    || row.expires_at === null || row.expires_at > now;
  const pool = vi.spyOn(dbConnection, 'getPool').mockReturnValue({
    query: async (sql: string) => [visible(sql) ? [row] : []],
    execute: async (sql: string, params: number[]) => {
      if (sql.includes('COUNT(*)')) {
        const n = visible(sql) ? 1 : 0;
        return [[{ total: n, completed: n, running: 0, failed: 0 }]];
      }
      return [params[0] === row.id && visible(sql) ? [row] : []];
    },
  } as unknown as NonNullable<ReturnType<typeof dbConnection.getPool>>);
  const exportReport = vi.spyOn(reportExporter, 'export');
  const app = Fastify();
  new Function('fastify', 'verifyToken', 'requirePermission', 'reportDatabaseService', 'getReportAccessScope',
    'reportExporter', 'reportAttachmentDisposition', code)(
    app, async (req: any) => { req.user = actor; }, requirePermission, reportDatabaseService, getReportAccessScope,
    reportExporter, reportAttachmentDisposition,
  );
  try {
    for (const expiresAt of [null, '2026-11-25 12:00:01']) {
      row.expires_at = expiresAt;
      const download = await app.inject('/api/reports/4/download');
      expect(download.statusCode).toBe(200);
      expect(download.body).toContain(row.content);
      expect(download.headers['content-disposition']).toMatch(/^attachment;/);
      expect((await app.inject('/api/reports/4')).json().content).toBe(row.content);
      expect((await app.inject('/api/reports')).json()).toHaveLength(1);
    }
    const missing = await app.inject('/api/reports/5/download');
    expect(missing.statusCode).toBe(404);
    for (const expiresAt of [now, '2026-11-25 11:59:59']) {
      row.expires_at = expiresAt;
      for (const suffix of ['/download', '/download?format=json', '']) {
        const response = await app.inject(`/api/reports/4${suffix}`);
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual(missing.json());
        expect(response.headers['content-disposition']).toBeUndefined();
      }
      expect((await app.inject('/api/reports')).json()).toEqual([]);
      expect((await app.inject('/api/reports/stats')).json()).toEqual({ total: 0, completed: 0, running: 0, failed: 0 });
    }
    expect(exportReport).toHaveBeenCalledTimes(2);
  } finally {
    exportReport.mockRestore();
    pool.mockRestore();
    await app.close();
  }
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

it('preserves explicit nulls and omitted targets when editing a report plan', async () => {
  const code = ts.transpileModule(registration("put('/api/reports/configs/:id'"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const service = {
    getConfigById: vi.fn(async () => ({ type: 'health', instance_id: 4, server_id: null })),
    updateConfig: vi.fn(async () => true),
  };
  const actor = {
    permissions: ['report:create', 'servers:view'],
    instanceScopes: { 4: 'read-only' },
    resourceBoundary: { instanceIds: [4], serverIds: [9], networkDeviceIds: [] },
  };
  const app = Fastify();
  new Function('fastify', 'verifyToken', 'requirePermission', 'reportConfigService', 'getReportAccessScope',
    'hasInstanceAccess', 'canReadResource', 'assertReportTarget', 'notificationDatabaseService', 'InvalidReportCronError',
    'ReportConfigTargetConflictError', code)(
    app, async (req: any) => { req.user = actor; }, requirePermission, service, getReportAccessScope,
    hasInstanceAccess, canReadResource, assertReportTarget, {}, InvalidReportCronError, ReportConfigTargetConflictError,
  );
  const edit = (payload: object) => app.inject({ method: 'PUT', url: '/api/reports/configs/12', payload });
  const scope = { instanceIds: [4], serverIds: [9] };
  const original = { type: 'health', instance_id: 4, server_id: null };
  try {
    expect((await edit({ name: 'database plan', instance_id: 4, server_id: null })).statusCode).toBe(200);
    expect(service.updateConfig).toHaveBeenLastCalledWith(12, expect.objectContaining({ instance_id: 4, server_id: null }), scope, original);
    expect((await edit({ name: 'metadata only' })).statusCode).toBe(200);
    expect(service.updateConfig).toHaveBeenLastCalledWith(12, expect.objectContaining({ instance_id: undefined, server_id: undefined }), scope, original);
    expect((await edit({ type: 'server_health', instance_id: null, server_id: 9 })).statusCode).toBe(200);
    expect(service.updateConfig).toHaveBeenLastCalledWith(12, expect.objectContaining({ instance_id: null, server_id: 9 }), scope, original);
    expect((await edit({ type: 'server_health', instance_id: null, server_id: 10 })).statusCode).toBe(403);
    expect((await edit({ instance_id: 5, server_id: null })).statusCode).toBe(403);
    expect((await edit({ instance_id: null, server_id: null })).statusCode).toBe(400);
    expect((await edit({ type: 'server_health', instance_id: 4, server_id: 9 })).statusCode).toBe(400);
    expect((await edit({ instance_id: '4', server_id: null })).statusCode).toBe(400);
    expect(service.updateConfig).toHaveBeenCalledTimes(3);
  } finally { await app.close(); }
});

it.each([{ type: 'capacity' }, { instance_id: 5 }])('rejects stale partial update %j after a target transfer', async partial => {
  const code = ts.transpileModule(registration("put('/api/reports/configs/:id'"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const actor = {
    permissions: ['report:create', 'servers:view'],
    instanceScopes: { 4: 'read-only', 5: 'read-only' },
    resourceBoundary: { instanceIds: [4, 5], serverIds: [9], networkDeviceIds: [] },
  };
  const stored = { type: 'health', instance_id: 4 as number | null, server_id: null as number | null, cron: '@daily' };
  let reads = 0;
  let finishRead!: () => void;
  let finishTransfer!: () => void;
  const bothValidated = new Promise<void>(resolve => { finishRead = resolve; });
  const transferStored = new Promise<void>(resolve => { finishTransfer = resolve; });
  const execute = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('SELECT')) {
      const snapshot = { ...stored };
      if (++reads <= 2) {
        if (reads === 2) finishRead();
        await bothValidated;
      }
      return [[snapshot]];
    }
    const columns = sql.slice('UPDATE report_configs SET '.length, sql.indexOf(' WHERE')).split(', ').map(set => set.split(' = ')[0]);
    const transfersTarget = columns.length === 3;
    if (!transfersTarget) await transferStored;
    if (sql.includes('AND type = ? AND instance_id <=> ? AND server_id <=> ?')) {
      const [type, instanceId, serverId] = params.slice(-3);
      if (type !== stored.type || instanceId !== stored.instance_id || serverId !== stored.server_id) return [{ affectedRows: 0 }];
    }
    columns.forEach((column, i) => { Object.assign(stored, { [column]: params[i] }); });
    if (transfersTarget) finishTransfer();
    return [{ affectedRows: 1 }];
  });
  const pool = vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
  const app = Fastify();
  new Function('fastify', 'verifyToken', 'requirePermission', 'reportConfigService', 'getReportAccessScope',
    'hasInstanceAccess', 'canReadResource', 'assertReportTarget', 'notificationDatabaseService', 'InvalidReportCronError',
    'ReportConfigTargetConflictError', code)(
    app, async (req: any) => { req.user = actor; }, requirePermission, reportConfigService, getReportAccessScope,
    hasInstanceAccess, canReadResource, assertReportTarget, {}, InvalidReportCronError, ReportConfigTargetConflictError,
  );
  const edit = (payload: object) => app.inject({ method: 'PUT', url: '/api/reports/configs/12', payload });
  try {
    const [transfer, conflict] = await Promise.all([
      edit({ type: 'server_health', instance_id: null, server_id: 9 }),
      edit(partial),
    ]);
    expect(transfer.statusCode).toBe(200);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'REPORT_CONFIG_TARGET_CONFLICT' });
    expect(stored).toMatchObject({ type: 'server_health', instance_id: null, server_id: 9 });
    const updates = execute.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'));
    expect(updates).toHaveLength(2);
    for (const [sql, params] of updates) {
      expect(sql).toContain('instance_id IN (?, ?)');
      expect(sql).toContain('server_id IN (?)');
      expect(params.slice(-7)).toEqual([12, 4, 5, 9, 'health', 4, null]);
    }
  } finally {
    pool.mockRestore();
    await app.close();
  }
});

it('returns the manual report IDs with the production asynchronous serialization hook', async () => {
  const code = ts.transpileModule([
    registration("post('/api/reports/generate'"),
    registration("post('/api/servers/reports/generate'"),
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const database = { generateReport: vi.fn(async () => ({ id: 21, status: 'completed', name: 'database report' })) };
  const servers = { generateAndPersist: vi.fn(async () => ({ success: true, reportId: 22 })) };
  const actor = { permissions: ['report:create', 'servers:manage'], instanceScopes: { 4: 'read-only' } };
  const app = Fastify();
  await registerHttpSecurity(app, { NODE_ENV: 'test' });
  app.addHook('preSerialization', async (_request, _reply, payload) => {
    await new Promise<void>(resolve => setImmediate(resolve));
    return payload;
  });
  new Function('fastify', 'verifyToken', 'requirePermission', 'hasInstanceAccess',
    'reportService', 'serverReportService', 'ActorAuthenticationError', 'PolicyError', code)(
    app, async (req: any) => { req.user = actor; }, requirePermission, hasInstanceAccess,
    database, servers, ActorAuthenticationError, PolicyError,
  );
  try {
    const db = await app.inject({ method: 'POST', url: '/api/reports/generate', payload: { type: 'health', instanceId: 4 } });
    expect(db.statusCode).toBe(200);
    expect(db.json()).toEqual({ id: 21, status: 'completed', name: 'database report' });
    const server = await app.inject({ method: 'POST', url: '/api/servers/reports/generate', payload: { server_id: 9 } });
    expect(server.statusCode).toBe(200);
    expect(server.json()).toEqual({ reportId: 22, message: '报告生成并持久化成功' });
    expect(database.generateReport).toHaveBeenCalledOnce();
    expect(servers.generateAndPersist).toHaveBeenCalledExactlyOnceWith([9], actor);
    for (const server_id of [0, false, '', '9', -1, 1.5]) {
      const invalid = await app.inject({ method: 'POST', url: '/api/servers/reports/generate', payload: { server_id } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ error: 'SERVER_ID_INVALID' });
    }
    expect(servers.generateAndPersist).toHaveBeenCalledOnce();
    for (const payload of [{}, { server_id: null }]) {
      const all = await app.inject({ method: 'POST', url: '/api/servers/reports/generate', payload });
      expect(all.statusCode).toBe(200);
      expect(servers.generateAndPersist).toHaveBeenLastCalledWith(undefined, actor);
    }
    expect(servers.generateAndPersist).toHaveBeenCalledTimes(3);
    expect((await app.inject({ method: 'POST', url: '/api/reports/generate', payload: { type: 'health', instanceId: 5 } })).statusCode).toBe(403);
    expect(database.generateReport).toHaveBeenCalledOnce();
    actor.permissions = [];
    expect((await app.inject({ method: 'POST', url: '/api/servers/reports/generate', payload: {} })).statusCode).toBe(403);
    expect(servers.generateAndPersist).toHaveBeenCalledTimes(3);
  } finally { await app.close(); }
});
