import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BODY_LIMIT, createLoginIpRateLimit, loginRateLimitConfig, registerHttpSecurity, resolveCorsOrigins } from './http-security.js';
import { securityEventService } from './security-event-service.js';

async function app() {
  const fastify = Fastify({ bodyLimit: API_BODY_LIMIT });
  await registerHttpSecurity(fastify, { NODE_ENV: 'test', CORS_ORIGINS: 'https://slide.example.com' } as NodeJS.ProcessEnv);
  fastify.post('/login', { onRequest: createLoginIpRateLimit(fastify), config: { rateLimit: loginRateLimitConfig } }, async () => ({ ok: true }));
  fastify.post('/echo', async () => ({ ok: true }));
  fastify.get('/failure', async (_request, reply) => reply.code(500).send({ error: 'password=secret', stack: 'internal' }));
  fastify.get('/sandbox-failure', async (_request, reply) => reply.code(503).send({ reasonCode: 'SANDBOX_NOT_READY', detail: 'hidden' }));
  fastify.get('/sandbox-network-failure', async (_request, reply) => reply.code(503).send({ reasonCode: 'SANDBOX_NETWORK_NOT_READY', detail: 'hidden' }));
  fastify.get('/backup-failure', async (_request, reply) => reply.code(502).send({ error: 'SSH_CONNECT_FAILED', detail: 'password=secret', stack: 'internal' }));
  fastify.get('/unknown-backup-failure', async (_request, reply) => reply.code(502).send({ error: 'SSH_UNKNOWN_SECRET', detail: 'password=secret' }));
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

  it('preserves exact public backup codes while stripping details and hiding unknown codes', async () => {
    const fastify = await app();
    const known = await fastify.inject({ method: 'GET', url: '/backup-failure' });
    expect(known.statusCode).toBe(502);
    expect(known.json()).toEqual({ error: 'SSH_CONNECT_FAILED' });
    const unknown = await fastify.inject({ method: 'GET', url: '/unknown-backup-failure' });
    expect(unknown.json()).toEqual({ error: 'INTERNAL_ERROR' });
    await fastify.close();
  });

  it('enforces the explicit body limit', async () => {
    const fastify = await app();
    const response = await fastify.inject({ method: 'POST', url: '/echo', payload: { value: 'x'.repeat(API_BODY_LIMIT) } });
    expect(response.statusCode).toBe(413);
    await fastify.close();
  });

  it('rate limits login attempts by normalized account', async () => {
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
  it('allows different accounts on one IP but caps an account across IPs (#375)', async () => {
    vi.spyOn(securityEventService, 'record').mockResolvedValue();
    const fastify = await app();
    try {
      for (let i = 0; i < 6; i++) {
        expect((await fastify.inject({ method: 'POST', url: '/login', payload: { username: `user${i}` } })).statusCode).toBe(200);
      }
      for (let i = 0; i < 6; i++) {
        expect((await fastify.inject({ method: 'POST', url: '/login', remoteAddress: `192.0.2.${i + 1}`,
          payload: { username: i % 2 ? ' ADMIN ' : 'admin' } })).statusCode).toBe(i < 5 ? 200 : 429);
      }
    } finally { await fastify.close(); }
  });

  it('caps independent IP abuse including malformed JSON and forged forwarding headers', async () => {
    vi.spyOn(securityEventService, 'record').mockResolvedValue();
    const fastify = await app();
    try {
      for (let i = 0; i < 31; i++) {
        const response = await fastify.inject({ method: 'POST', url: '/login',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${i + 1}`, forwarded: `for=192.0.2.${i + 1}` },
          payload: i < 10 ? '{' : JSON.stringify({ username: `user${i}` }) });
        expect(response.statusCode).toBe(i === 30 ? 429 : i < 10 ? 400 : 200);
        if (i === 30) expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      }
    } finally { await fastify.close(); }
  });

  it('bounds missing/malformed usernames and restores both budgets after the window', async () => {
    vi.spyOn(securityEventService, 'record').mockResolvedValue();
    const fastify = await app();
    try {
      const bodies = [{}, { username: null }, { username: [] }, { username: {} }, { username: '' }, { username: 1 }];
      for (const [i, payload] of bodies.entries()) {
        expect((await fastify.inject({ method: 'POST', url: '/login', payload })).statusCode).toBe(i < 5 ? 200 : 429);
      }
      for (let i = 0; i < 25; i++) await fastify.inject({ method: 'POST', url: '/login', payload: { username: `u${i}` } });
      const now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now + 61_000);
      expect((await fastify.inject({ method: 'POST', url: '/login', payload: {} })).statusCode).toBe(200);
    } finally { await fastify.close(); }
  });

  it('uses forwarded IPs only behind an explicitly trusted proxy', async () => {
    vi.spyOn(securityEventService, 'record').mockResolvedValue();
    const fastify = Fastify({ trustProxy: ['127.0.0.1'] });
    await registerHttpSecurity(fastify, { NODE_ENV: 'test' });
    fastify.post('/login', { onRequest: createLoginIpRateLimit(fastify), config: { rateLimit: loginRateLimitConfig } }, async request => ({ ip: request.ip }));
    try {
      for (let i = 0; i < 6; i++) {
        const response = await fastify.inject({ method: 'POST', url: '/login', remoteAddress: '127.0.0.1',
          headers: { 'x-forwarded-for': `192.0.2.${i + 1}` }, payload: { username: 'same' } });
        expect(response.statusCode).toBe(i < 5 ? 200 : 429);
        if (i === 0) expect(response.json().ip).toBe('192.0.2.1');
      }
      const untrusted = await fastify.inject({ method: 'POST', url: '/login', remoteAddress: '198.51.100.1',
        headers: { 'x-forwarded-for': '192.0.2.55' }, payload: { username: 'other' } });
      expect(untrusted.json().ip).toBe('198.51.100.1');
    } finally { await fastify.close(); }
  });

});
