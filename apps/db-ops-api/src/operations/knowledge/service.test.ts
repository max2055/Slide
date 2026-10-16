import { describe, expect, it } from 'vitest';
import { candidateSchema, parse, redactCaseText } from './service.js';

describe('case publication input and redaction', () => {
  it('redacts quoted/unquoted secrets, URI credentials, bearer, private keys and configured canaries', () => {
    const value = `password="quoted secret" pwd=hidden secret='second secret' api_key=key123
      mysql://alice:pass123@db.invalid/db Bearer bearer-value123 sk-abcdefg12345678
      -----BEGIN RSA PRIVATE KEY-----\nprivate bytes\n-----END RSA PRIVATE KEY----- bare-canary`;
    const redacted = redactCaseText(value, ['bare-canary']);
    for (const secret of ['quoted secret', 'hidden', 'second secret', 'key123', 'pass123', 'bearer-value123', 'sk-abcdefg12345678', 'private bytes', 'bare-canary'])
      expect(redacted).not.toContain(secret);
    expect(redacted).toContain('db.invalid');
  });
  it('requires explicit human confirmation and fixed source; rejects caller-selected publication/identity', () => {
    expect(() => parse(candidateSchema, { state: 'published', authorId: 2 })).toThrow('OPERATIONS_INPUT_INVALID');
  });
});
