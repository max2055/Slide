import { it, expect } from 'vitest';
import { consumeChatEvent, orderedChatConsumer } from '../chat-event-consumer.js';

it('control and terminal consumers are awaited and time out without unhandled rejections', async () => {
  await expect(consumeChatEvent(async () => { throw new Error('rejected terminal'); }, { type: 'complete' }, 50))
    .rejects.toThrow('rejected terminal');
  let active = 0;
  await expect(consumeChatEvent(async (_, signal) => {
    active++; try { await new Promise<void>(r => signal!.addEventListener('abort', () => r(), { once: true })); }
    finally { active--; }
  }, { type: 'thinking_end' }, 20)).rejects.toMatchObject({ code: 'STREAM_CONSUMER_TIMEOUT' });
  expect(active).toBe(0);
});

it('Stop releases a pending control hook', async () => {
  const controller = new AbortController(); let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const pending = consumeChatEvent(async (_, signal) => {
    started(); await new Promise<void>(r => signal!.addEventListener('abort', () => r(), { once: true }));
  }, { type: 'tool_start', toolName: 'test', args: {} }, 1000, controller.signal);
  const assertion = expect(pending).rejects.toThrow('stop');
  await ready; controller.abort(new Error('stop')); await assertion;
});

it('parallel progress callbacks finish in admission order, with bounded active and waiting snapshots', async () => {
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const consumer = orderedChatConsumer(async event => {
    if (event.type === 'tool_progress') { await gate; seen.push(event.toolName); }
  }, { maxPendingEvents: 2, maxPendingBytes: 300, consumerTimeoutMs: 1000 });
  const a = consumer({ type: 'tool_progress', toolName: 'a', progress: {} });
  const b = consumer({ type: 'tool_progress', toolName: 'b', progress: {} });
  await expect(consumer({ type: 'tool_progress', toolName: 'c', progress: {} })).rejects.toMatchObject({ code: 'STREAM_CONSUMER_OVERFLOW' });
  release(); await Promise.all([a, b]); expect(seen).toEqual(['a', 'b']);
});
