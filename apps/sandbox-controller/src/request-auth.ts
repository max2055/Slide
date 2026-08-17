import { createHmac, timingSafeEqual } from 'node:crypto';

const usedNonces = new Map<string, number>();

export function signRequest(secret: string, timestamp: string, nonce: string, body: Buffer): string {
  return createHmac('sha256', secret).update(timestamp).update('.').update(nonce).update('.').update(body).digest('hex');
}

export function authenticateRequest(input: {
  secret: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  body: Buffer;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const timestamp = Number(input.timestamp);
  if (input.secret.length < 32 || !Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 30_000
    || !input.nonce || !/^[a-f0-9-]{36}$/.test(input.nonce) || !input.signature || !/^[a-f0-9]{64}$/.test(input.signature)) {
    return false;
  }
  for (const [nonce, expiresAt] of usedNonces) if (expiresAt <= now) usedNonces.delete(nonce);
  if (usedNonces.has(input.nonce)) return false;
  const expected = signRequest(input.secret, input.timestamp!, input.nonce, input.body);
  const valid = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.signature, 'hex'));
  if (valid) usedNonces.set(input.nonce, now + 60_000);
  return valid;
}
