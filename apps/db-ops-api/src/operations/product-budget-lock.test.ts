import { it, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { on } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OperationsBudgetJournal } from './product-budget.js';

type WorkerMode = 'hold' | 'read' | 'write';
type WorkerCommand = 'release' | 'stop' | number;

const operationsPerWorker = 200;
const operationsPerBatch = 10;
const workerTimeoutMs = 7_000;

async function waitForWorker<T>(result: Promise<T>, description: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), workerTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function startWorker(journalPath: string, mode: WorkerMode) {
  const child = fork(new URL('./test-fixtures/product-budget-worker.ts', import.meta.url), [journalPath, mode], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const name = `${mode} worker (PID ${child.pid})`;
  let stderr = '';
  let processError: Error | undefined;
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', (error) => { processError = error; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const messages = on(child, 'message', { close: ['close'] });

  async function waitForExit() {
    const { code, signal } = await waitForWorker(closed, `${name} exit`);
    assert.equal(code, 0, `${name} exited with code ${code}, signal ${signal}: ${processError ?? stderr}`);
  }

  return {
    child,
    closed,
    send(command: WorkerCommand) {
      return waitForWorker(new Promise<void>((resolve, reject) => {
        child.send(command, (error) => error ? reject(error) : resolve());
      }), `${name} command ${command}`);
    },
    async expectMessage(expected: { ready: true } | { operations: number }) {
      const reply = await waitForWorker(messages.next(), `${name} reply ${JSON.stringify(expected)}`);
      if (reply.done) {
        await waitForExit();
        assert.fail(`${name} exited before sending ${JSON.stringify(expected)}`);
      }
      assert.deepEqual(reply.value[0], expected, `${name} reply`);
    },
    waitForExit,
  };
}

// The deliberate stale-lock wait and durable writes share this test budget.
it('live process contention waits and stale locks remain fail closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max207-lock-'));
  const journalPath = path.join(dir, 'product-llm.jsonl');
  const lockPath = journalPath + '.lock';
  const children: ReturnType<typeof startWorker>[] = [];
  onTestFinished(async () => {
    for (const { child } of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await waitForWorker(Promise.all(children.map(({ closed }) => closed)), 'budget fixture cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function launch(mode: WorkerMode) {
    const worker = startWorker(journalPath, mode);
    children.push(worker);
    return worker;
  }

  const journal = new OperationsBudgetJournal(journalPath);
  journal.initialize();
  const initial = fs.readFileSync(journalPath);

  const holder = launch('hold');
  await holder.expectMessage({ ready: true });
  const release = holder.send('release');
  const readWhileHeld = Promise.resolve().then(() => {
    const started = performance.now();
    const state = journal.read();
    assert(performance.now() - started >= 100, 'read must wait for the live holder');
    return state;
  });
  const [state] = await Promise.all([readWhileHeld, release]);
  await holder.waitForExit();
  assert.equal(state.requests, 0);
  assert.deepEqual(fs.readFileSync(journalPath), initial);

  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try {
    const inode = fs.statSync(lockPath).ino;
    const started = performance.now();
    assert.throws(() => journal.read(), /LOCK_TIMEOUT/);
    assert(performance.now() - started < 6_500, 'stale lock wait must be bounded');
    assert.equal(fs.statSync(lockPath).ino, inode);
    assert.deepEqual(fs.readFileSync(journalPath), initial);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  }

  const workers = [launch('write'), launch('read'), launch('read'), launch('read')];
  await Promise.all(workers.map((worker) => worker.expectMessage({ ready: true })));
  // Limit lock reacquisition between barriers while keeping all readers and
  // the writer active together in each batch.
  for (let completed = 0; completed < operationsPerWorker; completed += operationsPerBatch) {
    const batchSize = Math.min(operationsPerBatch, operationsPerWorker - completed);
    await Promise.all(workers.map(async (worker) => {
      await worker.send(batchSize);
      await worker.expectMessage({ operations: batchSize });
    }));
  }
  await Promise.all(workers.map(async (worker) => {
    await worker.send('stop');
    await worker.waitForExit();
  }));
  const result = journal.read();
  assert.equal(result.usedTokens, 600);
  assert.equal(result.requests, operationsPerWorker);

  const pending = journal.reserve(100, 100);
  assert.throws(() => journal.reserve(100, 100), /USAGE_UNKNOWN/);
  assert.equal(journal.read().pending?.sequence, pending.sequence);
  journal.settle(pending.sequence, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 });

  const raw = fs.readFileSync(journalPath);
  fs.appendFileSync(journalPath, 'x');
  assert.throws(() => journal.read(), /JOURNAL_INVALID/);
  fs.writeFileSync(journalPath, raw);

  fs.unlinkSync(journalPath);
  assert.throws(() => journal.read(), /ENOENT/);
  assert(!fs.existsSync(lockPath));
}, 30_000);
