import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectCancelEvents, isDirectExecution, type CancelQualificationSocket, type CancelQualificationWatch } from '../../../tests/qualification/assert-agent-run-cancel.js';

class FakeSocket implements CancelQualificationSocket {
  sent: string[] = [];
  closeCount = 0;
  private listeners: Record<string, Array<(payload?: unknown) => void>> = {};

  send(data: string) { this.sent.push(data); }
  close() { this.closeCount += 1; }
  on(event: 'open' | 'message' | 'error', listener: (payload?: unknown) => void) {
    (this.listeners[event] ??= []).push(listener);
  }
  emit(event: 'open' | 'message' | 'error', payload?: unknown) {
    for (const listener of this.listeners[event] ?? []) listener(payload);
  }
  types(): string[] {
    return this.sent.map((frame) => JSON.parse(frame).type as string);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installTimerProbe() {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const entries: Array<{ ms: number; fired: boolean; cleared: boolean }> = [];
  const byHandle = new Map<unknown, { ms: number; fired: boolean; cleared: boolean }>();
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const entry = { ms: Number(ms ?? 0), fired: false, cleared: false };
    entries.push(entry);
    const handle = originalSet(function (this: unknown, ...inner: unknown[]) {
      entry.fired = true;
      if (typeof fn === 'function') return Reflect.apply(fn, this, inner);
    } as TimerHandler, ms, ...(args as []));
    byHandle.set(handle, entry);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: unknown) => {
    const entry = byHandle.get(handle);
    if (entry && !entry.fired) entry.cleared = true;
    return originalClear(handle as never);
  }) as typeof clearTimeout;
  return {
    entries,
    restore() {
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
    },
  };
}

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 1_000;
  while (!check() && Date.now() < deadline) await delay(5);
  expect(check(), label).toBe(true);
}

async function capture(run: () => Promise<unknown>) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    try {
      const value = await run();
      await delay(30);
      return { value, unhandled };
    } catch (error) {
      await delay(30);
      return { error, unhandled };
    }
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

function arm(options: Partial<CancelQualificationWatch> & Pick<CancelQualificationWatch, 'findRunId'>) {
  const socket = new FakeSocket();
  let dbOpen = true;
  let queriedWhileClosed = 0;
  const wrappedFind = options.findRunId;
  const pending = collectCancelEvents({
    connect: () => socket,
    messageId: 'message-1',
    idempotencyKey: 'idem-1',
    timeoutMs: 5_000,
    maxPolls: 40,
    pollDelayMs: 5,
    ...options,
    findRunId: async () => {
      const runId = await wrappedFind();
      if (!dbOpen) queriedWhileClosed += 1;
      return runId;
    },
  });
  const settled = pending.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
  return {
    socket,
    pending,
    settled,
    closeDb() { dbOpen = false; },
    queriedWhileClosed: () => queriedWhileClosed,
    begin() {
      socket.emit('open');
      socket.emit('message', JSON.stringify({ type: 'auth_ok' }));
      socket.emit('message', JSON.stringify({ type: 'session.created', sessionKey: 'session-1' }));
    },
  };
}

describe('cancel qualification poll lifecycle', () => {
  it('direct execution matches only the resolved script path', () => {
    const script = fileURLToPath(pathToFileURL('/tmp/assert-agent-run-cancel.ts'));
    expect(isDirectExecution(script, pathToFileURL(script).href)).toBe(true);
    expect(isDirectExecution('/tmp/other.ts', pathToFileURL(script).href)).toBe(false);
    expect(isDirectExecution(undefined, pathToFileURL(script).href)).toBe(false);
    expect(isDirectExecution()).toBe(false);
  });

  it('query failure rejects with the same cause after the poll stops and the socket is closed', async () => {
    const probe = installTimerProbe();
    try {
      const cause = new Error('select failed');
      let calls = 0;
      const harness = arm({
        timeoutMs: 4_321,
        findRunId: async () => {
          calls += 1;
          await delay(15);
          throw cause;
        },
      });
      harness.begin();
      const outcome = await capture(() => harness.pending);
      harness.closeDb();
      expect(outcome.error).toBe(cause);
      expect(calls).toBe(1);
      expect(harness.socket.closeCount).toBe(1);
      expect(harness.socket.types()).toEqual(['auth', 'chat.send']);
      expect(harness.queriedWhileClosed()).toBe(0);
      expect(outcome.unhandled).toEqual([]);
      const timer = probe.entries.find((entry) => entry.ms === 4_321);
      expect(timer?.cleared).toBe(true);
      expect(timer?.fired).toBe(false);
      await delay(20);
      expect(calls).toBe(1);
    } finally {
      probe.restore();
    }
  });

  it('timeout keeps its own cause, waits for the in-flight lookup, and ignores the late query error', async () => {
    const probe = installTimerProbe();
    try {
      let release!: (error?: unknown) => void;
      let started!: () => void;
      const startedGate = new Promise<void>((resolve) => { started = resolve; });
      const lookup = new Promise<string | undefined>((_resolve, reject) => {
        release = (error) => error === undefined ? _resolve(undefined) : reject(error);
      });
      let calls = 0;
      let sawSettle = false;
      const harness = arm({
        timeoutMs: 30,
        findRunId: () => {
          calls += 1;
          started();
          return lookup;
        },
      });
      void harness.settled.then(() => { sawSettle = true; });
      harness.begin();
      await startedGate;
      await until(() => harness.socket.closeCount === 1, 'socket closed on timeout');
      expect(sawSettle).toBe(false);
      expect(calls).toBe(1);
      const late = new Error('lookup failed after timeout');
      release(late);
      const outcome = await capture(() => harness.settled);
      harness.closeDb();
      expect(outcome.value && 'ok' in (outcome.value as object) ? (outcome.value as { ok: boolean }).ok : undefined).toBe(false);
      const settled = outcome.value as { ok: false; error: Error };
      expect(settled.error.message).toMatch(/agent cancellation qualification timed out/);
      expect(settled.error).not.toBe(late);
      expect(harness.socket.closeCount).toBe(1);
      expect(harness.queriedWhileClosed()).toBe(0);
      expect(outcome.unhandled).toEqual([]);
      expect(harness.socket.types()).toEqual(['auth', 'chat.send']);
      const timer = probe.entries.find((entry) => entry.ms === 30);
      expect(timer?.fired).toBe(true);
    } finally {
      probe.restore();
    }
  });

  it('unclaimed run rejects once, clears the timeout, and does not poll again', async () => {
    const probe = installTimerProbe();
    try {
      let calls = 0;
      const harness = arm({
        timeoutMs: 4_321,
        maxPolls: 3,
        pollDelayMs: 5,
        findRunId: async () => {
          calls += 1;
          return undefined;
        },
      });
      harness.begin();
      const outcome = await capture(() => harness.pending);
      harness.closeDb();
      expect(String((outcome.error as Error).message)).toMatch(/cancelled run was never claimed/);
      expect(calls).toBe(3);
      expect(harness.socket.closeCount).toBe(1);
      expect(harness.socket.types()).toEqual(['auth', 'chat.send']);
      expect(harness.queriedWhileClosed()).toBe(0);
      expect(outcome.unhandled).toEqual([]);
      const timer = probe.entries.find((entry) => entry.ms === 4_321);
      expect(timer?.cleared).toBe(true);
      expect(timer?.fired).toBe(false);
      await delay(30);
      expect(calls).toBe(3);
    } finally {
      probe.restore();
    }
  });

  it('cancel event during lookup resolves only after the poll stops and does not send another cancel', async () => {
    const probe = installTimerProbe();
    try {
      let release!: (runId: string) => void;
      let started!: () => void;
      const startedGate = new Promise<void>((resolve) => { started = resolve; });
      const harness = arm({
        timeoutMs: 4_321,
        findRunId: () => {
          started();
          return new Promise<string>((resolve) => { release = resolve; });
        },
      });
      let sawSettle = false;
      void harness.settled.then(() => { sawSettle = true; });
      harness.begin();
      await startedGate;
      await until(() => harness.socket.types().includes('chat.send'), 'chat.send emitted');
      harness.socket.emit('message', JSON.stringify({ type: 'cancelled' }));
      await delay(20);
      expect(sawSettle).toBe(false);
      expect(harness.socket.closeCount).toBe(1);
      release('run-1');
      const outcome = await capture(() => harness.settled);
      harness.closeDb();
      const settled = outcome.value as { ok: true; value: Array<Record<string, unknown>> };
      expect(settled.ok).toBe(true);
      expect(settled.value.some((event) => event.type === 'cancelled')).toBe(true);
      expect(harness.socket.types()).toEqual(['auth', 'chat.send']);
      expect(harness.queriedWhileClosed()).toBe(0);
      expect(outcome.unhandled).toEqual([]);
      const timer = probe.entries.find((entry) => entry.ms === 4_321);
      expect(timer?.cleared).toBe(true);
      expect(timer?.fired).toBe(false);
    } finally {
      probe.restore();
    }
  });

  it('claimed run sends one chat.cancel and no further model message', async () => {
    const harness = arm({
      findRunId: async () => 'run-42',
    });
    harness.begin();
    await until(() => harness.socket.types().includes('chat.cancel'), 'chat.cancel emitted');
    const cancel = JSON.parse(harness.socket.sent.at(-1) ?? '{}') as { type?: string; runId?: string; sessionKey?: string };
    expect(cancel).toEqual({ type: 'chat.cancel', runId: 'run-42', sessionKey: 'session-1' });
    harness.socket.emit('message', JSON.stringify({ type: 'cancelled' }));
    const events = await harness.pending;
    expect(events.some((event) => event.type === 'cancelled')).toBe(true);
    expect(harness.socket.types()).toEqual(['auth', 'chat.send', 'chat.cancel']);
    expect(harness.socket.closeCount).toBe(1);
  });
});
