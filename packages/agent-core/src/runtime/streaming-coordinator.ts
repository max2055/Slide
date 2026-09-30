import { RuntimeError } from './recovery-policy.js';

export interface StreamingLimits {
  maxPendingEvents?: number;
  maxPendingBytes?: number;
  consumerTimeoutMs?: number;
}
export interface StreamingMetrics {
  pendingEvents: number;
  pendingBytes: number;
  peakEvents: number;
  peakBytes: number;
}

/** One serial producer must await enqueue. Admission (not delivery) is awaited.
 * Limits include the active write. Only adjacent, not-yet-written events may merge.
 * Writers must honor the supplied signal to cancel their own external work. */
export class StreamingCoordinator<T> {
  readonly signal: AbortSignal;
  readonly metrics: StreamingMetrics = { pendingEvents: 0, pendingBytes: 0, peakEvents: 0, peakBytes: 0 };
  private readonly controller = new AbortController();
  private readonly events: Array<{ value: T; bytes: number }> = [];
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly timeout: number;
  private writing = false;
  private ending = false;
  private error?: unknown;
  private stopped = false;
  private wake?: () => void;
  private resolveDone!: () => void;
  private rejectDone!: (error: unknown) => void;
  private readonly done: Promise<void>;

  constructor(private readonly write: (event: T, signal: AbortSignal) => Promise<void> | void,
    private readonly options: StreamingLimits & {
      size: (event: T) => number;
      merge?: (previous: T, next: T) => T | undefined;
      onError?: (error: unknown) => void;
    }) {
    this.signal = this.controller.signal;
    this.maxEvents = options.maxPendingEvents ?? 64;
    this.maxBytes = options.maxPendingBytes ?? 256 * 1024;
    this.timeout = options.consumerTimeoutMs ?? 30_000;
    for (const n of [this.maxEvents, this.maxBytes, this.timeout]) {
      if (!Number.isSafeInteger(n) || n <= 0) throw new RuntimeError('STREAM_INVALID_LIMIT', 'Streaming limits must be positive integers');
    }
    this.done = new Promise((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
    // A writer may fail before the producer reaches drain().
    void this.done.catch(() => {});
  }

  async enqueue(value: T): Promise<void> {
    const bytes = this.options.size(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes) {
      const error = new RuntimeError('STREAM_EVENT_TOO_LARGE', 'Stream event exceeds the pending byte limit');
      this.fail(error); throw error;
    }
    for (;;) {
      if (this.stopped) throw this.error ?? new RuntimeError('STREAM_CLOSED', 'Stream is closed');
      if (this.ending) throw new RuntimeError('STREAM_CLOSED', 'Stream is draining');
      const tail = this.events.at(-1);
      const merged = tail && this.options.merge?.(tail.value, value);
      const mergedBytes = merged === undefined ? 0 : this.options.size(merged);
      const additionalBytes = merged === undefined ? bytes : mergedBytes - tail!.bytes;
      if (this.metrics.pendingBytes + additionalBytes <= this.maxBytes &&
        (merged !== undefined || this.metrics.pendingEvents < this.maxEvents)) {
        if (merged !== undefined) { tail!.value = merged; tail!.bytes = mergedBytes; }
        else { this.events.push({ value, bytes }); this.metrics.pendingEvents++; }
        this.metrics.pendingBytes += additionalBytes;
        this.metrics.peakBytes = Math.max(this.metrics.peakBytes, this.metrics.pendingBytes);
        this.metrics.peakEvents = Math.max(this.metrics.peakEvents, this.metrics.pendingEvents);
        if (!this.writing) { this.writing = true; void this.pump(); }
        return;
      }
      if (this.wake) {
        const error = new RuntimeError('STREAM_CONCURRENT_PRODUCER', 'Producer must await stream admission');
        this.fail(error); throw error;
      }
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }

  async drain(): Promise<void> {
    this.ending = true;
    if (!this.writing && !this.stopped) this.complete();
    await this.done;
  }

  fail(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true; this.error = error;
    this.events.length = 0;
    this.metrics.pendingBytes = 0; this.metrics.pendingEvents = 0;
    this.controller.abort(error);
    this.notify(); this.rejectDone(error);
    this.options.onError?.(error);
  }

  private notify(): void { const wake = this.wake; this.wake = undefined; wake?.(); }
  private complete(): void { this.stopped = true; this.resolveDone(); }

  private async pump(): Promise<void> {
    try {
      while (this.events.length && !this.stopped) {
        const entry = this.events.shift()!;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel!: () => void;
        const boundary = new Promise<never>((_, reject) => {
          cancel = () => reject(this.signal.reason);
          this.signal.addEventListener('abort', cancel, { once: true });
          timer = setTimeout(() => this.fail(new RuntimeError('STREAM_CONSUMER_TIMEOUT', 'Stream consumer timed out')), this.timeout);
        });
        try {
          await Promise.race([Promise.resolve().then(() => {
            this.signal.throwIfAborted();
            return this.write(entry.value, this.signal);
          }), boundary]);
        } finally { clearTimeout(timer); this.signal.removeEventListener('abort', cancel); }
        if (this.stopped) break;
        this.metrics.pendingEvents--; this.metrics.pendingBytes -= entry.bytes;
        this.notify();
      }
    } catch (cause) {
      this.fail(cause instanceof RuntimeError ? cause : new RuntimeError('STREAM_CONSUMER_FAILED',
        cause instanceof Error ? cause.message : String(cause)));
    } finally {
      this.writing = false;
      if (this.ending && !this.stopped) this.complete();
    }
  }
}
