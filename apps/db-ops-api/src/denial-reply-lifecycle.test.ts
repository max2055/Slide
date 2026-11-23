import { randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import mysql from 'mysql2/promise';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { assertCreatableDatabaseType } from './adapters/capability-matrix.js';
import { alertDatabaseService } from './alert-database-service.js';
import { registerAlertListRoute } from './alert-list-route.js';
import { createVerifyToken } from './auth-middleware.js';
import { ActorAuthenticationError, actorContextService, type ActorContext } from './auth/actor-context.js';
import { rbacApiRoutes } from './auth/rbac-api.js';
import { RbacService } from './auth/rbac-service.js';
import { getAccessibleInstanceIds, hasInstanceAccess, requireInstanceAccess } from './auth/require-instance-access.js';
import { requirePermission } from './auth/require-permission.js';
import { registerChatRoutes } from './chat-routes.js';
import { databaseLogService } from './database-log-service.js';
import { dbConnection } from './db-connection.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { PlatformUnavailableError } from './lifecycle/platform-unavailable.js';
import { validateNotificationChannelConfig } from './notification-channel-config.js';
import { publicLLMProvider } from './llm/public-provider.js';
import { instanceAccessLifecycle } from './resources/instance-access-lifecycle.js';
import { registerResourceIdentityRoutes } from './resources/resource-identity-routes.js';
import { getReportAccessScope } from './report-access.js';
import { reportDatabaseService } from './report-database-service.js';
import { schemaDatabaseService, type TableSchemaRow } from './schema-database-service.js';
import { schemaService } from './schema-service.js';
import { registerHttpSecurity, sensitiveOperationRateLimitConfig } from './security/http-security.js';
import * as publicDto from './security/public-dto.js';
import { serverDatabaseService, type ServerRow } from './server-database-service.js';
import { strictBody, warnUnknown } from './utils/strict-body.js';

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');

// Run the actual inline server registrations without starting its workers.
function registerInline(deps: Record<string, unknown>, ...starts: string[]) {
  const statements = starts.map(start => {
    const offset = source.indexOf(start);
    const closing = start.startsWith('  async function ') ? '\n  }' : '\n  });';
    const end = source.indexOf(closing, offset + start.length);
    if (offset < 0 || end < 0) throw new Error(`Missing server registration: ${start}`);
    return source.slice(offset, source.indexOf('\n', end + 1));
  });
  const { outputText } = ts.transpileModule(statements.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  new Function(...Object.keys(deps), outputText)(...Object.values(deps));
}

const actor: ActorContext = {
  userId: 1, username: 'fixture', roles: [],
  permissions: ['approval:view', 'approval:approve', 'instance:view'],
  instanceScopes: { 25: 'read-only' }, sessionVersion: 1, requestId: 'fixture',
};
const verifyToken = async (request: FastifyRequest) => { Object.assign(request, { user: actor }); };

async function setup() {
  const fastify = Fastify();
  const send = vi.fn();
  fastify.addHook('onRequest', async (_request, reply) => {
    const original = reply.send.bind(reply);
    reply.send = (payload) => { send(payload); return original(payload); };
  });
  registerInline({ fastify, recovery: { degrade: vi.fn() } }, "  fastify.addHook('onSend'");
  await registerHttpSecurity(fastify, { NODE_ENV: 'test' });
  await registerChatRoutes(fastify, {
    verifyToken,
    service: {} as Parameters<typeof registerChatRoutes>[1]['service'],
    handleChatSend: vi.fn(),
  });
  return { fastify, send };
}

async function withBoundedHttp(fastify: FastifyInstance, run: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]);
  const failures: unknown[] = [];
  try {
    await run(signal);
  } catch (error) {
    failures.push(error);
  } finally {
    controller.abort();
    try {
      await fastify.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 1) throw new AggregateError(failures, 'HTTP regression and fixture cleanup both failed');
  if (failures.length === 1) throw failures[0];
}

afterEach(() => vi.restoreAllMocks());

const alertPage = { items: [], total: 0, unread: 0, critical: 0, warning: 0, resolved: 0, level_counts: {} };

it.each([
  ['/api/version', { version: 'test-version' }],
  ['/api/branding/config', { cli_name: 'slide' }],
  ['/api/user/preferences', { preferences: { theme: 'light' } }],
  ['/api/agents', {
    defaultId: 'slide-db-ops', mainKey: 'main', scope: 'default',
    agents: [{ id: 'slide-db-ops', name: 'Slide', identity: { name: 'Slide', avatarUrl: '' } }],
    capabilities: {},
  }],
  ['/api/reports', []],
  ['/api/reports/stats', { total: 0 }],
  ['/api/reports/configs', []],
  ['/api/notification/channels', []],
  ['/api/v1/rbac/roles', []],
  ['/api/llm/configs', []],
  ['/api/alerts', alertPage],
  ['/api/logs', { logs: [{ id: 9, source: 'mysql_error', message: 'fixture log' }], total: 1 }, '/api/logs?instanceId=25'],
  ['/api/logs/stats', { total: 1 }, '/api/logs/stats?instanceId=25'],
  ['/api/ai/analysis', [{ id: 1, related_id: 2, status: 'completed', trigger_type: 'manual' }], '/api/ai/analysis?analysis_type=alert_rca&limit=500'],
  ['/api/models', [{ id: 'fixture-model', name: 'fixture-model', provider: 'fixture', reasoning: false }]],
  ['/api/schema/snapshots/:instanceId', [], '/api/schema/snapshots/25'],
  ['/api/schema/snapshot/:instanceId', { tables: [] }, '/api/schema/snapshot/25'],
  ['/api/schema/changes/:instanceId', { changes: [] }, '/api/schema/changes/25'],
  ['/api/ai/config', { enabled: false }],
  ['/api/scoring/config', { cpu: 1 }],
  ['/api/users', []],
  ['/api/v1/rbac/permissions', []],
] as const)('completes GET %s with one JSON response', async (path, expected, requestPath?: string) => {
  const { fastify, send } = await setup();
  const verifyAdmin = async (request: FastifyRequest) => {
    Object.assign(request, { user: { ...actor, permissions: ['*'] } });
  };
  await withBoundedHttp(fastify, async signal => {
    if (path === '/api/v1/rbac/roles' || path === '/api/v1/rbac/permissions') {
      const method = path === '/api/v1/rbac/roles' ? 'listRoles' : 'listPermissions';
      vi.spyOn(RbacService.prototype, method).mockResolvedValue([]);
      fastify.decorate('verifyToken', verifyAdmin);
      await fastify.register(rbacApiRoutes);
    } else if (path === '/api/alerts') {
      vi.spyOn(alertDatabaseService, 'getAlerts').mockResolvedValue(alertPage);
      vi.spyOn(actorContextService, 'revalidateActor').mockResolvedValue({ ...actor, permissions: ['*'] });
      await registerAlertListRoute(fastify, verifyAdmin);
    } else {
      registerInline({
        fastify, verifyToken: verifyAdmin, requirePermission, getReportAccessScope,
        getAccessibleInstanceIds, requireInstanceAccess, hasInstanceAccess, publicLLMProvider,
        publicNotificationDto: publicDto.publicNotificationDto,
        dbConnection: { getPool: () => ({ query: async () => [[{ config_key: 'slide_version', config_value: 'test-version' }]] }) },
        brandingConfigService: { getBranding: async () => ({ cli_name: 'slide' }) },
        databaseLogService: {
          getLogs: async () => ({ logs: [{ id: 9, source: 'mysql_error', message: 'fixture log' }], total: 1 }),
          getLogsStats: async () => ({ total: 1 }),
        },
        userPreferenceService: { getPreferences: async () => ({ theme: 'light' }) },
        getAgentEngine: async () => ({ capabilities: () => ({ features: {} }) }),
        reportDatabaseService: { getReportsByFilters: async () => [], getReportStats: async () => ({ total: 0 }) },
        reportConfigService: { getConfigs: async () => [] },
        notificationDatabaseService: { getChannels: async () => [] },
        llmDatabaseService: {
          getAllProviders: async () => [],
          getEnabledProviders: async () => [{ name: 'fixture', default_model: 'fixture-model' }],
        },
        aiAnalysisDatabaseService: {
          getAnalysisList: async () => [{ id: 1, related_id: 2, status: 'completed', trigger_type: 'manual' }],
        },
        aiAnalysisConfigService: { getConfig: async () => ({ enabled: false }) },
        scoringConfigService: { getWeights: async () => ({ cpu: 1 }) },
        authDatabaseService: { getAllUsers: async () => [] },
        schemaDatabaseService: { getSnapshotTimes: async () => [], getTableList: async () => [] },
        schemaService: { detectChanges: async () => [] },
      }, `  fastify.get('${path}'`);
    }
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${fastify.listeningOrigin}${requestPath ?? path}`, { signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual(expected);
    expect(send).toHaveBeenCalledExactlyOnceWith(expected);
  });
});

it.each([
  ['created', 200, { id: 42, message: '创建成功' }],
  ['rejected', 400, { error: 'NOTIFICATION_CHANNEL_CREATE_FAILED' }],
  ['exception', 500, { error: 'INTERNAL_ERROR' }],
] as const)('MAX-731 notification creation completes one JSON reply when %s', async (outcome, status, body) => {
  const { fastify, send } = await setup();
  fastify.addHook('preSerialization', async (_request, _reply, payload) => {
    await new Promise<void>(resolve => setImmediate(resolve));
    return payload;
  });
  const createChannel = vi.fn(async () => {
    if (outcome === 'exception') throw new Error('synthetic private storage diagnostic');
    return outcome === 'created'
      ? { success: true, channelId: 42 }
      : { success: false, error: 'NOTIFICATION_CHANNEL_CREATE_FAILED' };
  });
  registerInline({
    fastify, requirePermission, validateNotificationChannelConfig,
    notificationDatabaseService: { createChannel },
    verifyToken: async (request: FastifyRequest) => {
      Object.assign(request, { user: { ...actor, permissions: ['admin:*'] } });
    },
  }, "  fastify.post('/api/notification/channels',");
  await withBoundedHttp(fastify, async signal => {
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(fastify.listeningOrigin + '/api/notification/channels', {
      method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '邮件告警', type: 'email', config: {
        smtp_host: 'smtp.example.test', smtp_port: 587, smtp_username: 'fixture',
        password: randomUUID(), from: 'sender@example.test', to: 'recipient@example.test',
      } }),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual(body);
    expect(send).toHaveBeenCalledExactlyOnceWith(body);
    expect(createChannel).toHaveBeenCalledTimes(1);
  });
});

it.each(['pool unavailable', 'SELECT failure'])('MAX-718 reports recover from %s without false empty results', async failure => {
  const { fastify, send } = await setup();
  registerInline({
    fastify, requirePermission, getReportAccessScope, reportDatabaseService,
    verifyToken: async (request: FastifyRequest) => {
      Object.assign(request, { user: { ...actor, permissions: ['report:view'] } });
    },
  }, "  fastify.get('/api/reports',", "  fastify.get('/api/reports/:id',");
  const report = {
    id: 718, instance_id: 25, name: '合成数据库报告', status: 'completed',
    format: 'html', content: '<p>合成报表正文</p>', data: null,
  };
  const pool = {
    query: vi.fn().mockResolvedValue([[]]),
    execute: vi.fn()
      .mockResolvedValueOnce([[report]])
      .mockResolvedValueOnce([[{ ...report, content: null }]])
      .mockResolvedValueOnce([[]]),
  } as unknown as NonNullable<ReturnType<typeof dbConnection.getPool>>;
  const getPool = vi.spyOn(dbConnection, 'getPool').mockReturnValue(failure === 'pool unavailable' ? null : {
    query: async () => { throw Error('private SQL diagnostics'); },
    execute: async () => { throw Error('private SQL diagnostics'); },
  } as unknown as typeof pool);

  await withBoundedHttp(fastify, async signal => {
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const get = (path: string) => fetch(fastify.listeningOrigin + path, { signal });
    const listFailure = await get('/api/reports');
    expect(listFailure.status).toBe(503);
    expect(await listFailure.json()).toEqual({ error: 'REPORT_LIST_UNAVAILABLE' });
    const detailFailure = await get('/api/reports/718');
    expect(detailFailure.status).toBe(503);
    expect(await detailFailure.json()).toEqual({ error: 'REPORT_DETAIL_UNAVAILABLE' });

    getPool.mockReturnValue(pool);
    const detail = await get('/api/reports/718');
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(report);
    const noContent = await get('/api/reports/718');
    expect(noContent.status).toBe(200);
    expect(await noContent.json()).toEqual({ ...report, content: null });
    const invisible = await get('/api/reports/718');
    expect(invisible.status).toBe(404);
    expect(await invisible.json()).toEqual({ error: '报表不存在' });
    const empty = await get('/api/reports');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(6);
  });
});

it('MAX-717 separates log list and statistics failures from success and recovers on the same routes', async () => {
  const { fastify } = await setup();
  registerInline({
    fastify, requirePermission, hasInstanceAccess, databaseLogService,
    verifyToken: async (request: FastifyRequest) => {
      Object.assign(request, { user: { ...actor, permissions: ['log:view'] } });
    },
  }, "  fastify.get('/api/logs',", "  fastify.get('/api/logs/stats',");
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const execute = vi.fn();
  const pool = { execute } as unknown as NonNullable<ReturnType<typeof dbConnection.getPool>>;
  const getPool = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
  const log = { id: 1, log_level: 'error', message: '合成日志' };
  const stats = (total: number) => ({
    total, by_level: { info: 0, warning: 0, error: total, critical: 0 }, by_pattern: [], trend: [],
  });
  await withBoundedHttp(fastify, async signal => {
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const list = () => fetch(fastify.listeningOrigin + '/api/logs?instanceId=25', { signal });
    const readStats = () => fetch(fastify.listeningOrigin + '/api/logs/stats?instanceId=25', { signal });
    getPool.mockReturnValue(null);
    const unavailable = await list();
    const failed = [500, { error: 'INTERNAL_ERROR' }];
    expect([unavailable.status, await unavailable.json()]).toEqual(failed);

    getPool.mockReturnValue(pool);
    execute.mockResolvedValueOnce([[{ cnt: 2 }]]).mockRejectedValueOnce(new Error('private SQL diagnostics'));
    const failure = await list();
    expect([failure.status, await failure.json()]).toEqual(failed);
    execute.mockResolvedValueOnce([[{ total: 9, error: 9 }]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
    const availableStats = await readStats();
    expect([availableStats.status, await availableStats.json()]).toEqual([200, stats(9)]);

    execute.mockRejectedValueOnce(new Error('private SQL diagnostics'));
    const statsFailure = await readStats();
    expect([statsFailure.status, await statsFailure.json()]).toEqual(failed);
    execute.mockResolvedValueOnce([[{ cnt: 1 }]]).mockResolvedValueOnce([[log]]);
    const restored = await list();
    expect([restored.status, await restored.json()]).toEqual([200, { logs: [log], total: 1 }]);

    execute.mockResolvedValueOnce([[{ cnt: 0 }]]).mockResolvedValueOnce([[]]);
    const emptyList = await list();
    expect([emptyList.status, await emptyList.json()]).toEqual([200, { logs: [], total: 0 }]);
    execute.mockResolvedValueOnce([[{ total: 0 }]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
    const emptyStats = await readStats();
    expect([emptyStats.status, await emptyStats.json()]).toEqual([200, stats(0)]);
  });
});

it('MAX-717 schema reads distinguish failure, insufficient history, and completed comparisons', async () => {
  const { fastify } = await setup();
  registerInline({
    fastify, requirePermission, requireInstanceAccess, schemaDatabaseService, schemaService,
    verifyToken: async (request: FastifyRequest) => {
      Object.assign(request, { user: { ...actor, permissions: ['schema:view', 'schema:manage'] } });
    },
  }, "  fastify.get('/api/schema/snapshots/:instanceId',", "  fastify.get('/api/schema/snapshot/:instanceId',",
  "  fastify.get('/api/schema/changes/:instanceId',", "  fastify.post('/api/schema/changes/:instanceId',",
  "  fastify.get('/api/schema/table/:instanceId/:tableName',");
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const older = { snapshot_time: new Date('2026-11-20T00:00:00Z'), tables: 1, columns: 1 };
  const newer = { ...older, snapshot_time: new Date('2026-11-21T00:00:00Z') };
  const column: TableSchemaRow = {
    table_name: 'items', column_name: 'id', column_type: 'int', is_nullable: 'NO',
    column_default: null, column_key: 'PRI', extra: '', column_comment: null,
    table_comment: null, table_rows: 0, data_length: null,
  };
  const execute = vi.fn();
  const pool = { execute } as unknown as NonNullable<ReturnType<typeof dbConnection.getPool>>;
  const getPool = vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);
  const hint = '需要至少两次快照才能进行变更检测';
  await withBoundedHttp(fastify, async signal => {
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const read = async (path: string, method = 'GET') => {
      const response = await fetch(fastify.listeningOrigin + '/api/schema/' + path, { method, signal });
      return [response.status, await response.json()];
    };
    const failed = [500, { error: 'INTERNAL_ERROR' }];
    expect(await read('snapshots/25')).toEqual(failed);
    getPool.mockReturnValue(pool);
    execute.mockRejectedValue(new Error('private SQL diagnostics'));
    for (const path of ['snapshots/25', 'snapshot/25', 'changes/25', 'table/25/items']) {
      expect(await read(path)).toEqual(failed);
    }
    expect(await read('changes/25', 'POST')).toEqual(failed);

    execute.mockResolvedValue([[]]);
    expect(await read('snapshots/25')).toEqual([200, []]);
    expect(await read('snapshot/25')).toEqual([200, { tables: [] }]);
    expect(await read('table/25/items')).toEqual([404, { error: '表不存在或暂无快照数据' }]);
    expect(await read('changes/25')).toEqual([200, { changes: [], hint }]);
    execute.mockResolvedValueOnce([[newer]]);
    expect(await read('changes/25')).toEqual([200, { changes: [], hint }]);
    execute.mockResolvedValueOnce([[newer]]);
    expect(await read('changes/25', 'POST')).toEqual([200, { success: true, changes: [], hint }]);

    execute.mockResolvedValueOnce([[newer, older]]).mockResolvedValueOnce([[column]])
      .mockRejectedValueOnce(new Error('private SQL diagnostics'));
    expect(await read('changes/25')).toEqual(failed);
    execute.mockResolvedValueOnce([[newer, older]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[column]]);
    expect(await read('changes/25')).toEqual(failed);
    execute.mockResolvedValueOnce([[newer, older]]).mockResolvedValueOnce([[column]]).mockResolvedValueOnce([[column]]);
    expect(await read('changes/25')).toEqual([200, { changes: [] }]);
    execute.mockResolvedValueOnce([[newer, older]]).mockResolvedValueOnce([[column]])
      .mockResolvedValueOnce([[column, { ...column, column_name: 'new_column' }]]);
    expect(await read('changes/25')).toEqual([200, { changes: [expect.objectContaining({
      type: 'added', target: 'column', table_name: 'items', column_name: 'new_column',
    })] }]);
    execute.mockResolvedValueOnce([[newer, older]]);
    expect(await read('snapshots/25')).toEqual([200, [newer, older].map(row => ({
      ...row, snapshot_time: row.snapshot_time.toISOString(),
    }))]);
    execute.mockResolvedValueOnce([[{
      table_name: 'items', table_comment: null, table_rows: 0, data_length: null,
      column_count: 2, snapshot_time: newer.snapshot_time,
    }]]);
    expect(await read('snapshot/25')).toEqual([200, { tables: [expect.objectContaining({
      table_name: 'items', column_count: 2, data_length: null,
    })] }]);
    execute.mockResolvedValueOnce([[column]]);
    expect(await read('table/25/items')).toEqual([200, [column]]);
  });
});

it.each([
  { permissions: ['*'] },
  { permissions: ['instance:view'] },
  { permissions: [] },
])('returns one JSON permissions response for $permissions', async ({ permissions }) => {
  const { fastify, send } = await setup();
  registerInline({
    fastify,
    verifyToken: async (request: FastifyRequest) => { Object.assign(request, { user: { ...actor, permissions } }); },
  }, "  fastify.get('/api/auth/permissions'");
  await withBoundedHttp(fastify, async signal => {
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${fastify.listeningOrigin}/api/auth/permissions`, { signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual(permissions);
    expect(send).toHaveBeenCalledExactlyOnceWith(permissions);
  });
});

it.each(['/api/servers', '/api/servers/25'])('returns one redacted JSON response for %s', async (path) => {
  const { fastify, send } = await setup();
  const serverActor = { ...actor, permissions: ['servers:view'] };
  const server: ServerRow = {
    id: 25, host: '192.0.2.1', port: 22, label: 'fixture', os_type: 'linux',
    credential_type: 'password', credential_encrypted: 'synthetic ciphertext',
    host_key_fingerprint: null, status: 'online', last_check_at: null,
    collection_enabled: 0, created_at: new Date(0), updated_at: new Date(0),
  };
  vi.spyOn(serverDatabaseService, 'getAllServers').mockResolvedValue([server]);
  vi.spyOn(serverDatabaseService, 'getServerById').mockResolvedValue(server);
  vi.spyOn(serverDatabaseService, 'decryptCredentials').mockReturnValue({ username: 'fixture' });
  vi.spyOn(actorContextService, 'revalidateActor').mockResolvedValue(serverActor);
  await registerResourceIdentityRoutes(fastify, async request => { Object.assign(request, { user: serverActor }); });
  await withBoundedHttp(fastify, async signal => {
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${fastify.listeningOrigin}${path}`, { signal });
    expect(response.status).toBe(200);
    const payload = await response.json();
    const identity = expect.objectContaining({ id: 25, hasCredential: true });
    expect(payload).toEqual(path === '/api/servers' ? [identity] : identity);
    expect(JSON.stringify(payload)).not.toContain('credential_encrypted');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

const connectionTestBody = {
  db_type: 'mysql', host: '192.0.2.1', port: 3306, username: 'fixture', password: 'fixture', database_name: 'fixture_db',
};

it.each([
  { scenario: 'successful connection', status: 200, result: { success: true, message: 'Connection fixture succeeded' } },
  { scenario: 'connection failure', status: 200, result: { success: false, message: '连接失败：DB_TARGET_INVALID_HOST' } },
  { scenario: 'service exception', status: 500, result: null, expected: { error: 'INTERNAL_ERROR' } },
  { scenario: 'unsupported adapter', status: 400, body: { ...connectionTestBody, db_type: 'redis' },
    expected: { error: 'DATABASE_TYPE_UNSUPPORTED:redis' } },
  { scenario: 'unknown request field', status: 400, body: { ...connectionTestBody, instance_id: 25 },
    expected: { error: expect.stringContaining('未知字段: instance_id') } },
  { scenario: 'missing authorization', status: 401, authorization: null, expected: { error: '未提供认证令牌' } },
  { scenario: 'view-only user', status: 403, permissions: ['instance:view'], expected: { error: '权限不足' } },
])('returns one JSON response for database connection testing: $scenario ($status)', async ({
  status, result, expected, body = connectionTestBody, authorization = 'Bearer fixture', permissions = ['instance:manage'],
}) => {
  const { fastify, send } = await setup();
  const authenticateAccessToken = vi.fn(async () => ({ ...actor, permissions }));
  const connection = vi.spyOn(instanceDatabaseService, 'testConnection').mockImplementation(async () => {
    if (!result) throw new Error('fixture service failure');
    return result;
  });
  await withBoundedHttp(fastify, async signal => {
    registerInline({
      fastify, verifyToken: createVerifyToken('test-secret', { authenticateAccessToken }),
      requirePermission, sensitiveOperationRateLimitConfig,
      strictBody, assertCreatableDatabaseType, instanceDatabaseService,
    }, "  fastify.post('/api/database/instances/test-connection'");
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${fastify.listeningOrigin}/api/database/instances/test-connection`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual(expected ?? result);
    expect(send).toHaveBeenCalledTimes(1);
    if (result === undefined) {
      expect(connection).not.toHaveBeenCalled();
    } else {
      const { password } = body;
      expect(connection).toHaveBeenCalledExactlyOnceWith({
        db_type: 'mysql', host: body.host, port: body.port, username: body.username, password,
        database: body.database_name,
      });
    }
  });
});

it.each([
  { scenario: 'registered localhost in development', status: 200, success: true },
  { scenario: 'registered localhost in production', status: 200, production: true, message: '连接失败：DB_TARGET_ADDRESS_DENIED' },
  { scenario: 'unregistered localhost request', status: 200, direct: true, message: '连接失败：DB_TARGET_INVALID_HOST' },
  { scenario: 'registered DNS alias resolving to loopback', status: 200, host: 'db.example', message: '连接失败：DB_TARGET_ADDRESS_DENIED' },
  { scenario: 'missing authorization on registered route', status: 401, unauthenticated: true, error: '未提供认证令牌' },
  { scenario: 'missing manage permission on registered route', status: 403, viewOnly: true, error: '权限不足' },
  { scenario: 'out-of-scope instance', status: 403, outsideScope: true, error: '无权访问该实例' },
  { scenario: 'missing instance', status: 404, missing: true, error: '实例不存在' },
  { scenario: 'removed instance', status: 410, removed: true, error: 'INSTANCE_REMOVED' },
  { scenario: 'instance removal during DNS lookup', status: 410, removeDuringLookup: true, error: 'INSTANCE_REMOVED' },
  { scenario: 'sent a different host', status: 400, override: { host: 'other.test' }, error: expect.stringContaining('未知字段: host') },
  { scenario: 'empty password', status: 400, override: { password: '' }, error: '请输入密码' },
])('enforces the registered connection test boundary: $scenario', async ({
  status, success, message, production, direct, outsideScope, missing, removed, override, error,
  host = 'localhost', unauthenticated, viewOnly, removeDuringLookup,
}) => {
  const { fastify, send } = await setup();
  const { db_type, port, username, database_name } = connectionTestBody;
  const password = randomUUID();
  const metadata = vi.spyOn(instanceDatabaseService, 'getPublicConnectionMetadata').mockResolvedValue(missing ? null : {
    id: 25, name: 'registered fixture', host, db_type: 'mysql', port, username, database_name,
    health_status: 'unknown', environment: 'testing',
  });
  const readPassword = vi.spyOn(instanceDatabaseService, 'getInstancePassword');
  let unavailable = Boolean(removed);
  const lookup = vi.spyOn(dns, 'lookup').mockImplementation((async (_hostname: string, options: { all?: boolean }) => {
    expect(options.all).toBe(true);
    if (removeDuringLookup) unavailable = true;
    return [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }];
  }) as unknown as typeof dns.lookup);
  vi.spyOn(instanceAccessLifecycle, 'assertAvailable').mockImplementation(async () => {
    if (unavailable) throw new Error('INSTANCE_REMOVED');
  });
  const ping = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn();
  const end = vi.fn().mockResolvedValue(undefined);
  const driver = vi.spyOn(mysql, 'createPool').mockReturnValue({
    getConnection: vi.fn().mockResolvedValue({ ping, release }), end,
  } as unknown as ReturnType<typeof mysql.createPool>);
  if (production) vi.stubEnv('NODE_ENV', 'production');
  try {
    await withBoundedHttp(fastify, async signal => {
      const authenticateAccessToken = vi.fn(async () => ({
        ...actor, permissions: [viewOnly ? 'instance:view' : 'instance:manage'],
        instanceScopes: outsideScope ? {} : actor.instanceScopes,
      }));
      registerInline({
        fastify, verifyToken: createVerifyToken('test-secret', { authenticateAccessToken }),
        requirePermission, requireInstanceAccess, sensitiveOperationRateLimitConfig,
        strictBody, assertCreatableDatabaseType, instanceDatabaseService,
      }, "  fastify.post('/api/database/instances/:id/test-connection'", "  fastify.post('/api/database/instances/test-connection'");
      await fastify.listen({ host: '127.0.0.1', port: 0 });
      const prefix = direct ? '' : '/25';
      const response = await fetch(`${fastify.listeningOrigin}/api/database/instances${prefix}/test-connection`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json',
          ...(unauthenticated ? {} : { authorization: 'Bearer fixture' }) },
        body: JSON.stringify(direct ? { ...connectionTestBody, host: 'localhost' } : { password, ...override }),
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await response.json()).toEqual(error !== undefined ? { error } :
        { success: Boolean(success), message: message ?? '连接成功：localhost:3306' });
      expect(send).toHaveBeenCalledTimes(1);
      if (direct || outsideScope || unauthenticated || viewOnly || override) expect(metadata).not.toHaveBeenCalled();
      else expect(metadata).toHaveBeenCalledExactlyOnceWith(25);
      if (removeDuringLookup) expect(lookup).toHaveBeenCalledTimes(1);
      expect(readPassword).not.toHaveBeenCalled();
      if (success) {
        expect(driver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          host: '127.0.0.1', port, user: username, database: database_name, password,
        }));
        expect(ping).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
        expect(end).toHaveBeenCalledTimes(1);
      } else {
        expect(driver).not.toHaveBeenCalled();
      }
    });
  } finally {
    if (production) vi.unstubAllEnvs();
  }
});

it.each([
  { path: '/api/servers', status: 200, result: { success: true, serverId: 25 }, body: { id: 25, message: '创建成功' } },
  { path: '/api/servers', status: 400, result: { success: false, error: 'Duplicate fixture' }, body: { error: 'Duplicate fixture' } },
  { path: '/api/servers/test-connection', status: 200, result: { success: true, message: 'SSH fixture succeeded' }, body: { success: true, message: 'SSH fixture succeeded' } },
])('returns one JSON response for POST $path ($status)', async ({ path, status, result, body }) => {
  const { fastify, send } = await setup();
  const verifyManager = async (request: FastifyRequest) => {
    Object.assign(request, { user: { ...actor, permissions: ['servers:manage'] } });
  };
  const serviceMethod = vi.spyOn(serverDatabaseService, path === '/api/servers' ? 'createServer' : 'testConnection').mockResolvedValue(result);
  await withBoundedHttp(fastify, async signal => {
    registerInline({
      fastify, verifyToken: verifyManager, requirePermission, sensitiveOperationRateLimitConfig,
      warnUnknown, strictBody, serverDatabaseService,
    }, `  fastify.post('${path}'`);
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${fastify.listeningOrigin}${path}`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        host: '192.0.2.1', port: 22, credential_type: 'password', credential_username: 'fixture',
        credential_value: 'fixture', ...(path === '/api/servers' ? { os_type: 'rhel' } : {}),
      }),
    });
    expect(serviceMethod).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

it.each([
  ['POST', '/review', 'missing'], ['GET', '/events', 'missing'],
  ['POST', '/review', 'outside scope'], ['GET', '/events', 'outside scope'],
])('completes %s approval%s denial once (%s)', async (method, path, reason) => {
  const { fastify, send } = await setup();
  const approvalService = {
    getRequestById: vi.fn(async () => reason === 'missing' ? null : { instance_id: 26 }),
    reviewRequest: vi.fn(),
    getApprovalEvents: vi.fn(),
  };
  const checkBody = vi.fn(strictBody);
  registerInline({
    fastify, verifyToken, requirePermission, hasInstanceAccess, approvalService,
    strictBody: checkBody, approvalOperationLifecycle: vi.fn(),
  },
  '  async function requireApprovalAccess',
  "  fastify.post('/api/approval/:id/review'",
  "  fastify.get('/api/approval/:id/events'");
  try {
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${fastify.listeningOrigin}/api/approval/7${path}`, method === 'POST' ? {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reject' }),
    } : { method });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ error: '审批请求不存在' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(approvalService.getRequestById).toHaveBeenCalledExactlyOnceWith(7);
    expect(checkBody).not.toHaveBeenCalled();
    expect(approvalService.reviewRequest).not.toHaveBeenCalled();
    expect(approvalService.getApprovalEvents).not.toHaveBeenCalled();
  } finally { await fastify.close(); }
});

it.each([
  [401, 'AUTHENTICATION_REQUIRED'],
  [403, 'RESOURCE_FORBIDDEN'],
  [503, 'INTERNAL_ERROR'],
] as const)('completes instance recheck denial %i once', async (status, error) => {
  const { fastify, send } = await setup();
  const read = vi.spyOn(instanceDatabaseService, 'getInstanceById').mockResolvedValue({
    id: 25, name: 'protected fixture', environment: 'testing', db_type: 'mysql',
    host: '192.0.2.1', port: 3306, username: 'fixture', password_encrypted: 'synthetic ciphertext',
    database_name: null, connection_string: null, max_connections: 1, connection_timeout_ms: 1000,
    status: 'active', health_score: 0, health_status: 'unknown', last_health_check_at: null,
    tags: null, description: null, created_by: null, created_at: new Date(0), updated_at: new Date(0),
  });
  const revalidate = vi.spyOn(actorContextService, 'revalidateActor').mockImplementation(async () => {
    if (status === 401) throw new ActorAuthenticationError();
    if (status === 503) throw new PlatformUnavailableError();
    return { ...actor, instanceScopes: {} };
  });
  const dto = vi.spyOn(publicDto, 'publicInstanceDto');
  await registerResourceIdentityRoutes(fastify, verifyToken);
  try {
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${fastify.listeningOrigin}/api/database/instances/25`);
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ error });
    expect(send).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledExactlyOnceWith(25);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(dto).not.toHaveBeenCalled();
  } finally { await fastify.close(); }
});

it.each([
  {status:200,result:{success:true},body:{message:'更新成功'}},
  {status:400,result:{success:false,error:'Fixture update rejected'},body:{error:'Fixture update rejected'}},
])('sends server collection update response before Fastify finalizes it (HTTP $status)', async ({status,result,body}) => {
  const {fastify,send} = await setup();
  const authorized = async (request: FastifyRequest) => {
    Object.assign(request,{user:{...actor,permissions:['servers:manage']}});
  };
  const update = vi.spyOn(serverDatabaseService,'updateServer').mockResolvedValue(result);
  registerInline({fastify,verifyToken:authorized,requirePermission,warnUnknown,serverDatabaseService,recordSshTrustRequest:vi.fn()},
    "  fastify.put('/api/servers/:id'");
  await fastify.listen({host:'127.0.0.1',port:0});
  await withBoundedHttp(fastify,async signal => {
    const response = await fetch(fastify.listeningOrigin + '/api/servers/25',{
      method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({collection_enabled:false}),signal,
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(update).toHaveBeenCalledWith(25,{collection_enabled:false});
    expect(send.mock.calls).toEqual([[body]]);
  });
});
