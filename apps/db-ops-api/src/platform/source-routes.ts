import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { credentialReferenceService } from '../security/credential-reference-service.js';
import { sourceManagementService, requireSourceAdmin, requireSourceReader, type SourceManagementService } from './source-management-service.js';

export async function registerSourceRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  service: Pick<SourceManagementService, 'load' | 'save' | 'sync' | 'inspect'> = sourceManagementService) {
  const route = (admin: boolean, action: (request: any) => Promise<unknown>) => async (request: any, reply: any) => {
    try {
      if (!request.user) return reply.code(401).send({ error: 'ACTOR_REQUIRED' });
      if (admin) requireSourceAdmin(request.user); else requireSourceReader(request.user);
      return reply.send(await action(request));
    } catch (error) {
      const raw = error instanceof Error ? error.message : '';
      const code = /^SOURCE_[A-Z_]+$/.test(raw) ? raw : 'SOURCE_UNAVAILABLE';
      const status = /REQUIRED|FORBIDDEN|DENIED/.test(code) ? 403 : /BUSY/.test(code) ? 409 : /INVALID|TOO_LARGE/.test(code) ? 400 : 503;
      return reply.code(status).send({ error: code });
    }
  };
  const options = { preHandler: [verifyToken] };
  app.get('/api/platform/source/config', options, route(false, async request => ({ config: await service.load(request.user) })));
  app.put('/api/platform/source/config', options, route(true, async request => ({ config: await service.save(request.user, request.body) })));
  app.post('/api/platform/source/sync', { ...options, bodyLimit: 20_000 }, route(true, async request => {
    const body = request.body;
    if (!body || typeof body.token !== 'string' || !body.token || body.token.length > 16_384 || Object.keys(body).some(key => key !== 'token')) throw new Error('SOURCE_CREDENTIAL_INVALID');
    const credential = await credentialReferenceService.create(request.user.userId, 'gitlab_source_sync', body.token, 15 * 60_000);
    return service.sync(request.user, credential.ref);
  }));
  app.get('/api/platform/source/manifest', options, route(false, request => service.inspect(request.user, 'manifest')));
  app.get('/api/platform/source/search', options, route(false, request => service.inspect(request.user, 'search', { query: request.query.query })));
  app.get('/api/platform/source/symbol', options, route(false, request => service.inspect(request.user, 'symbol', { name: request.query.name })));
  app.get('/api/platform/source/region', options, route(false, request => service.inspect(request.user, 'read', { path: request.query.path, startLine: Number(request.query.startLine), endLine: Number(request.query.endLine) })));
}
