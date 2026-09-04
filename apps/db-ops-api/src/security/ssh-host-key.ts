import { createHash, timingSafeEqual } from 'node:crypto';

const PREFIX = 'SHA256:';

export function normalizeSshHostKeyFingerprint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('SSH_HOST_KEY_FINGERPRINT_REQUIRED');
  const trimmed = value.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error('SSH_HOST_KEY_FINGERPRINT_REQUIRED');
  const encoded = trimmed.slice(PREFIX.length).replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]{43}$/.test(encoded)) throw new Error('SSH_HOST_KEY_FINGERPRINT_REQUIRED');
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length !== 32) throw new Error('SSH_HOST_KEY_FINGERPRINT_REQUIRED');
  return `${PREFIX}${encoded}`;
}

export function normalizeOptionalSshHostKeyFingerprint(value: unknown): string | undefined {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return undefined;
  return normalizeSshHostKeyFingerprint(value);
}

export function fingerprintSshHostKey(key: Buffer): string {
  return `${PREFIX}${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export function createSshHostVerifier(expectedFingerprint: unknown) {
  const expected = Buffer.from(normalizeSshHostKeyFingerprint(expectedFingerprint));
  return (key: Buffer, callback?: (verified: boolean) => void): boolean | void => {
    const received = Buffer.from(fingerprintSshHostKey(key));
    const verified = received.length === expected.length && timingSafeEqual(received, expected);
    if (callback) {
      callback(verified);
      return;
    }
    return verified;
  };
}

export function createOptionalSshHostVerifier(expectedFingerprint: unknown) {
  const normalized = normalizeOptionalSshHostKeyFingerprint(expectedFingerprint);
  return normalized ? createSshHostVerifier(normalized) : undefined;
}
