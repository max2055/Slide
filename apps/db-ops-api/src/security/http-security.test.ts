import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BODY_LIMIT, loginRateLimitConfig, registerHttpSecurity, resolveCorsOrigins } from './http-security.js';
import { securityEventService } from './security-event-service.js';

async function app() {
  const fastify = Fastify({ bodyLimit: API_BODY_LIMIT });
  await registerHttpSecurity(fastify, { NODE_ENV: 'test', CORS_ORIGINS: 'https://slide.example.com' } as NodeJS.ProcessEnv);
  fastify.post('/login', { config: { rateLimit: loginRateLimitConfig } }, async () => ({ ok: true }));
  fastify.post('/echo', async () => ({ ok: true }));
  fastify.get('/failure', async (_request, reply) => reply.code(500).send({ error: 'password=secret', stack: 'internal' }));
  fastify.get('/sandbox-failure', async (_request, reply) => reply.code(503).send({ reasonCode: 'SANDBOX_NOT_READY', detail: 'hidden' }));
  fastify.get('/sandbox-network-failure', async (_request, reply) => reply.code(503).send({ reasonCode: 'SANDBOX_NETWORK_NOT_READY', detail: 'hidden' }));
  await fastify.ready();
  return fastify;
}

describe('HTTP security boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fails closed when production CORS origins are missing', () => {
    expect(() => resolveCorsOrigins({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow('CORS_ORIGINS_REQUIRED');
  });

  it('sets security headers and enforces the configured CORS origin', async () => {
    const fastify = await app();
    const allowed = await fastify.inject({ method: 'GET', url: '/failure', headers: { origin: 'https://slide.example.com' } });
    expect(allowed.headers['content-security-policy']).toContain("default-src 'self'");
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://slide.example.com');
    const denied = await fastify.inject({ method: 'GET', url: '/failure', headers: { origin: 'https://evil.example.com' } });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    await fastify.close();
  });

  it('replaces all structured 5xx payloads with a public error', async () => {
    const fastify = await app();
    const response = await fastify.inject({ method: 'GET', url: '/failure' });
    expect(response.json()).toEqual({ error: 'INTERNAL_ERROR' });
    expect(response.body).not.toContain('secret');
    await fastify.close();
  });

  it('preserves only allowlisted fail-closed sandbox reason codes', async () => {
    const fastify = await app();
    const response = await fastify.inject({ method: 'GET', url: '/sandbox-failure' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ reasonCode: 'SANDBOX_NOT_READY' });
    expect(response.body).not.toContain('hidden');
    await fastify.close();
  });

  it('preserves the restricted-network readiness reason code', async () => {
    const fastify = await app();
    const response = await fastify.inject({ method: 'GET', url: '/sandbox-network-failure' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ reasonCode: 'SANDBOX_NETWORK_NOT_READY' });
    await fastify.close();
  });

  it('enforces the explicit body limit', async () => {
    const fastify = await app();
    const response = await fastify.inject({ method: 'POST', url: '/echo', payload: { value: 'x'.repeat(API_BODY_LIMIT) } });
    expect(response.statusCode).toBe(413);
    await fastify.close();
  });

  it('rate limits login attempts by IP and normalized username', async () => {
    const record = vi.spyOn(securityEventService, 'record').mockResolvedValue();
    const fastify = await app();
    const statuses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await fastify.inject({ method: 'POST', url: '/login', payload: { username: 'ADMIN' } })).statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'login_rate_limited', reasonCode: 'LOGIN_RATE_LIMIT_EXCEEDED', resourceType: 'auth-login',
    }));
    await fastify.close();
  });
});
