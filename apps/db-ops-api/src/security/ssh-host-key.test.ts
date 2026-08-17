import { describe, expect, it, vi } from 'vitest';
import { createSshHostVerifier, fingerprintSshHostKey, normalizeSshHostKeyFingerprint } from './ssh-host-key.js';

describe('SSH host key verification', () => {
  const key = Buffer.from('known-host-key');

  it('normalizes an OpenSSH SHA256 fingerprint and verifies the exact host key', () => {
    const fingerprint = fingerprintSshHostKey(key);
    expect(normalizeSshHostKeyFingerprint(`${fingerprint}=`)).toBe(fingerprint);

    const verifier = createSshHostVerifier(fingerprint);
    expect(verifier(key)).toBe(true);
    expect(verifier(Buffer.from('different-host-key'))).toBe(false);
  });

  it.each([undefined, null, '', 'MD5:aa:bb', 'SHA256:not-base64'])('fails closed for a missing or malformed fingerprint', (fingerprint) => {
    expect(() => createSshHostVerifier(fingerprint)).toThrow('SSH_HOST_KEY_FINGERPRINT_REQUIRED');
  });

  it('supports the callback form used by ssh2 without leaking comparison details', () => {
    const callback = vi.fn();
    const verifier = createSshHostVerifier(fingerprintSshHostKey(key));
    verifier(key, callback);
    expect(callback).toHaveBeenCalledWith(true);
  });
});
