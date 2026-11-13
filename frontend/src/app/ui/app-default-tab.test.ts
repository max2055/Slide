import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sync: vi.fn(), apply: vi.fn(), select: vi.fn(), url: vi.fn(), revision: vi.fn(),
}));
vi.mock('./storage.ts', () => ({ syncPreferencesFromServer: mocks.sync }));
vi.mock('./app-settings.ts', () => ({
  applySettings: mocks.apply, setTabFromRoute: mocks.select, syncUrlWithTab: mocks.url,
  getTabSelectionRevision: mocks.revision,
}));
import { syncUserPreferences } from './app-lifecycle.ts';

afterEach(() => vi.resetAllMocks());

it.each([
  ['feedback', 'dashboard', true],
  ['dashboard', 'feedback', true],
  ['feedback', 'feedback', false],
  ['feedback', 'server-detail', false],
  ['feedback', 'unknown', false],
])('MAX-659 landing %s → %s navigates=%s', async (tab, defaultTab, navigates) => {
  window.history.replaceState({}, '', '/dashboard');
  const host = { settings: { defaultTab: tab }, connectGeneration: 1, tab } as any;
  const merged = { defaultTab };
  mocks.revision.mockReturnValue(1);
  mocks.sync.mockResolvedValue(merged);
  mocks.apply.mockImplementation((h, next) => { h.settings = next; });
  await syncUserPreferences(host, true);
  expect(mocks.apply).toHaveBeenCalledWith(host, merged);
  expect(mocks.select).toHaveBeenCalledTimes(navigates ? 1 : 0);
  if (navigates) {
    expect(mocks.select).toHaveBeenCalledWith(host, defaultTab);
    expect(mocks.url).toHaveBeenCalledWith(host, defaultTab, true);
  } else expect(mocks.url).not.toHaveBeenCalled();
});

it.each(['navigation', 'url', 'edit', 'disconnect', 'deep-link'])('MAX-659 delayed response respects %s', async change => {
  window.history.replaceState({}, '', '/dashboard');
  const host = { settings: { defaultTab: 'dashboard' }, connectGeneration: 1, tab: 'dashboard' } as any;
  let finish!: (value: any) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  mocks.revision.mockReturnValue(1);
  mocks.sync.mockImplementation(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  mocks.apply.mockImplementation((h, next) => { h.settings = next; });
  const pending = syncUserPreferences(host, change !== 'deep-link');
  await ready;
  if (change === 'navigation') mocks.revision.mockReturnValue(3); // away and back
  if (change === 'url') window.history.pushState({}, '', '/feedback');
  if (change === 'edit') host.settings = { ...host.settings };
  if (change === 'disconnect') host.connectGeneration++;
  finish({ defaultTab: 'settings' });
  await pending;
  expect(mocks.apply).toHaveBeenCalledTimes(['edit', 'disconnect'].includes(change) ? 0 : 1);
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.url).not.toHaveBeenCalled();
});
