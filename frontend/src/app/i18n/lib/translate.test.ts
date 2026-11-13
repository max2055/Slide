import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('../../ui/local-storage.ts', () => ({
  getSafeLocalStorage: () => ({
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  }),
}));

beforeEach(() => {
  vi.resetModules();
  storage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('MAX-664 first-render locale', () => {
  it.each([
    ['zh-CN', null, 'zh-CN', '用户名'],
    ['zh-TW', null, 'zh-CN', '用户名'],
    ['en-US', 'zh-CN', 'zh-CN', '用户名'],
    ['zh-CN', 'en', 'en', 'Username'],
    ['en-US', null, 'en', 'Username'],
    ['zh-CN', 'invalid', 'zh-CN', '用户名'],
  ])('initializes synchronously for browser %s, saved %s', async (language, saved, locale, label) => {
    vi.stubGlobal('navigator', { language });
    if (saved) storage.set('slide.i18n.locale', saved);
    const { i18n, t } = await import('./translate.ts');
    expect(i18n.getLocale()).toBe(locale);
    expect(t('login.username')).toBe(label);
  });

  it('persists and notifies synchronous changes while preserving the async API', async () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    const { i18n, t } = await import('./translate.ts');
    const listener = vi.fn();
    const unsubscribe = i18n.subscribe(listener);
    const changed = i18n.setLocale('zh-CN');
    expect(t('login.username')).toBe('用户名');
    expect(storage.get('slide.i18n.locale')).toBe('zh-CN');
    expect(listener).toHaveBeenCalledExactlyOnceWith('zh-CN');
    await changed;
    await i18n.setLocale('zh-CN');
    expect(listener).toHaveBeenCalledTimes(1);
    await i18n.setLocale('en');
    expect(t('login.username')).toBe('Username');
    unsubscribe();
  });
});
