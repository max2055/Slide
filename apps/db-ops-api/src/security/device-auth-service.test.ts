import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { deviceSigningPayload, DeviceAuthService } from './device-auth-service.js';

describe('DeviceAuthService', () => {
  it('verifies a one-time Ed25519 challenge for the owning actor', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const raw = der.subarray(-32);
    const publicKeyB64 = raw.toString('base64url');
    const deviceId = 'a'.repeat(64);
    const nonce = 'challenge';
    const timestamp = Date.now();
    const payload = deviceSigningPayload({ deviceId, timestamp, nonce, method: 'GET', path: '/ws/auth', body: '' });
    const signature = sign(null, Buffer.from(payload), privateKey).toString('base64url');
    const execute = vi.fn()
      .mockResolvedValueOnce([[{ id: 1, public_key: publicKeyB64, status: 'paired', challenge_hash: 'x', challenge_expires_at: new Date(Date.now() + 60_000) }]])
      .mockResolvedValueOnce([{}]);
    const service = new DeviceAuthService(() => ({ execute }));
    const { createHash } = await import('node:crypto');
    execute.mockReset();
    execute.mockResolvedValueOnce([[{ id: 1, public_key: publicKeyB64, status: 'paired', challenge_hash: createHash('sha256').update(nonce).digest('hex'), challenge_expires_at: new Date(Date.now() + 60_000) }]]);
    execute.mockResolvedValueOnce([{}]);
    await expect(service.verify({ userId: 7 } as any, { deviceId, publicKey: publicKeyB64, signature, timestamp, nonce, method: 'GET', path: '/ws/auth', body: '' })).resolves.toBe(true);
  });
});
