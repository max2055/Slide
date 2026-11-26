import assert from 'node:assert/strict';
import { on, once } from 'node:events';
import fs from 'node:fs';
import { OperationsBudgetJournal } from '../product-budget.js';

const [file, mode] = process.argv.slice(2);
const journal = new OperationsBudgetJournal(file);
if (mode === 'disposition') {
  try {
    journal.conservativelyAccountAuthorizedUnknown('01a156ae-9f84-7acd-b1a5-a48bed356da9');
    process.send!({ ok: true });
  } catch (error) {
    process.send!({ ok: false, error: String(error) });
  }
} else if (mode === 'hold') {
  const lockPath = file + '.lock';
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try {
    const release = once(process, 'message');
    process.send!({ ready: true });
    const [command] = await release;
    assert.equal(command, 'release');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  }
} else {
  assert(mode === 'read' || mode === 'write', `Invalid budget worker mode: ${mode}`);
  const commands = on(process, 'message', { close: ['disconnect'] });
  process.send!({ ready: true });
  for await (const [command] of commands) {
    if (command === 'stop') break;
    assert(Number.isSafeInteger(command) && command > 0, 'Expected a positive batch size');
    let operations = 0;
    for (; operations < command; operations++) {
      if (mode === 'write') {
        const send = journal.reserve(100, 100);
        journal.settle(send.sequence, { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0 });
      } else {
        journal.read();
      }
    }
    process.send!({ operations });
  }
}
