import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ getPreferences: vi.fn(), savePreferences: vi.fn() }));
vi.mock('../../api/preferences.ts', () => ({ preferencesAPI: api }));
import { applySettings, detachThemeListener, syncThemeWithSettings } from './app-settings.ts';
import { loadSettings, syncPreferencesFromServer, UI_SETTINGS_STORAGE_KEY } from './storage.ts';

const testStorage = window.localStorage;
const hosts: Parameters<typeof syncThemeWithSettings>[0][] = [];
function host() {
  const settings = loadSettings();
  const value = { settings, theme: settings.theme, themeMode: settings.themeMode, themeResolved: 'light',
    applySessionKey: '', sessionKey: 'tab-session', tab: 'investigations', connected: false, chatHasAutoScrolled: false,
    logsAtBottom: true, eventLog: [], eventLogBuffer: [], basePath: '' } as Parameters<typeof syncThemeWithSettings>[0];
  hosts.push(value); return value;
}
beforeEach(() => { Object.defineProperty(globalThis, "localStorage", { configurable: true, value: testStorage }); localStorage.clear(); document.documentElement.removeAttribute('style'); vi.clearAllMocks(); });
afterEach(() => hosts.splice(0).forEach(detachThemeListener));
afterEach(() => vi.unstubAllGlobals());

describe('theme preference sources and cross-tab propagation', () => {
  it('uses prototype blue for new/missing preferences and preserves explicitly saved indigo', async () => {
    expect(loadSettings().accentColor).toBe('#265f99');
    localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify({ accentColor: '#6366f1' }));
    expect(loadSettings().accentColor).toBe('#6366f1');
    api.getPreferences.mockResolvedValue({ preferences: { accentColor: '#409eff' } });
    expect((await syncPreferencesFromServer(loadSettings())).accentColor).toBe('#409eff');
    api.getPreferences.mockResolvedValue({ preferences: { accentColor: '#14b8a6' } });
    expect((await syncPreferencesFromServer(loadSettings())).accentColor).toBe('#14b8a6');
    api.getPreferences.mockResolvedValue({ preferences: {} });
    expect((await syncPreferencesFromServer(loadSettings())).accentColor).toBe('#6366f1');
  });
  it('updates another tab without echoing settings or replacing its session', async () => {
    const app = host();
    app.settings.sessionKey = app.settings.lastActiveSessionKey = 'tab-owned-session';
    syncThemeWithSettings(app);
    const setItem = vi.spyOn(localStorage, 'setItem');
    const next = { ...loadSettings(), accentColor: '#14b8a6', sessionKey: 'other-tab-session', fontDensity: 'compact' };
    localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(next)); localStorage.setItem('app-theme-mode', next.themeMode); setItem.mockClear();
    window.dispatchEvent(new StorageEvent('storage', { key: UI_SETTINGS_STORAGE_KEY, storageArea: localStorage }));
    expect(app.settings.accentColor).toBe('#14b8a6');
    expect(app.settings.sessionKey).toBe('tab-owned-session');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#14b8a6');
    expect(document.documentElement.dataset.density).toBe('compact');
    expect(setItem).not.toHaveBeenCalled();
    await Promise.resolve(); expect(api.savePreferences).not.toHaveBeenCalled();
    detachThemeListener(app);
    localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify({ accentColor: '#409eff' }));
    window.dispatchEvent(new StorageEvent('storage', { key: UI_SETTINGS_STORAGE_KEY, storageArea: localStorage }));
    expect(app.settings.accentColor).toBe('#14b8a6');
    setItem.mockRestore();
  });
  it('reasserts a saved mode when startup initialization changed only the DOM', () => {
    const app = host();
    applySettings(app, { ...app.settings, themeMode: 'dark' }, false);
    document.documentElement.dataset.themeMode = 'light';
    applySettings(app, app.settings, false);
    expect(document.documentElement.dataset.themeMode).toBe('dark');
    expect(localStorage.getItem('app-theme-mode')).toBe('dark');
  });
  it('keeps system theme observation in sync after a received preference change', () => {
    const listeners = new Set<() => void>();
    let light = true;
    vi.stubGlobal('matchMedia', () => ({ get matches() { return light; },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }));
    const app = host();
    applySettings(app, { ...app.settings, themeMode: 'light' }, false);
    expect(listeners.size).toBe(0);
    applySettings(app, { ...app.settings, themeMode: 'system' }, false);
    expect(listeners.size).toBe(1);
    light = false; listeners.forEach(listener => listener());
    expect(document.documentElement.dataset.themeMode).toBe('dark');
    applySettings(app, { ...app.settings, themeMode: 'light' }, false);
    expect(listeners.size).toBe(0);
  });
  it('clears obsolete palette overrides while retaining explicit current overrides', () => {
    const app = host();
    applySettings(app, { ...app.settings, btnPalette: { primaryBg: '#6366f1', ghostColor: '#aa0000' } }, false);
    expect(document.documentElement.style.getPropertyValue('--btn-primary-bg')).toBe('#6366f1');
    applySettings(app, { ...app.settings, accentColor: '#409eff', btnPalette: { primaryBg: '#14b8a6' } }, false);
    expect(document.documentElement.style.getPropertyValue('--btn-primary-bg')).toBe('#14b8a6');
    expect(document.documentElement.style.getPropertyValue('--btn-ghost-color')).toBe('');
    applySettings(app, { ...app.settings, btnPalette: undefined }, false);
    expect(document.documentElement.style.getPropertyValue('--btn-primary-bg')).toBe('');
  });
});
