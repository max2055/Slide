import { describe, expect, it } from 'vitest';
import { redactSensitiveData, stableJson } from './sensitive-data.js';

describe('Agent security data handling', () => {
  it('recursively redacts credentials without mutating ordinary values', () => {
    expect(redactSensitiveData({
      host: 'db.internal',
      password: 'plain-text',
      credential_ref: 'opaque-reference',
      nested: { api_key: 'key', tokenValue: 'token', port: 3306 },
    })).toEqual({
      host: 'db.internal',
      password: '[REDACTED]',
      credential_ref: '[REDACTED]',
      nested: { api_key: '[REDACTED]', tokenValue: '[REDACTED]', port: 3306 },
    });
  });

  it('MAX-175 preserves nested Date evidence as ISO and invalid dates as null while redacting secrets', () => {
    const observedAt = new Date('2026-10-16T00:41:54.123Z');
    const value = { observations: [{ observedAt, validUntil: new Date('2026-10-16T00:42:54.123Z'),
      invalid: new Date(NaN), password: observedAt, detail: 'token=abc123xyz' }] };
    expect(redactSensitiveData(value)).toEqual({ observations: [{
      observedAt: '2026-10-16T00:41:54.123Z', validUntil: '2026-10-16T00:42:54.123Z',
      invalid: null, password: '[REDACTED]', detail: 'token=[REDACTED]',
    }] });
    expect(value.observations[0].observedAt).toBe(observedAt);
    expect(Number.isNaN(value.observations[0].invalid.getTime())).toBe(true);
  });

  it('canonicalizes object keys for deterministic approval binding', () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(stableJson({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it('redacts secrets embedded in error text', () => {
    expect(redactSensitiveData('request failed: password=hunter2 token=abc123xyz'))
      .toBe('request failed: password=[REDACTED] token=[REDACTED]');
  });

  it('redacts spaced secrets and cookie headers inside ordinary string fields (MAX-315)', () => {
    expect(redactSensitiveData({
      host: 'db.internal',
      detail: 'password=ab cd',
      challenge: 'Authorization: Digest abc123xyz',
      header: 'Cookie: session=abc123',
      response: 'Set-Cookie: sid=abc123; HttpOnly',
      phrase: 'token: hello world',
      cookie: 'session=abc123',
    })).toEqual({
      host: 'db.internal',
      detail: 'password=[REDACTED]',
      challenge: 'Authorization: [REDACTED]',
      header: 'Cookie: [REDACTED]',
      response: 'Set-Cookie: [REDACTED]',
      phrase: 'token: [REDACTED]',
      cookie: '[REDACTED]',
    });
  });

  it.each(['Authorization', 'authorization', 'AUTHORIZATION', 'aUtHoRiZaTiOn'])(
    'redacts complete %s Digest parameters in ordinary nested string fields (MAX-315 review regression)',
    (header) => {
      const detail = `${header}: Digest username="alice", realm="synthetic realm", response=synthetic_digest_secret`;
      expect(redactSensitiveData({ host: 'db.internal', records: [{ detail }] })).toEqual({
        host: 'db.internal', records: [{ detail: `${header}: [REDACTED]` }],
      });
    },
  );
});
