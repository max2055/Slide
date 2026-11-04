import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectCancelEvents, isDirectExecution, type CancelQualificationSocket, type CancelQualificationWatch } from './assert-agent-run-cancel.js';

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
  assert.equal(check(), true, label);
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

test('direct execution matches only the resolved script path', () => {
  const script = fileURLToPath(pathToFileURL('/tmp/assert-agent-run-cancel.ts'));
  assert.equal(isDirectExecution(script, pathToFileURL(script).href), true);
  assert.equal(isDirectExecution('/tmp/other.ts', pathToFileURL(script).href), false);
  assert.equal(isDirectExecution(undefined, pathToFileURL(script).href), false);
  assert.equal(isDirectExecution(), false);
});

test('query failure rejects with the same cause after the poll stops and the socket is closed', async () => {
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
    assert.equal(outcome.error, cause);
    assert.equal(calls, 1);
    assert.equal(harness.socket.closeCount, 1);
    assert.deepEqual(harness.socket.types(), ['auth', 'chat.send']);
    assert.equal(harness.queriedWhileClosed(), 0);
    assert.deepEqual(outcome.unhandled, []);
    const timer = probe.entries.find((entry) => entry.ms === 4_321);
    assert.equal(timer?.cleared, true);
    assert.equal(timer?.fired, false);
    await delay(20);
    assert.equal(calls, 1);
  } finally {
    probe.restore();
  }
});

test('timeout keeps its own cause, waits for the in-flight lookup, and ignores the late query error', async () => {
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
    assert.equal(sawSettle, false);
    assert.equal(calls, 1);
    const late = new Error('lookup failed after timeout');
    release(late);
    const outcome = await capture(() => harness.settled);
    harness.closeDb();
    assert.equal(outcome.value && 'ok' in (outcome.value as object) ? (outcome.value as { ok: boolean }).ok : undefined, false);
    const settled = outcome.value as { ok: false; error: Error };
    assert.match(settled.error.message, /agent cancellation qualification timed out/);
    assert.notEqual(settled.error, late);
    assert.equal(harness.socket.closeCount, 1);
    assert.equal(harness.queriedWhileClosed(), 0);
    assert.deepEqual(outcome.unhandled, []);
    assert.deepEqual(harness.socket.types(), ['auth', 'chat.send']);
    const timer = probe.entries.find((entry) => entry.ms === 30);
    assert.equal(timer?.fired, true);
  } finally {
    probe.restore();
  }
});

test('unclaimed run rejects once, clears the timeout, and does not poll again', async () => {
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
    assert.match(String((outcome.error as Error).message), /cancelled run was never claimed/);
    assert.equal(calls, 3);
    assert.equal(harness.socket.closeCount, 1);
    assert.deepEqual(harness.socket.types(), ['auth', 'chat.send']);
    assert.equal(harness.queriedWhileClosed(), 0);
    assert.deepEqual(outcome.unhandled, []);
    const timer = probe.entries.find((entry) => entry.ms === 4_321);
    assert.equal(timer?.cleared, true);
    assert.equal(timer?.fired, false);
    await delay(30);
    assert.equal(calls, 3);
  } finally {
    probe.restore();
  }
});

test('cancel event during lookup resolves only after the poll stops and does not send another cancel', async () => {
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
    assert.equal(sawSettle, false, 'database owner must wait until the poll stops');
    assert.equal(harness.socket.closeCount, 1);
    release('run-1');
    const outcome = await capture(() => harness.settled);
    harness.closeDb();
    const settled = outcome.value as { ok: true; value: Array<Record<string, unknown>> };
    assert.equal(settled.ok, true);
    assert.equal(settled.value.some((event) => event.type === 'cancelled'), true);
    assert.deepEqual(harness.socket.types(), ['auth', 'chat.send']);
    assert.equal(harness.queriedWhileClosed(), 0);
    assert.deepEqual(outcome.unhandled, []);
    const timer = probe.entries.find((entry) => entry.ms === 4_321);
    assert.equal(timer?.cleared, true);
    assert.equal(timer?.fired, false);
  } finally {
    probe.restore();
  }
});

test('claimed run sends one chat.cancel and no further model message', async () => {
  const harness = arm({
    findRunId: async () => 'run-42',
  });
  harness.begin();
  await until(() => harness.socket.types().includes('chat.cancel'), 'chat.cancel emitted');
  const cancel = JSON.parse(harness.socket.sent.at(-1) ?? '{}') as { type?: string; runId?: string; sessionKey?: string };
  assert.deepEqual(cancel, { type: 'chat.cancel', runId: 'run-42', sessionKey: 'session-1' });
  harness.socket.emit('message', JSON.stringify({ type: 'cancelled' }));
  const events = await harness.pending;
  assert.equal(events.some((event) => event.type === 'cancelled'), true);
  assert.deepEqual(harness.socket.types(), ['auth', 'chat.send', 'chat.cancel']);
  assert.equal(harness.socket.closeCount, 1);
});
