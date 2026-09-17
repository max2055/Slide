import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { authenticateRequest, signRequest } from './request-auth.js';

function fixture() {
  const seen = new Set<string>();
  const store = { claim: vi.fn(async (nonce: string) => {
    if (seen.has(nonce)) return false;
    seen.add(nonce);
    return true;
  }) };
  const secret = 's'.repeat(32), timestamp = '100000', nonce = randomUUID(), body = Buffer.from('{}');
  return { store, secret, timestamp, nonce, body, now: 100000, signature: signRequest(secret, timestamp, nonce, body) };
}

describe('Sandbox Controller request authentication', () => {
  it('accepts independent requests and rejects replay across auth calls', async () => {
    const request = fixture();
    expect(await authenticateRequest(request)).toBe(true);
    expect(await authenticateRequest(request)).toBe(false);
    expect(await authenticateRequest(fixture())).toBe(true);
  });
  it.each([-30001, -30000, 30000, 30001])('checks freshness boundary %i', async (offset) => {
    const request = fixture();
    expect(await authenticateRequest({ ...request, now: request.now + offset })).toBe(Math.abs(offset) <= 30000);
  });
  it('does not claim tampered or malformed requests', async () => {
    const request = fixture();
    for (const changes of [{ body: Buffer.from('tampered') }, { signature: 'f'.repeat(64) }, { nonce: 'bad' }, { timestamp: 'NaN' }, { secret: 'short' }]) {
      expect(await authenticateRequest({ ...request, ...changes })).toBe(false);
    }
    expect(request.store.claim).not.toHaveBeenCalled();
  });
  it('propagates unavailable or uncertain storage without retry', async () => {
    const request = fixture();
    request.store.claim.mockRejectedValue(new Error('commit outcome unknown'));
    await expect(authenticateRequest(request)).rejects.toThrow('commit outcome unknown');
    expect(request.store.claim).toHaveBeenCalledTimes(1);
  });
  it('obeys the authoritative database rejection', async () => {
    const request = fixture();
    request.store.claim.mockResolvedValue(false);
    expect(await authenticateRequest(request)).toBe(false);
  });
});
