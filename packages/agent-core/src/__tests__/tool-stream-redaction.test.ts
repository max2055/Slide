import { describe, expect, it } from 'vitest';
import { boundedToolValue, buildToolPreview } from '../tool-stream.js';

describe('JSON string tool preview redaction (MAX-321 / #693)', () => {
  it.each(['password', 'passwd', 'pwd', 'secret', 'token', 'api_key', 'API-KEY', 'authorization', 'cookie', 'accessToken', 'private_key', 'connection_string', 'credential'])('redacts quoted %s values', (key) => {
    const input = JSON.stringify({ [key]: 'synthetic secret, with; delimiters', status: 'ok' });
    const expected = JSON.stringify({ [key]: '[REDACTED]', status: 'ok' });
    expect(boundedToolValue(input)).toBe(expected);
    expect(buildToolPreview({ detail: input }, 'call-json').text).toBe(JSON.stringify({ detail: expected }));
  });

  it.each(['quote"secret', 'slash\\secret', 'line\nsecret', 'tab\tsecret', '', 'literal\\"tail'])('consumes complete escaped JSON values: %j', (secret) => {
    const input = `prefix ${JSON.stringify({ token: secret, visible: 'kept' })} suffix`;
    expect(buildToolPreview(input, 'call-json').text).toBe('prefix {"token":"[REDACTED]","visible":"kept"} suffix');
  });

  it('keeps ordinary token words and non-sensitive JSON fields', () => {
    const input = 'The token is expired. {"message":"token expired", "status":"ok"}';
    expect(boundedToolValue(input)).toBe(input);
    expect(boundedToolValue({ token: 'synthetic', nested: { password: 'synthetic', status: 'ok' } })).toEqual({ token: '[REDACTED]', nested: { password: '[REDACTED]', status: 'ok' } });
  });
});
