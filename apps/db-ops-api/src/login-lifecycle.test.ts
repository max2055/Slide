import { readFileSync } from 'node:fs';
import ts from 'typescript';
import Fastify from 'fastify';
import { it, expect } from 'vitest';
import { ActorAuthenticationError } from './auth/actor-context.js';
import { authSessionConfigService } from './auth/session-config.js';
import { PlatformUnavailableError, platformUnavailableResponse } from './lifecycle/platform-unavailable.js';

// Execute the actual server.ts login registration with controlled dependencies.
// Real sockets + async serialization expose reply completion, without booting workers.
const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const registration = source.slice(source.indexOf("  fastify.post('/api/auth/login'"), source.indexOf('  // ========== Refresh Token API'));
for (const scenario of ['success', 'error', 'unavailable', 'missing-user', 'password', 'empty', 'body']) {
  it('MAX-684 login reply completion: ' + scenario, async () => {
    const app = Fastify({ logger: false });
    for (let i = 0; i < 2; i++) app.addHook('preSerialization', async (_q, _r, payload) => payload);
    app.addHook('onSend', async (_q, _r, payload) => payload);
    const compiled = ts.transpileModule(registration, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const deps = {
      fastify: app, createLoginIpRateLimit: () => async () => {}, loginRateLimitConfig: {},
      strictBody: () => scenario === 'body' ? { error: { error: 'invalid' } } : { body: scenario === 'empty' ? {} : { username: 'synthetic', password: 'synthetic' } },
      authDatabaseService: {
        getUserByUsername: async () => {
          if (scenario === 'error') throw new Error('synthetic failure');
          if (scenario === 'unavailable') throw new PlatformUnavailableError();
          return scenario === 'missing-user' ? null : { id: 1 };
        },
        verifyPassword: async () => scenario !== 'password',
      },
      auditLogManager: { logLogin: async () => {} },
      actorContextService: { loadActiveActor: async () => ({ userId: 1, username: 'synthetic' }), issueRefreshToken: async () => 'synthetic-refresh' },
      signAccessToken: (_actor: unknown, _secret: string, expiresIn: number) => {
        expect(expiresIn).toBe(240);
        return 'synthetic-token';
      }, JWT_SECRET: 'synthetic',
      authSessionConfigService: { get: async () => ({ idleTimeoutMinutes: 5 }), expiresAt: () => new Date(),
        accessTokenSeconds: authSessionConfigService.accessTokenSeconds.bind(authSessionConfigService) },
      PlatformUnavailableError, platformUnavailableResponse, console: { error: () => {} },
    };
    new Function(...Object.keys(deps), compiled)(...Object.values(deps));
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const r = await fetch(app.listeningOrigin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(r.status).toBe(({ success: 200, error: 500, unavailable: 503, 'missing-user': 401, password: 401, empty: 400, body: 400 } as any)[scenario]);
      const body = await r.json();
      if (scenario === 'success') expect(body).toMatchObject({ token: 'synthetic-token', refreshToken: 'synthetic-refresh', expiresIn: 240, user: { id: 1, username: 'synthetic' } });
      else expect(body).toHaveProperty('error');
    } finally { await app.close(); }
  });
}

it.each([
  ['rotated', 200, { token: 'synthetic-access', refreshToken: 'synthetic-rotated', expiresIn: 3600 }],
  ['rejected', 401, { error: '无效的 refresh token' }],
] as const)('returns complete refresh-token JSON when %s', async (outcome, status, body) => {
  const fastify = Fastify();
  for (let index = 0; index < 2; index++) fastify.addHook('preSerialization', async (_request, _reply, payload) => payload);
  fastify.addHook('onSend', async (_request, _reply, payload) => {
    await new Promise<void>(resolve => setImmediate(resolve));
    return payload;
  });
  const refresh = source.slice(source.indexOf("  fastify.post('/api/auth/refresh'"), source.indexOf('  // ========== 权限查询 API'));
  const compiled = ts.transpileModule(refresh, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const deps = {
    fastify, ActorAuthenticationError, platformUnavailableResponse,
    authSessionConfigService: { get: async () => ({ idleTimeoutMinutes: 10080 }), expiresAt: () => new Date(),
      accessTokenSeconds: authSessionConfigService.accessTokenSeconds.bind(authSessionConfigService) },
    actorContextService: {
      rotateRefreshToken: async () => {
        if (outcome === 'rejected') throw new ActorAuthenticationError();
        return { actor: { userId: 1 }, refreshToken: 'synthetic-rotated' };
      },
    },
    signAccessToken: (_actor: unknown, _secret: string, expiresIn: number) => {
      expect(expiresIn).toBe(3600);
      return 'synthetic-access';
    }, JWT_SECRET: 'synthetic',
  };
  new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  try {
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(fastify.listeningOrigin + '/api/auth/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'synthetic-original' }), signal: AbortSignal.timeout(3_000),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  } finally { await fastify.close(); }
});
