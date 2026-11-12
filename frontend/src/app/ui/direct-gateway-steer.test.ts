import { afterEach, expect, it, vi } from 'vitest';
import { DirectGatewayClient } from './direct-gateway.ts';

afterEach(() => vi.useRealTimers());
function connected() {
  const client = new DirectGatewayClient({ onEvent() {}, onStateChange() {} });
  const send = vi.fn();
  Object.assign(client, { ws: { readyState: WebSocket.OPEN, send, close() {} }, authenticated: true });
  return { client, send };
}
it('correlates independent steer replies and never emits chat.send', async () => {
  const { client, send } = connected();
  const a = client.request('chat.steer', { sessionKey: 'A', message: 'first' });
  const b = client.request('chat.steer', { sessionKey: 'B', message: 'second' });
  const frames = send.mock.calls.map(([frame]) => JSON.parse(frame));
  expect(frames.map(f => f.type)).toEqual(['chat.steer', 'chat.steer']);
  for (const frame of frames.reverse()) (client as any).dispatchEvent({ type: 'steer.result', requestId: frame.requestId, status: 'queued', runId: frame.sessionKey });
  expect(await a).toMatchObject({ runId: 'A' }); expect(await b).toMatchObject({ runId: 'B' });
  client.disconnect();
});
it('timeout is unknown and does not replay', async () => {
  vi.useFakeTimers();
  const { client, send } = connected();
  const pending = client.request('chat.steer', { sessionKey: 'A', message: 'adjust' });
  const check = expect(pending).rejects.toThrow('回执未知');
  await vi.advanceTimersByTimeAsync(60_000); await check;
  expect(send).toHaveBeenCalledTimes(1); client.disconnect();
});
it('disconnect rejects a pending steer without preserving it for reconnect', async () => {
  const { client, send } = connected();
  const pending = client.request('chat.steer', { sessionKey: 'A', message: 'adjust' });
  const check = expect(pending).rejects.toThrow('回执未知');
  client.disconnect(); await check;
  expect((client as any).pendingSteers.size).toBe(0); expect(send).toHaveBeenCalledTimes(1);
});
