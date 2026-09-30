import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { StreamingCoordinator } from '../../packages/agent-core/src/runtime/streaming-coordinator.js';
import { BoundedSocketWriter } from '../../apps/db-ops-api/src/adapter/bounded-socket-writer.js';

const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const { WebSocket, WebSocketServer } = require('ws');
type Event = { type: 'text' | 'reasoning'; delta: string };
const samples = 1000;
const limits = { maxPendingEvents: 32, maxPendingBytes: 4096, consumerTimeoutMs: 1000 };
const round = (n: number) => Math.round(n * 100) / 100;
const results: Record<string, unknown>[] = [];

for (const mode of ['direct-await', 'queued', 'queued-text-merge']) {
  const started = performance.now(); const heapStart = process.memoryUsage().heapUsed;
  let heapPeak = heapStart; let firstToken = 0; let writes = 0; let text = '';
  const write = async (event: Event) => {
    await delay(1); writes++;
    if (!firstToken) firstToken = performance.now() - started;
    text += event.delta;
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  };
  const queue = mode === 'direct-await' ? undefined : new StreamingCoordinator<Event>(write, {
    ...limits, size: e => Buffer.byteLength(e.delta) + 32,
    ...(mode === 'queued-text-merge' ? { merge: (a: Event, b: Event): Event | undefined =>
      a.type === 'text' && b.type === 'text' ? { type: 'text', delta: a.delta + b.delta } : undefined } : {}),
  });
  let source = '';
  for (let i = 0; i < samples; i++) {
    const event: Event = { type: i % 10 === 0 ? 'reasoning' : 'text', delta: `${i}:中文;`.padEnd(64, 'x') };
    source += event.delta;
    if (queue) await queue.enqueue(event); else await write(event);
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  }
  const readerMs = performance.now() - started;
  await queue?.drain(); const totalMs = performance.now() - started;
  assert.equal(text, source);
  assert((queue?.metrics.peakBytes ?? 0) <= limits.maxPendingBytes);
  assert((queue?.metrics.peakEvents ?? 0) <= limits.maxPendingEvents);
  results.push({ mode, sourceEvents: samples, consumerWrites: writes, readerMs: round(readerMs),
    totalMs: round(totalMs), throughputEventsPerS: round(samples / totalMs * 1000), firstTokenMs: round(firstToken),
    drainMs: round(totalMs - readerMs), peakPendingBytes: queue?.metrics.peakBytes ?? 100,
    peakPendingEvents: queue?.metrics.peakEvents ?? 1, heapStart, heapPeak, heapGrowthBytes: heapPeak - heapStart });
}

for (const mode of ['legacy-ws-send', 'bounded-ws-send']) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const connected = once(server, 'connection'); const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await once(client, 'open'); const [peer] = await connected;
  const writer = new BoundedSocketWriter(); const started = performance.now();
  let firstToken = 0; let received = 0; let peakBufferedBytes = 0;
  let complete!: () => void; const consumed = new Promise<void>(r => { complete = r; });
  client.on('message', () => { if (!firstToken) firstToken = performance.now() - started; if (++received === samples) complete(); });
  try {
    for (let i = 0; i < samples; i++) {
      const event = JSON.stringify({ type: 'text_delta', delta: 'x'.repeat(64), sequence: i });
      if (mode === 'legacy-ws-send') peer.send(event); else assert(writer.send(peer, event));
      peakBufferedBytes = Math.max(peakBufferedBytes, peer.bufferedAmount);
      if (i % 16 === 0) await new Promise<void>(r => setImmediate(r));
    }
    const readerMs = performance.now() - started;
    await consumed; const totalMs = performance.now() - started;
    results.push({ mode, sourceEvents: samples, readerMs: round(readerMs), totalMs: round(totalMs),
      firstTokenMs: round(firstToken), drainMs: round(totalMs - readerMs), peakBufferedBytes,
      throughputEventsPerS: round(samples / totalMs * 1000), heapUsed: process.memoryUsage().heapUsed });
  } finally { client.terminate(); peer.terminate(); await new Promise<void>(r => server.close(() => r())); }
}
const sources = ['packages/agent-core/src/runtime/streaming-coordinator.ts', 'packages/agent-core/src/runtime/model-step.ts',
  'packages/agent-core/src/openai-provider.ts', 'apps/db-ops-api/src/adapter/chat-event-consumer.ts',
  'apps/db-ops-api/src/adapter/direct-adapter.ts', 'apps/db-ops-api/src/adapter/bounded-socket-writer.ts'];
const sourceHash = createHash('sha256'); for (const path of sources) sourceHash.update(readFileSync(new URL(`../../${path}`, import.meta.url)));
console.log(JSON.stringify({ node: process.version, pid: process.pid, limits, sourceSha256: sourceHash.digest('hex'),
  notes: 'Controlled 1ms hook; heap samples are process observations, not isolated retained-heap accounting. WS uses real loopback peers, not browser consumption acknowledgements. WS throughput changes are overhead/noise, not evidence of relieved SSE backpressure.', results }, null, 2));
