import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { transpileModule } from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuditLogEntry, AuditLogQuery } from './audit/audit-log.js';
import { requireInstanceAccess } from './auth/require-instance-access.js';
import { requirePermission } from './auth/require-permission.js';
import { databaseService } from './database-service.js';
import { instanceDatabaseService, type DatabaseInstance } from './instance-database-service.js';
import { registerQueryAnalysisRoutes } from './query-analysis-routes.js';
import { instanceHistoryContext } from './resources/instance-history-context.js';

const audit = vi.fn<(query: AuditLogQuery) => Promise<{ entries: AuditLogEntry[]; total: number }>>();
const instance: DatabaseInstance = {
  id: 25, name: '一号库', environment: 'testing', db_type: 'mysql', host: 'database.example.test',
  port: 3306, username: 'fixture', password_encrypted: '', database_name: null, connection_string: null,
  max_connections: 1, connection_timeout_ms: 1000, status: 'active', lifecycle_state: 'available',
  health_score: 100, health_status: 'healthy', last_health_check_at: null, tags: [],
  description: null, created_by: null, created_at: new Date(0), updated_at: new Date(0),
};
const resource = '/api/database/instances/25';
const authorized = { authorization: 'scoped-reader' };

async function verifyToken(request: FastifyRequest) {
  Object.assign(request, { user: {
    username: 'fixture', permissions: ['instance:view', 'instance:query'],
    instanceScopes: request.headers.authorization === authorized.authorization ? { 25: 'read-only' } : {},
  } });
}

function setup() {
  const app = Fastify();
  const sent = vi.fn();
  app.addHook('onSend', async (_request, _reply, payload) => {
    if (payload !== undefined) await new Promise<void>(resolve => setImmediate(resolve));
    sent(payload);
    return payload;
  });
  vi.spyOn(instanceDatabaseService, 'getInstanceById').mockResolvedValue(instance);
  return { app, sent };
}

function registerHistory(app: FastifyInstance) {
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const start = source.indexOf("  fastify.get('/api/database/instances/:id/query-history',");
  const end = source.indexOf('\n  });', start);
  if (start < 0 || end < 0) throw new Error('Missing query history route registration');
  const { outputText } = transpileModule(source.slice(start, end + '\n  });'.length), {});
  new Function('fastify', 'verifyToken', 'requirePermission', 'requireInstanceAccess',
    'instanceHistoryContext', 'queryAuditLogs', outputText)(
    app, verifyToken, requirePermission, requireInstanceAccess, instanceHistoryContext, audit);
}

afterEach(() => {
  vi.restoreAllMocks();
  audit.mockReset();
});

it('R11 finishes nonempty and empty query analytics JSON through asynchronous onSend', async () => {
  const { app, sent } = setup();
  const rows = [{ fingerprint: 'SELECT ?', sql_text: null, calls: 2, avg_time_ms: 1, max_time_ms: 1, total_time_ms: 2, rows_examined: 0 }];
  const analytics = vi.spyOn(databaseService, 'getQueryAnalytics').mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
  await registerQueryAnalysisRoutes(app, verifyToken);
  const url = resource + '/qan?limit=5';
  try {
    for (const expected of [rows, []]) {
      const response = await app.inject({ url, headers: authorized });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected);
      expect(sent).toHaveBeenLastCalledWith(JSON.stringify(expected));
    }
    expect((await app.inject({ url })).statusCode).toBe(403);
    expect(analytics.mock.calls).toEqual([[25, 5], [25, 5]]);
  } finally { await app.close(); }
});

it('Q04 sends the plan and failures through an asynchronous onSend hook', async () => {
  const { app, sent } = setup();
  const plan = { db_type: 'mysql', plan: { query_block: { select_id: 1 } } };
  const error = { db_type: 'oracle', plan: { error: 'EXPLAIN JSON 不支持此数据库类型: oracle' } };
  const explain = vi.spyOn(databaseService, 'getExplainPlanJson')
    .mockResolvedValueOnce(plan)
    .mockResolvedValueOnce(error)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('fixture timeout'));
  await registerQueryAnalysisRoutes(app, verifyToken);
  const sql = 'SELECT 1';
  const url = resource + '/explain?' + new URLSearchParams({ sql });
  try {
    const loaded = await app.inject({ url, headers: authorized });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.headers['content-type']).toMatch(/^application\/json/);
    expect(loaded.json()).toEqual(plan);
    expect(sent).toHaveBeenCalledExactlyOnceWith(JSON.stringify(plan));

    const unsupported = await app.inject({ url, headers: authorized });
    expect(unsupported.statusCode).toBe(200);
    expect(unsupported.json()).toEqual(error);
    const unavailable = await app.inject({ url, headers: authorized });
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json()).toEqual({ error: '无法获取执行计划，实例可能未连接' });
    const failed = await app.inject({ url, headers: authorized });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: '获取执行计划失败：fixture timeout' });
    const missing = await app.inject({ url: resource + '/explain', headers: authorized });
    expect(missing.statusCode).toBe(400);
    const denied = await app.inject({ url });
    expect(denied.statusCode).toBe(403);
    expect(explain.mock.calls).toEqual(Array.from({ length: 4 }, () => [25, sql]));
  } finally { await app.close(); }
});

it('Q05 preserves scoped paginated history and failure JSON through an asynchronous onSend hook', async () => {
  const { app, sent } = setup();
  registerHistory(app);
  const sql = 'SELECT 1';
  const timestamp = Date.parse('2026-11-25T01:00:00.000Z');
  const details = { sql, instanceName: '一号库', durationMs: 4, rowCount: 1 };
  audit.mockResolvedValueOnce({
    entries: [{ id: '9', eventType: 'sql_execution', level: 'info', action: 'execute',
      resourceId: '25', result: 'success', timestamp, details }],
    total: 6,
  }).mockRejectedValueOnce(new Error('fixture history unavailable'));
  const url = resource + '/query-history?limit=15&offset=2&search=SELECT+1';
  try {
    const response = await app.inject({ url, headers: authorized });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['x-instance-lifecycle-state']).toBe('available');
    const expected = { total: 6, limit: 15, offset: 2,
      items: [{ id: '9', instanceId: '25', status: 'success', timestamp, ...details }] };
    expect(response.json()).toEqual(expected);
    expect(sent).toHaveBeenCalledExactlyOnceWith(JSON.stringify(response.json()));
    const failure = await app.inject({ url, headers: authorized });
    expect(failure.statusCode).toBe(500);
    expect(failure.json()).toEqual({ error: '获取查询历史失败：fixture history unavailable' });
    const denied = await app.inject({ url });
    expect(denied.statusCode).toBe(403);
    const unscoped = await app.inject({ url: '/api/database/instances/0/query-history', headers: authorized });
    expect(unscoped.statusCode).toBe(400);
    const expectedQuery = { eventType: 'sql_execution', limit: 15, offset: 2, search: sql, resourceId: '25' };
    expect(audit.mock.calls).toEqual([[expectedQuery], [expectedQuery]]);
  } finally { await app.close(); }
});
