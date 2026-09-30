import { describe, it, expect, vi } from 'vitest';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { BoundedSocketWriter } from '../bounded-socket-writer.js';

describe('per-client bounded WS writes', () => {
  it('caps events including unacknowledged writes and drops only the slow peer', () => {
    const callbacks: Array<(error?: Error) => void> = [];
    const peer = { readyState: WebSocket.OPEN, bufferedAmount: 0,
      send: vi.fn((_: string, callback: (error?: Error) => void) => callbacks.push(callback)),
      close: vi.fn(), terminate: vi.fn(), once: vi.fn((_: string, callback: () => void) => callback()) } as unknown as WebSocket;
    const failure = vi.fn(); const writer = new BoundedSocketWriter({ maxPendingEvents: 2, maxPendingBytes: 100 }, failure);
    expect(writer.send(peer, 'a')).toBe(true); expect(writer.send(peer, 'b')).toBe(true);
    expect(writer.send(peer, 'c')).toBe(false);
    expect(peer.close).toHaveBeenCalledWith(4009, expect.stringContaining('reconnect'));
    expect(failure).toHaveBeenCalledWith('WS_SLOW_CONSUMER');
    callbacks.forEach(callback => callback());
  });

  it('accounts UTF-8 bytes, frame overhead, bufferedAmount, and async send errors', () => {
    const peer = { readyState: WebSocket.OPEN, bufferedAmount: 88,
      send: vi.fn(), close: vi.fn(), terminate: vi.fn(), once: vi.fn((_: string, callback: () => void) => callback()) } as unknown as WebSocket;
    const failure = vi.fn(); const writer = new BoundedSocketWriter({ maxPendingBytes: 100 }, failure);
    expect(writer.send(peer, '中文')).toBe(false); expect(peer.send).not.toHaveBeenCalled();
    Object.assign(peer, { bufferedAmount: 0 });
    vi.mocked(peer.send).mockImplementation((_data, callback: any) => { callback(new Error('private credential')); });
    writer.send(peer, 'ok');
    expect(peer.terminate).toHaveBeenCalled(); expect(failure.mock.calls.at(-1)).toEqual(['WS_WRITE_FAILED']);
  });

  it('real paused TCP client is evicted while a second client receives the complete sequence', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const peers: WebSocket[] = [];
    server.on('connection', ws => { peers.push(ws); });
    const slow = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(slow, 'open');
    const healthy = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(healthy, 'open');
    const writer = new BoundedSocketWriter({ maxPendingBytes: 256 * 1024, closeTimeoutMs: 25 });
    const received: number[] = [];
    healthy.on('message', data => received.push(JSON.parse(String(data)).sequence));
    (slow as any)._socket.pause();
    let peakBuffered = 0; let sent = 0;
    try {
      const closed = once(peers[0], 'close');
      for (; sent < 1024 && peers[0].readyState === WebSocket.OPEN; sent++) {
        const payload = JSON.stringify({ type: 'text_delta', sequence: sent, delta: 'x'.repeat(64 * 1024) });
        const next = once(healthy, 'message');
        writer.send(peers[0], payload); expect(writer.send(peers[1], payload)).toBe(true);
        peakBuffered = Math.max(peakBuffered, peers[0].bufferedAmount);
        expect(peers[0].bufferedAmount).toBeLessThanOrEqual(writer.maxBytes);
        await next;
      }
      expect(sent).toBeLessThan(1024); await closed;
      const terminal = once(healthy, 'message');
      expect(writer.send(peers[1], JSON.stringify({ type: 'complete', sequence: sent }))).toBe(true);
      await terminal;
      expect(received).toEqual(Array.from({ length: sent + 1 }, (_, i) => i));
      expect(peakBuffered).toBeGreaterThan(0); expect(peers[1].readyState).toBe(WebSocket.OPEN);
    } finally {
      slow.terminate(); healthy.terminate(); peers.forEach(peer => peer.terminate());
      await new Promise<void>(r => server.close(() => r()));
    }
  }, 10_000);
});
