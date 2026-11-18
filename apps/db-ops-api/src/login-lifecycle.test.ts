import { readFileSync } from 'node:fs';
import ts from 'typescript';
import Fastify from 'fastify';
import { it, expect } from 'vitest';
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
      signAccessToken: () => 'synthetic-token', JWT_SECRET: 'synthetic', JWT_EXPIRES_IN: '1h',
      authSessionConfigService: { get: async () => ({}), expiresAt: () => new Date() },
      PlatformUnavailableError, platformUnavailableResponse, console: { error: () => {} },
    };
    new Function(...Object.keys(deps), compiled)(...Object.values(deps));
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const r = await fetch(app.listeningOrigin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(r.status).toBe(({ success: 200, error: 500, unavailable: 503, 'missing-user': 401, password: 401, empty: 400, body: 400 } as any)[scenario]);
      const body = await r.json();
      if (scenario === 'success') expect(body).toMatchObject({ token: 'synthetic-token', refreshToken: 'synthetic-refresh', expiresIn: 3600, user: { id: 1, username: 'synthetic' } });
      else expect(body).toHaveProperty('error');
    } finally { await app.close(); }
  });
}
