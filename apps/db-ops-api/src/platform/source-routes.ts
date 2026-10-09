import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { expensiveOperationRateLimitConfig } from '../security/http-security.js';
import { sourceManagementService, requireSourceAdmin, requireSourceReader, type SourceManagementService } from './source-management-service.js';

export async function registerSourceRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  service: Pick<SourceManagementService, 'load' | 'save' | 'sync' | 'inspect' | 'credentialStatus' | 'saveCredential' | 'deleteCredential'> = sourceManagementService) {
  const route = (admin: boolean, action: (request: any) => Promise<unknown>) => async (request: any, reply: any) => {
    try {
      if (!request.user) return reply.code(401).send({ error: 'ACTOR_REQUIRED' });
      if (admin) requireSourceAdmin(request.user); else requireSourceReader(request.user);
      return reply.send(await action(request));
    } catch (error) {
      const raw = error instanceof Error ? error.message : '';
      const code = /^SOURCE_[A-Z_]+$/.test(raw) ? raw : 'SOURCE_UNAVAILABLE';
      console.error('[source-route]', code);
      const status = /REPOSITORY_PATH_REQUIRED/.test(code) ? 409 : /REPOSITORY_NOT_FOUND|REF_NOT_FOUND/.test(code) ? 404 : /COMMIT_MISMATCH|CONFIG_CHANGED/.test(code) ? 409 : /REQUIRED|FORBIDDEN|DENIED|PATH_NOT_ALLOWED/.test(code) ? 403 : /RATE_LIMITED/.test(code) ? 429 : /BUSY|UNKNOWN|NOT_CONFIGURED|NOT_SYNCED|UNTRUSTED|POLICY_CHANGED/.test(code) ? 409 : /INVALID|TOO_LARGE/.test(code) ? 400 : 503;
      return reply.code(status).send({ error: code });
    } finally {
      if (request.body && typeof request.body === 'object' && 'token' in request.body) request.body.token = '';
    }
  };
  const options = { preHandler: [verifyToken], config: { rateLimit: expensiveOperationRateLimitConfig } };
  app.get('/api/platform/source/config', options, route(false, async request => {
    const config = await service.load(request.user);
    return { config, credential: await service.credentialStatus(request.user, config) };
  }));
  app.put('/api/platform/source/config', options, route(true, async request => ({ config: await service.save(request.user, request.body) })));
  const credentialBody = (request: any, sync = false) => {
    const body = request.body;
    const token = body?.token === undefined ? '' : body.token;
    if (body && typeof body === 'object') body.token = '';
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof token !== 'string' || token.length > 16_384
      || (body.expectedIdentity !== undefined && (typeof body.expectedIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedIdentity)))
      || (body.retainToken !== undefined && (!sync || typeof body.retainToken !== 'boolean'))
      || Object.keys(body).some(key => !['token', 'expectedIdentity', ...(sync ? ['retainToken'] : [])].includes(key))) throw new Error('SOURCE_CREDENTIAL_INVALID');
    return { token, expectedIdentity: body.expectedIdentity, retainToken: body.retainToken };
  };
  app.put('/api/platform/source/credential', { ...options, bodyLimit: 20_000 }, route(true, async request => {
    const { token, expectedIdentity } = credentialBody(request);
    return service.saveCredential(request.user, token, expectedIdentity);
  }));
  app.delete('/api/platform/source/credential', options, route(true, request => {
    const { token, expectedIdentity } = credentialBody(request);
    if (token) throw new Error('SOURCE_CREDENTIAL_INVALID');
    return service.deleteCredential(request.user, expectedIdentity);
  }));
  app.post('/api/platform/source/sync', { ...options, bodyLimit: 20_000 }, route(true, async request => {
    const { token, expectedIdentity, retainToken } = credentialBody(request, true);
    return expectedIdentity === undefined && retainToken === undefined ? service.sync(request.user, token)
      : service.sync(request.user, token, { expectedIdentity, retainToken });
  }));
  app.get('/api/platform/source/manifest', options, route(false, request => service.inspect(request.user, 'manifest')));
  app.get('/api/platform/source/search', options, route(false, request => service.inspect(request.user, 'search', { query: request.query.query })));
  app.get('/api/platform/source/symbol', options, route(false, request => service.inspect(request.user, 'symbol', { name: request.query.name })));
  app.get('/api/platform/source/region', options, route(false, request => service.inspect(request.user, 'read', { path: request.query.path, startLine: Number(request.query.startLine), endLine: Number(request.query.endLine) })));
}
