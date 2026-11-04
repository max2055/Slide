import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DeviceAuthService, deviceSigningPayload } from './device-auth-service.js';

export function proof() {
  const keys = generateKeyPairSync('ed25519');
  const params = { deviceId: 'a'.repeat(64), publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'), signature: '', timestamp: Date.now(), nonce: 'nonce', method: 'GET', path: '/ws/auth', body: '' };
  params.signature = sign(null, Buffer.from(deviceSigningPayload(params)), keys.privateKey).toString('base64url');
  return params;
}

describe('MAX-268 atomic consumption (simulated storage)', () => {
  for (const affectedRows of [0, 1, 2, undefined]) {
    it(`grants access only for exactly one consumed row (${affectedRows})`, async () => {
      const params = proof();
      const service = new DeviceAuthService(() => ({ execute: async sql => sql.startsWith('SELECT')
        ? [[{ id: 1, public_key: params.publicKey, status: 'paired', challenge_hash: createHash('sha256').update(params.nonce).digest('hex'), challenge_expires_at: new Date(Date.now() + 60_000) }]]
        : [{ affectedRows }] }));
      expect(await service.verify({ userId: 7 } as any, params)).toBe(affectedRows === 1);
    });
  }
  it('rejects a failure during consumption', async () => {
    const params = proof();
    const service = new DeviceAuthService(() => ({ execute: async sql => {
      if (!sql.startsWith('SELECT')) throw new Error('storage failed');
      return [[{ id: 1, public_key: params.publicKey, status: 'paired', challenge_hash: createHash('sha256').update(params.nonce).digest('hex'), challenge_expires_at: new Date(Date.now() + 60_000) }]];
    } }));
    await expect(service.verify({ userId: 7 } as any, params)).rejects.toMatchObject({ name: 'PlatformUnavailableError' });
  });
});
