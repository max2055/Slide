import { describe, expect, it, vi } from 'vitest';
import { installConsoleRedaction, redactLogValue, redactSensitiveText } from './log-redaction.js';

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
});
