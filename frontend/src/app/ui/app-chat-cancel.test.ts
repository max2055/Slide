import { expect, it, vi } from 'vitest';
import { handleAbortChat, type ChatHost } from './app-chat.ts';
import { DirectGatewayClient } from './direct-gateway.ts';

const host = (cancelChat: () => boolean) => ({ connected: true, client: { cancelChat },
  chatRunId: 'run', sessionKey: 'session', chatSending: true, chatCancelRequested: false,
  lastError: null } as unknown as ChatHost);

it('keeps an accepted cancel pending until confirmation and suppresses duplicate sends', async () => {
  const send = vi.fn(() => true); const state = host(send);
  await handleAbortChat(state); await handleAbortChat(state);
  expect(send).toHaveBeenCalledExactlyOnceWith('run', 'session');
  expect(state.chatCancelRequested).toBe(true);
  expect(state.chatSending).toBe(true);
});

it('does not claim a cancel was sent when the socket is closed or unauthenticated', async () => {
  const client = Object.create(DirectGatewayClient.prototype);
  client.ws = { readyState: WebSocket.CLOSED, send: vi.fn() }; client.authenticated = true;
  const state = host(() => client.cancelChat('run', 'session'));
  await handleAbortChat(state);
  expect(state.chatCancelRequested).toBe(false);
  expect(state.chatSending).toBe(true);
  expect(state.lastError).toContain('未送达');
  client.ws.readyState = WebSocket.OPEN; client.authenticated = false;
  expect(client.cancelChat('run', 'session')).toBe(false);
  expect(client.ws.send).not.toHaveBeenCalled();
});

it('allows retry after a socket send failure without clearing the active run', async () => {
  const send = vi.fn<() => boolean>(() => { throw new Error('closed during send'); }); const state = host(send);
  await handleAbortChat(state);
  expect(state.chatCancelRequested).toBe(false);
  expect(state.chatRunId).toBe('run');
  send.mockImplementation(() => true); await handleAbortChat(state);
  expect(state.chatCancelRequested).toBe(true);
});
