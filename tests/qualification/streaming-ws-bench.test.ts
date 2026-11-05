import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  establishBenchmarkConnection,
  runWsSendBenchmark,
  type WsBenchHandles,
} from './streaming-ws-bench.ts';

const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const { WebSocket } = require('ws');

function track(server: Server, onConnection: (socket: Socket) => void): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  return sockets;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return address.port;
}

async function stop(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
}

test('streaming websocket benchmark deadlines, failures, cleanup, and 1000-event metrics', async (t) => {
  const leaks: unknown[] = [];
  const onException = (error: unknown) => leaks.push(error);
  const onRejection = (error: unknown) => leaks.push(error);
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  try {
    await t.test('script delegates the websocket sample and keeps the metric formula', () => {
      const script = readFileSync(new URL('./streaming.ts', import.meta.url), 'utf8');
      const bench = readFileSync(new URL('./streaming-ws-bench.ts', import.meta.url), 'utf8');
      assert.match(script, /runWsSendBenchmark\(\{ mode, samples \}\)/);
      assert.doesNotMatch(script, /await consumed/);
      assert.match(bench, /throughputEventsPerS: round\(samples \/ totalMs \* 1000\)/);
      assert.match(bench, /drainMs: round\(totalMs - readerMs\)/);
      assert.match(bench, /WebSocket handshake timed out after \$\{handshakeTimeoutMs\}ms/);
      assert.match(bench, /WebSocket consume timed out after/);
    });

    await t.test('handshake deadline rejects a silent loopback socket', async () => {
      const tcp = createServer();
      const tracked = track(tcp, (socket) => { socket.pause(); });
      const port = await listen(tcp);
      const started = Date.now();
      try {
        await assert.rejects(
          () => establishBenchmarkConnection({ endpoint: `ws://127.0.0.1:${port}`, handshakeTimeoutMs: 80 }),
          /WebSocket handshake timed out after 80ms/,
        );
        assert.ok(Date.now() - started < 1000);
      } finally {
        await stop(tcp, tracked);
      }
    });

    await t.test('client handshake error is retained and does not hang', async () => {
      const tcp = createServer();
      const tracked = track(tcp, (socket) => {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      });
      const port = await listen(tcp);
      const started = Date.now();
      try {
        await assert.rejects(
          () => establishBenchmarkConnection({ endpoint: `ws://127.0.0.1:${port}`, handshakeTimeoutMs: 1000 }),
          /WebSocket client error:/,
        );
        assert.ok(Date.now() - started < 1000);
      } finally {
        await stop(tcp, tracked);
      }
    });

    await t.test('consume deadline rejects when samples never arrive', async () => {
      const started = Date.now();
      let handles: WsBenchHandles | undefined;
      await assert.rejects(
        () => runWsSendBenchmark({
          mode: 'legacy-ws-send',
          samples: 10,
          consumeTimeoutMs: 80,
          stallConsumption: true,
          afterOpen: (open) => { handles = open; },
        }),
        /WebSocket consume timed out after 80ms: received 0\/10/,
      );
      assert.ok(Date.now() - started < 2000);
      assertClosed(handles);
    });

    await t.test('peer early close 1000 fails with the close reason', async () => {
      const started = Date.now();
      let handles: WsBenchHandles | undefined;
      await assert.rejects(
        () => runWsSendBenchmark({
          mode: 'legacy-ws-send',
          samples: 30,
          consumeTimeoutMs: 2000,
          afterOpen: (open) => {
            handles = open;
            open.peer.close(1000, 'early');
          },
        }),
        /WebSocket (?:peer|client) closed before consume completed: received \d+\/30 code=1000 reason=early/,
      );
      assert.ok(Date.now() - started < 2000);
      assertClosed(handles);
    });

    await t.test('client early close fails with the close reason', async () => {
      let handles: WsBenchHandles | undefined;
      await assert.rejects(
        () => runWsSendBenchmark({
          mode: 'bounded-ws-send',
          samples: 30,
          consumeTimeoutMs: 2000,
          afterOpen: (open) => {
            handles = open;
            open.client.close(4001, 'client-early');
          },
        }),
        /WebSocket (?:peer|client) closed before consume completed: received \d+\/30 code=4001 reason=client-early/,
      );
      assertClosed(handles);
    });

    await t.test('client, peer, and server errors fail and release sockets', async () => {
      for (const source of ['client', 'peer', 'server'] as const) {
        let handles: WsBenchHandles | undefined;
        await assert.rejects(
          () => runWsSendBenchmark({
            mode: 'bounded-ws-send',
            samples: 10,
            consumeTimeoutMs: 2000,
            afterOpen: (open) => {
              handles = open;
              const error = new Error(`${source} failed`);
              if (source === 'server') open.server.emit('error', error);
              else open[source].emit('error', error);
            },
          }),
          new RegExp(`WebSocket ${source} error: ${source} failed`),
        );
        assertClosed(handles);
      }
    });

    await t.test('normal close 1000 after the full sample still resolves', async () => {
      const result = await runWsSendBenchmark({
        mode: 'legacy-ws-send',
        samples: 8,
        afterOpen: ({ client, peer }) => {
          let seen = 0;
          client.on('message', () => {
            seen += 1;
            if (seen === 8) peer.close(1000, 'done');
          });
        },
      });
      assert.equal(result.sourceEvents, 8);
      assert.equal(result.mode, 'legacy-ws-send');
    });

    await t.test('1000 real loopback events keep the metric fields for both send modes', async () => {
      for (const mode of ['legacy-ws-send', 'bounded-ws-send'] as const) {
        let handles: WsBenchHandles | undefined;
        const result = await runWsSendBenchmark({
          mode,
          samples: 1000,
          afterOpen: (open) => { handles = open; },
        });
        assert.deepEqual(Object.keys(result), [
          'mode', 'sourceEvents', 'readerMs', 'totalMs', 'firstTokenMs', 'drainMs',
          'peakBufferedBytes', 'throughputEventsPerS', 'heapUsed',
        ]);
        assert.equal(result.mode, mode);
        assert.equal(result.sourceEvents, 1000);
        assert.ok(result.totalMs > 0);
        assert.ok(result.readerMs <= result.totalMs);
        assert.ok(result.firstTokenMs >= 0);
        assert.ok(result.drainMs >= 0);
        assert.ok(result.peakBufferedBytes >= 0);
        assert.ok(result.throughputEventsPerS > 0);
        assert.ok(result.heapUsed > 0);
        assertClosed(handles);
      }
    });
  } finally {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
    assert.deepEqual(leaks, []);
  }
});

function assertClosed(handles: WsBenchHandles | undefined): void {
  assert.ok(handles);
  assert.equal(handles.client.readyState, WebSocket.CLOSED);
  assert.equal(handles.peer.readyState, WebSocket.CLOSED);
  assert.equal(handles.server.address(), null);
  assert.equal(handles.client.listenerCount('message'), 0);
  assert.equal(handles.client.listenerCount('error'), 0);
  assert.equal(handles.peer.listenerCount('error'), 0);
}
