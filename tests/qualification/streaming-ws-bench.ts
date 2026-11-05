import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { BoundedSocketWriter } from '../../apps/db-ops-api/src/adapter/bounded-socket-writer.js';

const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const { WebSocket, WebSocketServer } = require('ws');

export const WS_HANDSHAKE_TIMEOUT_MS = 5_000;
export const WS_CONSUME_TIMEOUT_MS = 30_000;

export type WsSendMode = 'legacy-ws-send' | 'bounded-ws-send';

export interface WsSendBenchmarkResult {
  mode: WsSendMode;
  sourceEvents: number;
  readerMs: number;
  totalMs: number;
  firstTokenMs: number;
  drainMs: number;
  peakBufferedBytes: number;
  throughputEventsPerS: number;
  heapUsed: number;
}

export interface WsBenchHandles {
  server: WebSocketServer;
  client: WebSocket;
  peer: WebSocket;
}

const round = (n: number) => Math.round(n * 100) / 100;

function socketError(source: 'client' | 'peer' | 'server', error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`WebSocket ${source} error: ${message}`);
  if (error instanceof Error) wrapped.cause = error;
  return wrapped;
}

function earlyClose(source: 'client' | 'peer', received: number, samples: number, code: number, reason: unknown): Error {
  const text = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason ?? '');
  return new Error(`WebSocket ${source} closed before consume completed: received ${received}/${samples} code=${code} reason=${text}`);
}

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(0, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function shutdownSocket(socket: WebSocket | undefined): Promise<void> {
  if (!socket) return;
  if (socket.readyState === WebSocket.CLOSED) {
    socket.removeAllListeners();
    return;
  }
  const closed = once(socket, 'close').then(() => undefined, () => undefined);
  socket.on('error', () => undefined);
  try { socket.terminate(); } catch { /* already destroyed */ }
  await Promise.race([closed, delay(500)]);
  socket.removeAllListeners();
}

type FailureGate = {
  fail: (error: Error) => void;
  race: <T>(promise: Promise<T>) => Promise<T>;
  current: () => Error | undefined;
};

function createFailureGate(): FailureGate {
  let failure: Error | undefined;
  let rejectFailure: (error: Error) => void = () => undefined;
  const failurePromise = new Promise<never>((_, reject) => { rejectFailure = reject; });
  void failurePromise.catch(() => undefined);
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    rejectFailure(error);
  };
  const race = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => { if (settled) return; settled = true; fn(); };
    promise.then(
      (value) => done(() => resolve(value)),
      (error) => done(() => reject(failure ?? error)),
    );
    failurePromise.then(() => undefined, (error) => done(() => reject(error)));
  });
  return { fail, race, current: () => failure };
}

export async function establishBenchmarkConnection(options: {
  handshakeTimeoutMs?: number;
  endpoint?: string;
} = {}): Promise<{ server?: WebSocketServer; client: WebSocket; peer?: WebSocket; release: () => Promise<void> }> {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? WS_HANDSHAKE_TIMEOUT_MS;
  const gate = createFailureGate();
  const started = Date.now();
  const remaining = () => handshakeTimeoutMs - (Date.now() - started);
  const handshakeTimedOut = `WebSocket handshake timed out after ${handshakeTimeoutMs}ms`;
  let server: WebSocketServer | undefined;
  let client: WebSocket | undefined;
  let peer: WebSocket | undefined;
  let released = false;
  let closing = false;
  const release = async () => {
    if (released) return;
    released = true;
    closing = true;
    await shutdownSocket(client);
    await shutdownSocket(peer);
    if (!server) return;
    server.removeAllListeners();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 1000);
      server?.close(() => { clearTimeout(timer); resolve(); });
    });
  };
  try {
    if (!options.endpoint) {
      server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      server.on('error', (error: unknown) => { if (!closing) gate.fail(socketError('server', error)); });
      await gate.race(withDeadline(once(server, 'listening'), remaining(), handshakeTimedOut));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('WebSocket benchmark server has no port');
      const connected = once(server, 'connection');
      void connected.catch(() => undefined);
      client = new WebSocket(`ws://127.0.0.1:${address.port}`);
      client.on('error', (error: unknown) => { if (!closing) gate.fail(socketError('client', error)); });
      await gate.race(withDeadline(once(client, 'open'), remaining(), handshakeTimedOut));
      const [accepted] = await gate.race(withDeadline(connected, remaining(), handshakeTimedOut));
      peer = accepted;
      peer.on('error', (error: unknown) => { if (!closing) gate.fail(socketError('peer', error)); });
    } else {
      client = new WebSocket(options.endpoint);
      client.on('error', (error: unknown) => { if (!closing) gate.fail(socketError('client', error)); });
      await gate.race(withDeadline(once(client, 'open'), remaining(), handshakeTimedOut));
    }
    if (gate.current()) throw gate.current();
    return { server, client, peer, release };
  } catch (error) {
    const reason = gate.current() ?? (error instanceof Error ? error : new Error(String(error)));
    await release();
    throw reason;
  }
}

/** Loopback send/consume sample. Deadlines reject; they are not part of the success timing window. */
export async function runWsSendBenchmark(options: {
  mode: WsSendMode;
  samples?: number;
  handshakeTimeoutMs?: number;
  consumeTimeoutMs?: number;
  afterOpen?: (handles: WsBenchHandles) => void | Promise<void>;
  /** Test-only: leave the sample counter short so the consume deadline rejects. */
  stallConsumption?: boolean;
}): Promise<WsSendBenchmarkResult> {
  const samples = options.samples ?? 1000;
  const consumeTimeoutMs = options.consumeTimeoutMs ?? WS_CONSUME_TIMEOUT_MS;
  const gate = createFailureGate();
  let connection: Awaited<ReturnType<typeof establishBenchmarkConnection>> | undefined;
  let finished = false;
  let consumeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    connection = await establishBenchmarkConnection({ handshakeTimeoutMs: options.handshakeTimeoutMs });
    const server = connection.server;
    const client = connection.client;
    const peer = connection.peer;
    if (!server || !peer) throw new Error('WebSocket benchmark connection is incomplete');
    let received = 0;
    let started = 0;
    client.on('close', (code: number, reason: Buffer) => {
      if (!finished) gate.fail(earlyClose('client', received, samples, code, reason));
    });
    peer.on('close', (code: number, reason: Buffer) => {
      if (!finished) gate.fail(earlyClose('peer', received, samples, code, reason));
    });
    server.on('error', (error: unknown) => { if (!finished) gate.fail(socketError('server', error)); });
    client.on('error', (error: unknown) => { if (!finished) gate.fail(socketError('client', error)); });
    peer.on('error', (error: unknown) => { if (!finished) gate.fail(socketError('peer', error)); });
    let firstToken = 0;
    let complete: () => void = () => undefined;
    const consumed = new Promise<void>((resolve) => {
      complete = () => { finished = true; resolve(); };
    });
    client.on('message', () => {
      if (started && !firstToken) firstToken = performance.now() - started;
      if (options.stallConsumption) return;
      if (++received === samples) {
        clearTimeout(consumeTimer);
        complete();
      }
    });
    if (options.afterOpen) await options.afterOpen({ server, client, peer });
    if (gate.current()) throw gate.current();
    // Clock starts after the handshake so deadline and setup work stay out of the reported rates.
    started = performance.now();
    consumeTimer = setTimeout(() => {
      gate.fail(new Error(`WebSocket consume timed out after ${consumeTimeoutMs}ms: received ${received}/${samples}`));
    }, consumeTimeoutMs);
    const writer = new BoundedSocketWriter();
    let peakBufferedBytes = 0;
    for (let i = 0; i < samples; i++) {
      if (gate.current()) throw gate.current();
      if (peer.readyState !== WebSocket.OPEN || client.readyState !== WebSocket.OPEN) {
        const pending = gate.race(new Promise<never>(() => undefined)).catch((error: Error) => error);
        const closed = await Promise.race([pending, delay(500).then(() => undefined)]);
        throw closed ?? gate.current() ?? earlyClose(
          client.readyState === WebSocket.OPEN ? 'peer' : 'client', received, samples, 1006, 'socket no longer open');
      }
      const event = JSON.stringify({ type: 'text_delta', delta: 'x'.repeat(64), sequence: i });
      try {
        if (options.mode === 'legacy-ws-send') peer.send(event);
        else assert(writer.send(peer, event));
      } catch (error) {
        if (gate.current()) throw gate.current();
        throw error instanceof Error ? error : new Error(String(error));
      }
      peakBufferedBytes = Math.max(peakBufferedBytes, peer.bufferedAmount);
      if (i % 16 === 0) await gate.race(new Promise<void>((resolve) => setImmediate(resolve)));
    }
    const readerMs = performance.now() - started;
    await gate.race(consumed);
    const totalMs = performance.now() - started;
    clearTimeout(consumeTimer);
    return {
      mode: options.mode,
      sourceEvents: samples,
      readerMs: round(readerMs),
      totalMs: round(totalMs),
      firstTokenMs: round(firstToken),
      drainMs: round(totalMs - readerMs),
      peakBufferedBytes,
      throughputEventsPerS: round(samples / totalMs * 1000),
      heapUsed: process.memoryUsage().heapUsed,
    };
  } finally {
    finished = true;
    clearTimeout(consumeTimer);
    await connection?.release();
  }
}
