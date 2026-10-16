import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OperationsBudgetJournal, OPERATIONS_PRODUCT_BUDGET } from './product-budget.js';

const dirs: string[] = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'slide-p01-budget-')); dirs.push(dir);
  const path = join(dir, 'budget.jsonl');
  const journal = new OperationsBudgetJournal(path);
  journal.initialize(); return { dir, path, journal };
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('one durable product batch budget', () => {
  it('binds the canonical production pointer and never resets or forks initialized history', () => {
    expect(OPERATIONS_PRODUCT_BUDGET).toMatchObject({ batchId: 'AI-Operations-V23', tokenLimit: 10_000_000,
      canonicalDirectory: '/Users/max/Coding/40-Slide/outputs/2026-10-16-v23/budget/' });
    const { journal, path } = fixture();
    expect(() => journal.initialize()).toThrow();
    const send = journal.reserve(1000, 100);
    expect(() => new OperationsBudgetJournal(path).reserve(100, 10)).toThrow('OPERATIONS_BUDGET_USAGE_UNKNOWN');
    journal.settle(send.sequence, { inputTokens: 800, cachedInputTokens: 600, outputTokens: 100 });
    expect(new OperationsBudgetJournal(path).read()).toMatchObject({ usedTokens: 900, reservedTokens: 0, phase: 'normal' });
    expect(() => journal.settle(send.sequence, { inputTokens: 800, cachedInputTokens: 600, outputTokens: 100 })).toThrow();
  });
  it('persists 50/80/100 checkpoints without adding cached input a second time', () => {
    const { journal, path } = fixture();
    for (const [input, output, phase] of [[4_999_900, 100, 'report'], [2_999_900, 100, 'converge'], [1_999_900, 100, 'stop']] as const) {
      const send = journal.reserve(input, output);
      expect(journal.settle(send.sequence, { inputTokens: input, cachedInputTokens: input, outputTokens: output }).phase).toBe(phase);
    }
    expect(journal.read()).toMatchObject({ usedTokens: 10_000_000, stopped: true, phase: 'stop' });
    expect(() => journal.reserve(1, 1)).toThrow('OPERATIONS_BUDGET_STOPPED');
    expect(readFileSync(path, 'utf8')).toContain('BATCH_50_REPORT');
    expect(readFileSync(path, 'utf8')).toContain('BATCH_80_CONVERGE');
    expect(readFileSync(path, 'utf8')).toContain('BATCH_100_STOP');
  });
  it('fails closed for missing/tampered history, stale locks, unknown or over-bound usage', () => {
    const { journal, path } = fixture();
    writeFileSync(`${path}.lock`, 'stale');
    expect(() => journal.reserve(10, 10)).toThrow();
    rmSync(`${path}.lock`);
    const send = journal.reserve(10, 10);
    expect(() => journal.settle(send.sequence, null)).toThrow('OPERATIONS_BUDGET_USAGE_UNKNOWN');
    expect(() => journal.reserve(10, 10)).toThrow('OPERATIONS_BUDGET_STOPPED');
    expect(() => new OperationsBudgetJournal(`${path}.missing`).read()).toThrow();
    const other = fixture(); const second = other.journal.reserve(10, 10);
    expect(() => other.journal.settle(second.sequence, { inputTokens: 11, cachedInputTokens: 0, outputTokens: 10 })).toThrow('OPERATIONS_BUDGET_BOUND_EXCEEDED');
    expect(other.journal.read()).toMatchObject({ usedTokens: 21, stopped: true });
    writeFileSync(other.path, '{}\n');
    expect(() => other.journal.read()).toThrow('OPERATIONS_BUDGET_JOURNAL_INVALID');
  });
  it('serializes different OS processes before sending, with no automatic lock recovery', async () => {
    const { path } = fixture();
    const module = new URL('./product-budget.ts', import.meta.url).href;
    const script = `import { OperationsBudgetJournal } from ${JSON.stringify(module)};
      try { new OperationsBudgetJournal(process.argv[1]).reserve(100, 100); console.log('reserved'); }
      catch { console.log('blocked'); }`;
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path])));
    expect(results.map(r => r.stdout.trim()).sort()).toEqual(['blocked', 'blocked', 'blocked', 'reserved']);
    expect(new OperationsBudgetJournal(path).read()).toMatchObject({ reservedTokens: 200, usedTokens: 0 });
  });
});
