import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { deviceSigningPayload } from './device-auth-service.js';
import { registerDeviceAuthRoutes } from './device-auth-routes.js';

const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
const payload = { deviceId: 'a'.repeat(64), publicKey, signature: 'invalid', nonce: 'nonce', timestamp: Date.now() };
afterEach(() => vi.restoreAllMocks());

describe('MAX-271 device HTTP error boundary', () => {
  for (const route of ['register', 'challenge', 'session']) {
    for (const message of ['SELECT secret FROM users mysql://root:password@host/db', 'DEVICE_AUTH_REVOKED', 'PAIRING_REQUIRED', 'device_auth_input_invalid', 'DEVICE_AUTH_INPUT_INVALID SQL password=secret', 'DEVICE_AUTH_INPUT_INVALID']) {
      it(`${route} rejects internal/forged business message ${message.split(' ')[0]}`, async () => {
        const logs: string[] = [];
        const stream = new Writable({ write(chunk, _encoding, done) { logs.push(chunk.toString()); done(); } });
        const app = Fastify({ logger: { stream } });
        vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: async () => { throw new Error(message); } } as any);
        await registerDeviceAuthRoutes(app, async request => { request.user = { userId: 7 } as any; });
        try {
          await app.listen({ port: 0, host: '127.0.0.1' });
          const { port } = app.server.address() as { port: number };
          const response = await fetch(`http://127.0.0.1:${port}/api/device/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
          expect(response.status).toBe(503);
          expect(await response.json()).toEqual({ error: 'PLATFORM_UNAVAILABLE', message: '平台服务暂不可用，请稍后重试' });
          expect(logs.join('')).toContain('Device authentication failed');
          expect(logs.join('')).not.toMatch(/SELECT|mysql:\/\/|password|PAIRING_REQUIRED|DEVICE_AUTH_REVOKED|device_auth_input_invalid|DEVICE_AUTH_INPUT_INVALID/);
        } finally { await app.close(); }
      });
    }
  }
  for (const route of ['register', 'challenge', 'session']) {
    it(`${route} protects failures after a successful storage operation`, async () => {
      const app = Fastify();
      const keys = generateKeyPairSync('ed25519');
      const proof = { ...payload, publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'), method: 'POST', path: '/api/device/session', body: '' };
      proof.signature = sign(null, Buffer.from(deviceSigningPayload(proof)), keys.privateKey).toString('base64url');
      const execute = vi.fn().mockResolvedValueOnce([[{ id: 1, status: 'paired', public_key: proof.publicKey, challenge_hash: createHash('sha256').update(proof.nonce).digest('hex'), challenge_expires_at: new Date(Date.now() + 60000) }]])
        .mockRejectedValueOnce(new Error('SELECT secret mysql://root:password@host/db'));
      vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
      await registerDeviceAuthRoutes(app, async request => { request.user = { userId: 7 } as any; });
      try {
        const response = await app.inject({ method: 'POST', url: `/api/device/${route}`, payload: proof });
        expect(response.statusCode).toBe(503);
        expect(response.json().error).toBe('PLATFORM_UNAVAILABLE');
        expect(execute).toHaveBeenCalledTimes(2);
      } finally { await app.close(); }
    });
  }
  it('preserves input, revoked, pairing, signature and authentication failures', async () => {
    const app = Fastify();
    const execute = vi.fn();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    await registerDeviceAuthRoutes(app, async (request, reply) => {
      if (request.headers.authorization === 'denied') return reply.code(403).send({ reasonCode: 'FORBIDDEN' });
      request.user = { userId: 7 } as any;
    });
    try {
      for (const route of ['register', 'challenge', 'session']) {
        expect((await app.inject({ method: 'POST', url: `/api/device/${route}`, payload: {} })).statusCode).toBe(400);
        expect((await app.inject({ method: 'POST', url: `/api/device/${route}`, headers: { authorization: 'denied' }, payload })).statusCode).toBe(403);
      }
      expect(execute).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url: '/api/device/register', payload: { ...payload, deviceId: 'bad' } })).json()).toEqual({ reasonCode: 'DEVICE_AUTH_INPUT_INVALID' });
      execute.mockResolvedValueOnce([{ affectedRows: 0 }]).mockResolvedValueOnce([[{ status: 'revoked' }]]);
      expect((await app.inject({ method: 'POST', url: '/api/device/register', payload })).statusCode).toBe(403);
      execute.mockResolvedValue([[]]);
      expect((await app.inject({ method: 'POST', url: '/api/device/challenge', payload })).json()).toEqual({ reasonCode: 'PAIRING_REQUIRED' });
      expect((await app.inject({ method: 'POST', url: '/api/device/session', payload })).json()).toEqual({ reasonCode: 'DEVICE_AUTH_SIGNATURE_INVALID' });
    } finally { await app.close(); }
  });
});
