import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ getPreferences: vi.fn(), savePreferences: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('../../api/preferences.ts', () => ({ preferencesAPI: api }));
import { loadSettings, saveSettings, syncPreferencesFromServer, UI_SETTINGS_STORAGE_KEY } from './storage.ts';

beforeEach(() => { vi.stubGlobal('localStorage', window.localStorage); localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());
describe('MAX-661 sidebar selection persistence', () => {
  it.each([{}, { visibleTabs: [] }, { visibleTabs: ['chat'] }, { visibleTabs: [], visibleTabsConfigured: true }])('round-trips legacy and explicit records: %j', async record => {
    localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(record));
    const settings = loadSettings(); saveSettings(settings);
    expect(loadSettings().visibleTabs).toEqual(settings.visibleTabs);
    expect(loadSettings().visibleTabsConfigured).toBe(record.visibleTabsConfigured === true);
    await vi.waitFor(() => expect(api.savePreferences).toHaveBeenCalled());
    expect(api.savePreferences.mock.calls[0][0]).toMatchObject({ visibleTabs: settings.visibleTabs, visibleTabsConfigured: record.visibleTabsConfigured === true });
  });
  it('preserves an explicit empty selection on server sync and saves it locally', async () => {
    api.getPreferences.mockResolvedValue({ preferences: { visibleTabs: [], visibleTabsConfigured: true } });
    const synced = await syncPreferencesFromServer(loadSettings());
    saveSettings(synced);
    expect(loadSettings()).toMatchObject({ visibleTabs: [], visibleTabsConfigured: true });
  });
  it('does not attach a stale explicit marker to a legacy server list', async () => {
    api.getPreferences.mockResolvedValue({ preferences: { visibleTabs: [] } });
    const synced = await syncPreferencesFromServer({ ...loadSettings(), visibleTabsConfigured: true });
    expect(synced).toMatchObject({ visibleTabs: [], visibleTabsConfigured: false });
  });
  it('keeps local selection when the server has no visibility fields', async () => {
    api.getPreferences.mockResolvedValue({ preferences: { locale: 'zh-CN' } });
    const synced = await syncPreferencesFromServer({ ...loadSettings(), visibleTabs: [], visibleTabsConfigured: true });
    expect(synced).toMatchObject({ visibleTabs: [], visibleTabsConfigured: true });
  });
});
