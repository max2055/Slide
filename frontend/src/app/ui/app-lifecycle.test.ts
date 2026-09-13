import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ sync: vi.fn(), apply: vi.fn() }));
vi.mock('./storage.ts', () => ({ syncPreferencesFromServer: mocks.sync }));
vi.mock('./app-settings.ts', () => ({ applySettings: mocks.apply }));
import { syncUserPreferences } from './app-lifecycle.ts';
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
