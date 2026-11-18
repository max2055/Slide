import { readFileSync } from 'node:fs';
import Fastify, { type FastifyRequest } from 'fastify';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { ActorAuthenticationError, actorContextService, type ActorContext } from './auth/actor-context.js';
import { hasInstanceAccess } from './auth/require-instance-access.js';
import { requirePermission } from './auth/require-permission.js';
import { registerChatRoutes } from './chat-routes.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { PlatformUnavailableError } from './lifecycle/platform-unavailable.js';
import { registerResourceIdentityRoutes } from './resources/resource-identity-routes.js';
import { registerHttpSecurity } from './security/http-security.js';
import * as publicDto from './security/public-dto.js';
import { strictBody } from './utils/strict-body.js';

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');

// Run the actual inline server registrations without starting its workers.
function registerInline(deps: Record<string, unknown>, ...starts: string[]) {
  const statements = starts.map(start => {
    const offset = source.indexOf(start);
    const end = source.indexOf('\n  }', offset + start.length);
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

afterEach(() => vi.restoreAllMocks());

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
