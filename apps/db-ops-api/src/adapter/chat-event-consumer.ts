import { RuntimeError, type StreamingLimits } from '@slide/agent-core';
import type { ChatEvent, ChatEventConsumer } from './types.js';

/** Covers non-model hooks and terminal callbacks as well as model writes.
 * Arbitrary user promises cannot be forcibly killed; consumers must honor signal. */
export async function consumeChatEvent(consumer: ChatEventConsumer, event: ChatEvent,
  timeoutMs: number, parent?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => controller.abort(new RuntimeError('STREAM_CONSUMER_TIMEOUT', 'Chat consumer timed out')), timeoutMs);
  let rejectAbort!: () => void;
  const boundary = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  void boundary.catch(() => {});
  parent?.addEventListener('abort', cancel, { once: true });
  if (parent?.aborted) cancel();
  try {
    controller.signal.throwIfAborted();
    const request = consumer(event, controller.signal);
    // Synchronous callbacks may request Stop after accepting a retraction.
    // Let the runtime observe that Stop at its next boundary.
    if (request) await Promise.race([request, boundary]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

/** Serialize parallel tool-progress callbacks too. Each reservation includes
 * the active callback and its immutable cumulative-text snapshot. Overload
 * fails explicitly instead of creating an unbounded promise chain. */
export function orderedChatConsumer(consumer: ChatEventConsumer, limits: StreamingLimits = {}): ChatEventConsumer {
  let tail = Promise.resolve(); let pendingEvents = 0; let pendingBytes = 0;
  const maxEvents = limits.maxPendingEvents ?? 64;
  const maxBytes = limits.maxPendingBytes ?? 1024 * 1024;
  const timeout = limits.consumerTimeoutMs ?? 30_000;
  return (event, signal) => {
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (bytes > maxBytes || pendingBytes + bytes > maxBytes || pendingEvents >= maxEvents) {
      return Promise.reject(new RuntimeError('STREAM_CONSUMER_OVERFLOW', 'Chat consumer capacity exceeded'));
    }
    pendingEvents++; pendingBytes += bytes;
    const delivery = tail.then(() => consumeChatEvent(consumer, event, timeout, signal))
      .finally(() => { pendingEvents--; pendingBytes -= bytes; });
    // Rejections remain observable to the caller. Subsequent terminal delivery
    // can still report the failure, and all admitted events preserve call order.
    tail = delivery.catch(() => {});
    return delivery;
  };
}
