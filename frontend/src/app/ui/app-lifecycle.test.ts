import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ sync: vi.fn(), apply: vi.fn(), detach: vi.fn() }));
vi.mock('./storage.ts', () => ({ syncPreferencesFromServer: mocks.sync }));
vi.mock('./app-settings.ts', () => ({ applySettings: mocks.apply, detachThemeListener: mocks.detach }));
import { syncUserPreferences, handleDisconnected } from './app-lifecycle.ts';
afterEach(() => vi.clearAllMocks());
it.each([false, true])('applies bootstrap settings only before a local edit (edited=%s)', async edited => {
  let finish!: (value: any) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  mocks.sync.mockImplementation(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const host = { settings: { username: '', theme: 'claw' } } as any;
  const pending = syncUserPreferences(host);
  await ready;
  if (edited) host.settings = { ...host.settings, username: 'admin' };
  finish({ username: '', theme: 'knot' });
  await pending;
  if (edited) {
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(host.settings.username).toBe('admin');
  } else expect(mocks.apply).toHaveBeenCalledWith(host, { username: '', theme: 'knot' });
});

it('disconnect invalidates pending connects and releases listeners, client and observer', () => {
  const popStateHandler = vi.fn();
  const disconnect = vi.fn();
  const observerDisconnect = vi.fn();
  const host = { connectGeneration: 2, connected: true, client: { disconnect },
    popStateHandler, topbarObserver: { disconnect: observerDisconnect } } as any;
  window.addEventListener('popstate', popStateHandler);
  handleDisconnected(host);
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(popStateHandler).not.toHaveBeenCalled();
  expect(host.connectGeneration).toBe(3);
  expect(host.connected).toBe(false);
  expect(host.client).toBeNull();
  expect(host.topbarObserver).toBeNull();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(observerDisconnect).toHaveBeenCalledOnce();
  expect(mocks.detach).toHaveBeenCalledWith(host);
});
