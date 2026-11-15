import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiClient } from '../../api/index.js';
import { getProductName, refreshBrandingCache, resetBrandingCache, subscribeBranding } from './branding.js';
import { SLASH_COMMANDS, refreshSlashCommands } from '../ui/chat/slash-commands.ts';

const config = (name: string) => ({ cli_name: name.toLowerCase(), product_name: name, env_prefix: name.toUpperCase(), state_dir: '.' + name });
const response = (name: string) => new Response(JSON.stringify(config(name)));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); apiClient.setToken(null); resetBrandingCache(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('#407 defers anonymous loading and refreshes existing consumers after authentication and save', async () => {
  const fetch = vi.fn().mockResolvedValue(response('Acme')); vi.stubGlobal('fetch', fetch);
  await refreshBrandingCache();
  expect(fetch).not.toHaveBeenCalled(); expect(getProductName()).toBe('Slide');
  const changed = vi.fn(); const unsubscribe = subscribeBranding(changed);
  const commands = SLASH_COMMANDS;
  await refreshSlashCommands({ client: { request: async () => ({ commands: [{ key: 'remote', textAliases: ['/remote'], description: 'Remote command' }] }) } as any });
  const existingMenuCommand = commands.find(c => c.name === 'restart');
  apiClient.setToken('session-a'); await refreshBrandingCache();
  expect(existingMenuCommand?.description).toContain('Acme');
  expect(getProductName()).toBe('Acme'); expect(changed).toHaveBeenCalledOnce();
  expect(SLASH_COMMANDS).toBe(commands);
  expect(commands.find(c => c.name === 'restart')?.description).toContain('Acme');
  expect(commands.find(c => c.name === 'remote')).toBeDefined();
  fetch.mockResolvedValue(response('Renamed')); await refreshBrandingCache();
  expect(commands.find(c => c.name === 'restart')?.description).toContain('Renamed');
  unsubscribe(); resetBrandingCache(); expect(changed).toHaveBeenCalledTimes(2);
});

it.each(['logout', 'relogin', 'newer-refresh', 'json'])('#407 ignores old response across %s', async mode => {
  apiClient.setToken('session-a');
  const pending = deferred<Response>(); const json = deferred<unknown>();
  vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(mode === 'json' ? Promise.resolve({ ok: true, json: () => json.promise }) : pending.promise).mockResolvedValue(response('Current')));
  const old = refreshBrandingCache(); await Promise.resolve(); await Promise.resolve();
  if (mode === 'logout' || mode === 'json') { apiClient.setToken(null); resetBrandingCache(); }
  if (mode === 'relogin') { apiClient.setToken(null); apiClient.setToken('session-b'); await refreshBrandingCache(); }
  if (mode === 'newer-refresh') await refreshBrandingCache();
  pending.resolve(response('Stale')); json.resolve(config('Stale')); await old;
  expect(getProductName()).toBe(mode === 'logout' || mode === 'json' ? 'Slide' : 'Current');
});

it('#407 has bounded fallback for network errors, denied HTTP, malformed config and no window', async () => {
  apiClient.setToken('session-a');
  const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(new Response('{"product_name":null}'));
  vi.stubGlobal('fetch', fetch);
  await refreshBrandingCache(); await refreshBrandingCache(); await refreshBrandingCache();
  expect(getProductName()).toBe('Slide'); expect(fetch).toHaveBeenCalledTimes(3);
  vi.stubGlobal('window', undefined); await refreshBrandingCache();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('#407 aborts obsolete authentication reads before a late 401 can expire a new login', async () => {
  apiClient.setToken('session-a');
  const pending = deferred<Response>();
  const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(response('Current'));
  vi.stubGlobal('fetch', fetch);
  const expired = vi.fn(); window.addEventListener('slide-session-expired', expired);
  try {
    const old = refreshBrandingCache();
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    resetBrandingCache(); apiClient.setToken('session-b');
    await refreshBrandingCache();
    expect(signal.aborted).toBe(true);
    pending.resolve(new Response('', {status:401})); await old;
    expect(apiClient.getToken()).toBe('session-b'); expect(expired).not.toHaveBeenCalled();
    expect(getProductName()).toBe('Current'); expect(fetch).toHaveBeenCalledTimes(2);
  } finally { window.removeEventListener('slide-session-expired', expired); }
});
