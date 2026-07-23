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
