import { describe, expect, it } from 'vitest';
import { createCredentialSshHostVerifier, fingerprintSshHostKey } from './ssh-host-key.js';

describe('MAX-308 credential-scoped host trust', () => {
  const key = Buffer.from('host');
  it('rejects key authentication without an explicit trust decision', () => {
    expect(() => createCredentialSshHostVerifier('key', undefined)).toThrow('SSH_TRUST_CONFIRMATION_REQUIRED');
  });
  it.each(['', '   '])('rejects a blank key fingerprint %j', value => {
    expect(() => createCredentialSshHostVerifier('key', value)).toThrow('SSH_HOST_KEY_FINGERPRINT_REQUIRED');
  });
  it.each([undefined, null, '', '   '])('retains password optional semantics %j', value => {
    expect(createCredentialSshHostVerifier('password', value)).toBeUndefined();
  });
  it.each(['key', 'password'])('retains pin matching for %s', type => {
    const verifier = createCredentialSshHostVerifier(type, fingerprintSshHostKey(key));
    expect(verifier!(key)).toBe(true);
    expect(verifier!(Buffer.from('other'))).toBe(false);
  });
  it('requires a valid explicit mode and never ignores a supplied pin', () => {
    expect(() => createCredentialSshHostVerifier('key', undefined, 'unknown')).toThrow();
    expect(() => createCredentialSshHostVerifier('key', undefined, 'pinned')).toThrow();
    expect(() => createCredentialSshHostVerifier('key', 'bad', 'insecure')).toThrow();
    expect(createCredentialSshHostVerifier('key', undefined, 'insecure')).toBeUndefined();
    expect(createCredentialSshHostVerifier('key', fingerprintSshHostKey(key), 'insecure')!(Buffer.from('other'))).toBe(false);
  });
});
