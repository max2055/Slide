import { afterEach, expect, it, vi } from 'vitest';
import { refreshChatAvatar, type ChatHost } from './app-chat.ts';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const host = () => ({ connected: true, sessionKey: 'agent:main:main', basePath: '', chatAvatarUrl: null } as ChatHost);
afterEach(() => vi.unstubAllGlobals());

it.each(['response', 'body', 'failure'])('#639 disconnect invalidates pending %s; reconnect applies fresh avatar', async phase => {
  const pending = deferred<Response>(); const body = deferred<unknown>();
  const fetch = vi.fn().mockReturnValueOnce(phase === 'body' ? Promise.resolve({ ok: true, json: () => body.promise }) : pending.promise)
    .mockResolvedValue(new Response(JSON.stringify({ avatarUrl: '/fresh.png' })));
  vi.stubGlobal('fetch', fetch);
  const state = host(); const old = refreshChatAvatar(state);
  await Promise.resolve(); await Promise.resolve();
  state.connected = false; await refreshChatAvatar(state);
  expect(state.chatAvatarUrl).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
  state.connected = true; await refreshChatAvatar(state); expect(state.chatAvatarUrl).toBe('/fresh.png');
  pending.resolve(phase === 'failure' ? new Response('', { status: 500 }) : new Response(JSON.stringify({ avatarUrl: '/stale.png' })));
  body.resolve({ avatarUrl: '/stale.png' }); await old;
  expect(state.chatAvatarUrl).toBe('/fresh.png');
});

it('#639 never writes the old avatar while disconnected', async () => {
  const pending = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  const state = host(); const old = refreshChatAvatar(state);
  state.connected = false; await refreshChatAvatar(state);
  pending.resolve(new Response(JSON.stringify({ avatarUrl: '/stale.png' }))); await old;
  expect(state.chatAvatarUrl).toBeNull();
});

it('#639 rejects another session and safely handles a failed new request', async () => {
  const pending = deferred<Response>(); const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetch); const state = host(); const old = refreshChatAvatar(state);
  state.sessionKey = 'agent:other:main'; pending.resolve(new Response(JSON.stringify({ avatarUrl: '/stale.png' }))); await old;
  expect(state.chatAvatarUrl).toBeNull(); await refreshChatAvatar(state); expect(state.chatAvatarUrl).toBeNull();
});
