import { describe, expect, it, vi } from 'vitest';
import { installConsoleRedaction, redactLogValue, redactSensitiveText } from './log-redaction.js';

describe('log redaction', () => {
  it('redacts common credentials and webhook secrets from text', () => {
    const value = redactSensitiveText('Bearer abc.def password=hunter2 sk-secretvalue /open-apis/bot/v2/hook/tenant-secret');
    expect(value).not.toContain('abc.def');
    expect(value).not.toContain('hunter2');
    expect(value).not.toContain('secretvalue');
    expect(value).not.toContain('tenant-secret');
  });

  it('redacts credentials in JSON-style text while preserving keys and prose', () => {
    expect(redactSensitiveText('{"token": "value with \\"quotes\\"", "api_key" : "another secret"}'))
      .toBe('{"token": "[REDACTED]", "api_key" : "[REDACTED]"}');
    expect(redactSensitiveText('{"TOKEN":"upper","apiKey":"camel","x-api-key":"prefixed","clientSecret":"secret"}'))
      .toBe('{"TOKEN":"[REDACTED]","apiKey":"[REDACTED]","x-api-key":"[REDACTED]","clientSecret":"[REDACTED]"}');
    expect(redactSensitiveText('{"message":"the word token is not a credential"}'))
      .toBe('{"message":"the word token is not a credential"}');
    expect(redactSensitiveText('{"token": {\n  "nested": ["first", "secret"]\n}, "ok": true}'))
      .toBe('{"token": "[REDACTED]", "ok": true}');
    expect(redactSensitiveText('{"token":"truncated secret')).toBe('{"token":"[REDACTED]');
    expect(redactSensitiveText('{\\"token\\":\\"escaped secret\\"}')).toBe('{\\"token\\":\\"[REDACTED]\\"}');
    expect(redactSensitiveText('A token is issued after login.')).toBe('A token is issued after login.');
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
});
