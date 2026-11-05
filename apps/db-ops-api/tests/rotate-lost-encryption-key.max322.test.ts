import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprint } from '../../../scripts/recovery/rotate-lost-encryption-key.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe('MAX-322 / #694 recovery audit fingerprints', () => {
  it('distinguishes different JSON configurations', () => {
    expect(fingerprint({ token: 'first' })).not.toBe(fingerprint({ token: 'second' }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: '1' }));
    expect(fingerprint({ a: null })).not.toBe(fingerprint({}));
  });

  it('sorts object keys recursively while retaining array order and JSON values', () => {
    const first = { z: [null, true, { z: '中文', a: 2 }], a: { y: false, x: 1 } };
    const reordered = { a: { x: 1, y: false }, z: [null, true, { a: 2, z: '中文' }] };
    expect(fingerprint(first)).toBe(fingerprint(reordered));
    expect(fingerprint(first)).toBe(hash('{"a":{"x":1,"y":false},"z":[null,true,{"a":2,"z":"中文"}]}'));
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
    expect(fingerprint(JSON.parse('{"__proto__":{"z":1},"a":2}'))).toBe(hash('{"__proto__":{"z":1},"a":2}'));
  });

  it('hashes Buffer hexadecimal bytes without lossy UTF-8 conversion', () => {
    expect(fingerprint(Buffer.from([0, 255, 128]))).toBe(hash('00ff80'));
    expect(fingerprint(Buffer.from([255]))).not.toBe(fingerprint(Buffer.from([254])));
    expect(fingerprint({ value: Buffer.from([255]) })).toBe(hash('{"value":"ff"}'));
  });

  it.each(['cipher:v1:nonce:tag:payload', '', '中文密文', null, undefined])('preserves legacy string/null hashing: %s', (value) => {
    expect(fingerprint(value)).toBe(hash(String(value ?? '')));
  });
});
