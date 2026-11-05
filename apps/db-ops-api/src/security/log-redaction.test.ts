import { describe, expect, it, vi } from 'vitest';
import { installConsoleRedaction, redactLogValue, redactSensitiveText } from './log-redaction.js';
import { boundedToolValue, buildToolPreview } from '@slide/agent-core/tool-stream';

describe('JSON string redaction (MAX-321 / #693)', () => {
  it.each(['password', 'passwd', 'pwd', 'secret', 'token', 'api_key', 'API-KEY', 'authorization', 'cookie', 'accessToken', 'private_key', 'connection_string', 'credential'])('redacts quoted %s at log and preview boundaries', (key) => {
    const input = JSON.stringify({ [key]: 'synthetic secret, with; delimiters', status: 'ok' });
    const expected = JSON.stringify({ [key]: '[REDACTED]', status: 'ok' });
    expect(redactSensitiveText(input)).toBe(expected);
    expect(redactLogValue({ detail: input })).toEqual({ detail: expected });
    expect(boundedToolValue(input, redactSensitiveText)).toBe(expected);
    expect(buildToolPreview(input, 'call-json', redactSensitiveText).text).toBe(expected);
  });

  it.each(['quote"secret', 'slash\\secret', 'line\nsecret', 'tab\tsecret', '', 'literal\\"tail'])('redacts complete escaped JSON values: %j', (secret) => {
    const input = `prefix ${JSON.stringify({ token: secret, visible: 'kept' })} suffix`;
    expect(redactSensitiveText(input)).toBe('prefix {"token":"[REDACTED]","visible":"kept"} suffix');
  });

  it('preserves ordinary token words, formatting, and multiple JSON fields', () => {
    const ordinary = 'The token is expired. {"message":"token expired", "status":"ok"}';
    expect(redactSensitiveText(ordinary)).toBe(ordinary);
    expect(redactSensitiveText('{ "token" : "first", "api_key": "second", "status": "ok" }'))
      .toBe('{ "token" : "[REDACTED]", "api_key": "[REDACTED]", "status": "ok" }');
  });

  it('redacts before console emission and preview truncation', () => {
    const target = { error: vi.fn(), warn: vi.fn() };
    const warn = target.warn;
    installConsoleRedaction(target);
    target.warn(new Error('{"password":"synthetic\\\"tail"}'));
    expect(warn).toHaveBeenCalledWith({ name: 'Error', message: '{"password":"[REDACTED]"}' });
    const preview = buildToolPreview(JSON.stringify({ token: 'synthetic'.repeat(2000) }), 'long-json', redactSensitiveText);
    expect(preview.text).toBe('{"token":"[REDACTED]"}');
    expect(preview.truncated).toBe(false);
  });
});

describe('log redaction', () => {
  it('redacts common credentials and webhook secrets from text', () => {
    const value = redactSensitiveText('Bearer abc.def password=hunter2 sk-secretvalue /open-apis/bot/v2/hook/tenant-secret');
    expect(value).not.toContain('abc.def');
    expect(value).not.toContain('hunter2');
    expect(value).not.toContain('secretvalue');
    expect(value).not.toContain('tenant-secret');
    expect(redactSensitiveText('Bearer abc.def')).not.toContain('abc.def');
    expect(redactSensitiveText('sk-secretvalue')).not.toContain('secretvalue');
    expect(redactSensitiveText('/open-apis/bot/v2/hook/tenant-secret')).toBe('/open-apis/bot/v2/hook/[REDACTED]');
  });

  it('redacts sensitive object keys and removes error stacks', () => {
    const result = redactLogValue({ username: 'admin', password: 'secret', nested: new Error('token=abc') });
    expect(result).toEqual({ username: 'admin', password: '[REDACTED]', nested: { name: 'Error', message: 'token=[REDACTED]' } });
  });

  it('wraps warning and error output at the process boundary', () => {
    const target = { error: vi.fn(), warn: vi.fn() } as unknown as Pick<Console, 'error' | 'warn'>;
    const error = target.error;
    installConsoleRedaction(target);
    target.error('password=secret');
    expect(error).toHaveBeenCalledWith('password=[REDACTED]');
  });

  it('redacts spaced secrets, Digest challenges, and cookie headers (MAX-315)', () => {
    const cases = [
      ['Authorization: Digest abc123xyz', 'Authorization: [REDACTED]', ['abc123xyz', 'Digest']],
      ['password=ab cd', 'password=[REDACTED]', ['ab', 'cd']],
      ['PASSWORD = ab cd', 'PASSWORD = [REDACTED]', ['ab', 'cd']],
      ['token: hello world', 'token: [REDACTED]', ['hello', 'world']],
      ['Token:hello world', 'Token:[REDACTED]', ['hello', 'world']],
      ['api_key: hello world', 'api_key: [REDACTED]', ['hello', 'world']],
      ['api-key=ab cd', 'api-key=[REDACTED]', ['ab', 'cd']],
      ['authorization: digest abc123xyz', 'authorization: [REDACTED]', ['abc123xyz', 'digest']],
      ['Cookie: session=abc123', 'Cookie: [REDACTED]', ['session=abc123', 'abc123']],
      ['cookie: SESSION=abc123', 'cookie: [REDACTED]', ['SESSION=abc123', 'abc123']],
      ['Set-Cookie: sid=abc123; HttpOnly', 'Set-Cookie: [REDACTED]', ['sid=abc123', 'abc123']],
      ['set-cookie: sid=abc 123; Secure', 'set-cookie: [REDACTED]', ['sid=abc 123', 'abc']],
      ['Cookie: a=secret1; b=secret2', 'Cookie: [REDACTED]', ['secret1', 'secret2']],
      ['cookie=abc123', 'cookie=[REDACTED]', ['abc123']],
      ['cookie=ab cd', 'cookie=[REDACTED]', ['ab', 'cd']],
      ['password=ab cd, keep-visible', 'password=[REDACTED], keep-visible', ['ab', 'cd']],
      ['token: hello world; next-field', 'token: [REDACTED]; next-field', ['hello', 'world']],
    ] as const;
    for (const [input, expected, forbidden] of cases) {
      const value = redactSensitiveText(input);
      expect(value).toBe(expected);
      expect(value).not.toContain('$1');
      for (const fragment of forbidden) expect(value).not.toContain(fragment);
    }
    const ordinary = redactSensitiveText('host=db.internal port=3306 status=ok');
    expect(ordinary).toBe('host=db.internal port=3306 status=ok');
  });

  it('redacts spaced secrets inside ordinary log object fields (MAX-315)', () => {
    expect(redactLogValue({
      note: 'Authorization: Digest abc123xyz',
      message: 'Cookie: session=abc123',
      warning: 'Set-Cookie: sid=abc123; HttpOnly',
      password: 'ab cd',
    })).toEqual({
      note: 'Authorization: [REDACTED]',
      message: 'Cookie: [REDACTED]',
      warning: 'Set-Cookie: [REDACTED]',
      password: '[REDACTED]',
    });
  });

  it.each([
    ['Authorization: Digest username=alice, response=synthetic_digest_secret', 'Authorization: [REDACTED]'],
    ['authorization: digest username=alice,response=synthetic_digest_secret', 'authorization: [REDACTED]'],
    ['AUTHORIZATION: DIGEST username="alice", realm="synthetic realm", response="synthetic_digest_secret", qop=auth', 'AUTHORIZATION: [REDACTED]'],
    ['aUtHoRiZaTiOn\t:\tDigest username=alice, nonce=synthetic_nonce; response=synthetic_digest_secret', 'aUtHoRiZaTiOn\t:\t[REDACTED]'],
    ['request failed: Authorization: Digest username=alice, response=synthetic_digest_secret\r\nhost=db.internal', 'request failed: Authorization: [REDACTED]\r\nhost=db.internal'],
    ['Authorization: Basic synthetic_basic_secret\nstatus=ok', 'Authorization: [REDACTED]\nstatus=ok'],
    ['Authorization: Bearer synthetic.bearer.secret', 'Authorization: [REDACTED]'],
  ])('redacts complete Authorization header values after Digest comma regression (MAX-315): %s', (input, expected) => {
    expect(redactSensitiveText(input)).toBe(expected);
    expect(redactLogValue({ detail: input })).toEqual({ detail: expected });
  });

  it.each(['\n', '\r\n'])(
    'preserves following lines after ordinary assignments (MAX-315 CI regression): %j',
    (newline) => {
      for (const key of ['password', 'passwd', 'secret', 'token', 'api_key', 'api-key', 'cookie', 'authorization']) {
        const input = `${key}=synthetic spaced value${newline}mysql://db.invalid/db`;
        const expected = `${key}=[REDACTED]${newline}mysql://db.invalid/db`;
        expect(redactSensitiveText(input)).toBe(expected);
        expect(redactLogValue({ detail: input })).toEqual({ detail: expected });
        expect(redactSensitiveText(`${key}=synthetic \t${newline}status=ok`))
          .toBe(`${key}=[REDACTED] \t${newline}status=ok`);
        expect(redactSensitiveText(`${key}=${newline}mysql://db.invalid/db`))
          .toBe(`${key}=${newline}mysql://db.invalid/db`);
      }
      expect(redactSensitiveText(`api_key=synthetic${newline}token=hello world${newline}status=ok`))
        .toBe(`api_key=[REDACTED]${newline}token=[REDACTED]${newline}status=ok`);
    },
  );
});
