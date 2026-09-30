import { WebSocket } from 'ws';

export interface SocketWriteLimits {
  maxPendingBytes?: number;
  maxPendingEvents?: number;
  closeTimeoutMs?: number;
}

/** Transport acceptance is not browser consumption. A slow peer is evicted;
 * it must reconnect and query authorized durable history/run.snapshot. */
export class BoundedSocketWriter {
  private readonly pending = new WeakMap<WebSocket, { bytes: number; events: number }>();
  readonly maxBytes: number;
  readonly maxEvents: number;
  readonly closeTimeoutMs: number;

  constructor(limits: SocketWriteLimits = {}, private readonly onFailure?: (code: string) => void) {
    this.maxBytes = limits.maxPendingBytes ?? 1024 * 1024;
    this.maxEvents = limits.maxPendingEvents ?? 128;
    this.closeTimeoutMs = limits.closeTimeoutMs ?? 1000;
    for (const value of [this.maxBytes, this.maxEvents, this.closeTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid WS write limit');
    }
  }

  send(ws: WebSocket, serialized: string): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const state = this.pending.get(ws) ?? { bytes: 0, events: 0 };
    this.pending.set(ws, state);
    const bytes = Buffer.byteLength(serialized, 'utf8') + 14; // upper bound on WS frame header
    if (Math.max(state.bytes, ws.bufferedAmount) + bytes > this.maxBytes || state.events >= this.maxEvents) {
      this.onFailure?.('WS_SLOW_CONSUMER');
      ws.close(4009, 'Slow consumer; reconnect for history/snapshot');
      const timer = setTimeout(() => ws.terminate(), this.closeTimeoutMs);
      timer.unref();
      ws.once('close', () => clearTimeout(timer));
      return false;
    }
    state.bytes += bytes; state.events++;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; state.bytes -= bytes; state.events--;
      if (error) { this.onFailure?.('WS_WRITE_FAILED'); ws.terminate(); }
    };
    try { ws.send(serialized, finish); }
    catch (error) { finish(error instanceof Error ? error : new Error('WS send failed')); return false; }
    return true;
  }
}
