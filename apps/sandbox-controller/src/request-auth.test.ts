import { describe, expect, it } from 'vitest';
import { authenticateRequest, signRequest } from './request-auth.js';

describe('Sandbox Controller request authentication', () => {
  it('accepts one fresh signature and rejects nonce replay', () => {
    const secret = 's'.repeat(32);
    const timestamp = '1000';
    const nonce = '11111111-1111-1111-1111-111111111111';
    const body = Buffer.from('{"runtime":"node"}');
    const signature = signRequest(secret, timestamp, nonce, body);
    const request = { secret, timestamp, nonce, body, signature, now: 1000 };
    expect(authenticateRequest(request)).toBe(true);
    expect(authenticateRequest(request)).toBe(false);
  });

  it('rejects stale signatures', () => {
    const secret = 's'.repeat(32);
    const body = Buffer.from('{}');
    const timestamp = '1000';
    const nonce = '22222222-2222-2222-2222-222222222222';
    expect(authenticateRequest({
      secret, timestamp, nonce, body, now: 40_001,
      signature: signRequest(secret, timestamp, nonce, body),
    })).toBe(false);
  });
});
