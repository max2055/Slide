import { describe, expect, it } from 'vitest';
import { boundedToolValue, buildToolPreview } from '../tool-stream.js';

describe('JSON string tool preview redaction (MAX-321 / #693)', () => {
  it.each([739182641, -73.918, true, false, null, ['SYNTHETIC_7f3a'], { value: 'SYNTHETIC_7f3a' }, [{ value: ['quote"tail', 'brace} ]tail'] }], [], {}])('redacts complete non-string sensitive values after Chief review: %j', (secret) => {
    const input = JSON.stringify({ token: secret, status: 'ok', ordinary: [1, { value: 'visible' }] });
    const expected = JSON.stringify({ token: '[REDACTED]', status: 'ok', ordinary: [1, { value: 'visible' }] });
    expect(boundedToolValue(input)).toBe(expected);
    expect(buildToolPreview(input, 'review-json').text).toBe(expected);
    expect(boundedToolValue({ token: secret, status: 'ok' })).toEqual({ token: '[REDACTED]', status: 'ok' });
  });

  it('preserves mixed JSON formatting while consuming nested sensitive values', () => {
    const input = 'prefix { "token" : [1, {"value": "synthetic\\\"tail"}], "nested": {"password": {"value": [2,3]}, "count": 4}, "status": true } suffix';
    expect(boundedToolValue(input)).toBe('prefix { "token" : "[REDACTED]", "nested": {"password": "[REDACTED]", "count": 4}, "status": true } suffix');
  });

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
