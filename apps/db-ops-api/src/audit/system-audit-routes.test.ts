import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogManager, MemoryAuditLogStore } from './audit-log.js';
import { registerSystemAuditRoutes } from './system-audit-routes.js';

describe('system audit routes', () => {
  let app: FastifyInstance;
  let store: MemoryAuditLogStore;

  beforeEach(async () => {
    app = Fastify();
    store = new MemoryAuditLogStore();
    const manager = new AuditLogManager(store);
    const verifyToken = async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as any).user = {
        userId: 7,
        username: 'alice',
        roles: ['admin'],
        permissions: ['audit:view'],
        sessionVersion: 1,
        instanceScopes: {},
        requestId: String(request.id),
      };
    };

    await registerSystemAuditRoutes(app, verifyToken, manager);
    app.patch('/api/users/:id', { preHandler: verifyToken }, async (_request, reply) => reply.code(204).send());
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('records authenticated state-changing requests without the request body', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/users/42',
      payload: { password: 'must-not-be-recorded' },
      headers: { 'user-agent': 'audit-test' },
    });

    const result = await store.query({ eventType: 'system_operation' });
    expect(result.entries).toEqual([expect.objectContaining({
      username: 'alice',
      action: 'PATCH /api/users/:id',
      resourceType: 'users',
      resourceId: '42',
      result: 'success',
      userAgent: 'audit-test',
    })]);
    expect(JSON.stringify(result.entries)).not.toContain('must-not-be-recorded');
  });

  it('filters records by operation type, time, and keyword', async () => {
    await app.inject({ method: 'PATCH', url: '/api/users/42', payload: { status: 'active' } });
    const response = await app.inject({
      method: 'GET',
      url: `/api/audit/logs?eventType=system_operation&keyword=alice&startTime=${encodeURIComponent(new Date(0).toISOString())}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 1, limit: 25, offset: 0 });
  });

  it('rejects invalid query parameters', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/audit/logs?eventType=unknown&limit=0' });
    expect(response.statusCode).toBe(400);
  });

  it('requires audit view permission', async () => {
    const restricted = Fastify();
    const verifyToken = async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as any).user = { userId: 8, username: 'viewer', permissions: [], roles: [], instanceScopes: {} };
    };
    await registerSystemAuditRoutes(restricted, verifyToken, new AuditLogManager(new MemoryAuditLogStore()));
    await restricted.ready();

    const response = await restricted.inject({ method: 'GET', url: '/api/audit/logs' });
    expect(response.statusCode).toBe(403);
    await restricted.close();
  });
});
