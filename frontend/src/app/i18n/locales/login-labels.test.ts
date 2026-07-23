import { describe, expect, it } from 'vitest';
import { en } from './en.ts';
import { zh_CN } from './zh-CN.ts';

describe('login labels', () => {
  it('provides translated username and password labels', () => {
    const zhLogin = zh_CN.login as Record<string, unknown>;
    const enLogin = en.login as Record<string, unknown>;
    expect(zhLogin.username).toBe('用户名');
    expect(zhLogin.password).toBe('密码');
    expect(enLogin.username).toBe('Username');
    expect(enLogin.password).toBe('Password');
  });
});
