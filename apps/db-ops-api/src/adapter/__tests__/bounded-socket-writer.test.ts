import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { BoundedSocketWriter } from '../bounded-socket-writer.js';

describe('per-client bounded WS writes', () => {
  function controlledPeer() {
    const callbacks: Array<(error?: Error) => void> = [];
    const peer = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN, bufferedAmount: 0,
      send: vi.fn((_: string, callback: (error?: Error) => void) => callbacks.push(callback)),
      close: vi.fn(), terminate: vi.fn(),
    }) as unknown as WebSocket;
    return { peer, callbacks };
  }

  it('caps events including unacknowledged writes and drops only the slow peer', () => {
    const { peer, callbacks } = controlledPeer();
    const failure = vi.fn(); const writer = new BoundedSocketWriter({ maxPendingEvents: 2, maxPendingBytes: 100 }, failure);
    expect(writer.send(peer, 'a')).toBe(true); expect(writer.send(peer, 'b')).toBe(true);
    expect(writer.send(peer, 'c')).toBe(false);
    expect(peer.close).toHaveBeenCalledWith(4009, expect.stringContaining('reconnect'));
    expect(failure).toHaveBeenCalledWith('WS_SLOW_CONSUMER');
    callbacks.forEach(callback => callback());
    peer.emit('close');
  });

  it('accounts UTF-8 bytes, frame overhead, bufferedAmount, and async send errors', () => {
    const { peer } = controlledPeer();
    Object.assign(peer, { bufferedAmount: 88 });
    const failure = vi.fn(); const writer = new BoundedSocketWriter({ maxPendingBytes: 100 }, failure);
    expect(writer.send(peer, '中文')).toBe(false); expect(peer.send).not.toHaveBeenCalled();
    peer.emit('close');
    const { peer: other } = controlledPeer();
    vi.mocked(other.send).mockImplementation((_data, callback: any) => { callback(new Error('private credential')); });
    writer.send(other, 'ok');
    expect(other.terminate).toHaveBeenCalledTimes(1); expect(failure.mock.calls.at(-1)).toEqual(['WS_WRITE_FAILED']);
  });

  // GitHub #303: callbacks settle per write, failure/cleanup belongs to the connection.
  it.each(['callback', 'throw'])('reports and terminates once across in-flight failures (%s)', mode => {
    const { peer, callbacks } = controlledPeer();
    const failure = vi.fn();
    const writer = new BoundedSocketWriter({}, failure);
    for (let i = 0; i < 3; i++) expect(writer.send(peer, '中文')).toBe(true);
    if (mode === 'throw') {
      vi.mocked(peer.send).mockImplementationOnce(() => { throw new Error('disconnected'); });
      expect(writer.send(peer, 'last')).toBe(false);
    }
    callbacks.forEach(callback => { callback(new Error('disconnected')); callback(new Error('duplicate')); });
    expect(failure.mock.calls).toEqual([['WS_WRITE_FAILED']]);
    expect(peer.terminate).toHaveBeenCalledTimes(1);
    expect(writer.send(peer, 'late')).toBe(false);
    expect((writer as any).pending.get(peer)).toMatchObject({ bytes: 0, events: 0 });
    const { peer: healthy } = controlledPeer();
    expect(writer.send(healthy, 'ok')).toBe(true);
  });

  it('normal close suppresses late errors and still settles every write', () => {
    const { peer, callbacks } = controlledPeer();
    const failure = vi.fn();
    const writer = new BoundedSocketWriter({}, failure);
    for (let i = 0; i < 3; i++) writer.send(peer, 'x');
    peer.emit('close', 1000);
    callbacks.forEach(callback => callback(new Error('closed')));
    expect(failure).not.toHaveBeenCalled();
    expect(peer.terminate).not.toHaveBeenCalled();
    expect(writer.send(peer, 'late')).toBe(false);
    expect((writer as any).pending.get(peer)).toMatchObject({ bytes: 0, events: 0 });
  });

  it.each([true, false])('slow close owns late failures; close event received=%s', closes => {
    vi.useFakeTimers();
    try {
      const { peer, callbacks } = controlledPeer();
      const failure = vi.fn();
      const writer = new BoundedSocketWriter({ maxPendingEvents: 2, closeTimeoutMs: 25 }, failure);
      writer.send(peer, 'a'); writer.send(peer, 'b');
      expect(writer.send(peer, 'overflow')).toBe(false);
      callbacks.forEach(callback => callback(new Error('closing')));
      expect(writer.send(peer, 'late')).toBe(false);
      expect(peer.close).toHaveBeenCalledTimes(1);
      expect(failure.mock.calls).toEqual([['WS_SLOW_CONSUMER']]);
      expect((writer as any).pending.get(peer)).toMatchObject({ bytes: 0, events: 0 });
      if (closes) peer.emit('close', 4009);
      vi.advanceTimersByTime(100);
      expect(peer.terminate).toHaveBeenCalledTimes(closes ? 0 : 1);
    } finally { vi.useRealTimers(); }
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
