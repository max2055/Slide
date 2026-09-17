import { createHmac, timingSafeEqual } from 'node:crypto';

export interface NonceStore {
  claim(nonce: string, timestamp: number): Promise<boolean>;
}

export function signRequest(secret: string, timestamp: string, nonce: string, body: Buffer): string {
  return createHmac('sha256', secret).update(timestamp).update('.').update(nonce).update('.').update(body).digest('hex');
}

export async function authenticateRequest(input: {
  store: NonceStore;
  secret: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  body: Buffer;
  now?: number;
}): Promise<boolean> {
  const now = input.now ?? Date.now();
  const timestamp = Number(input.timestamp);
  if (input.secret.length < 32 || !Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 30_000
    || !input.nonce || !/^[a-f0-9-]{36}$/.test(input.nonce) || !input.signature || !/^[a-f0-9]{64}$/.test(input.signature)) {
    return false;
  }
  const expected = signRequest(input.secret, input.timestamp!, input.nonce, input.body);
  const valid = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.signature, 'hex'));
  return valid && await input.store.claim(input.nonce, timestamp);
}
