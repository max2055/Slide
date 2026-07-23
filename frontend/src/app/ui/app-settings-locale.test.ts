import { describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n/index.ts';
import { applySettings } from './app-settings.ts';
import { loadSettings } from './storage.ts';

describe('applySettings locale synchronization', () => {
  it('applies a supported server-synchronized locale through i18n', () => {
    const settings = loadSettings();
    const target = i18n.getLocale() === 'en' ? 'zh-CN' : 'en';
    const setLocale = vi.spyOn(i18n, 'setLocale').mockResolvedValue();
    const host = {
      settings,
      theme: settings.theme,
      themeMode: settings.themeMode,
      themeResolved: 'dark',
      applySessionKey: '',
      sessionKey: '',
      tab: 'dashboard',
      connected: true,
      chatHasAutoScrolled: false,
      logsAtBottom: true,
      eventLog: [],
      eventLogBuffer: [],
      basePath: '',
    } as any;

    applySettings(host, { ...settings, locale: target });

    expect(setLocale).toHaveBeenCalledWith(target);
    setLocale.mockRestore();
  });
});
