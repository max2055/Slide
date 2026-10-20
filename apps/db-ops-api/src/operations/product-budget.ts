/** Qualification-only V23 adapter. No model transport or production startup.
 * Reuses budgetUsage validation and real-provider-budget's exclusive lock /
 * fsynced pre-send journal pattern, without inheriting T04/T09 grants or limits. */
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { budgetUsage, type BudgetUsage } from '../investigations/budget-ledger.js';

export const OPERATIONS_PRODUCT_BUDGET = Object.freeze({ batchId: 'AI-Operations-V23', tokenLimit: 10_000_000,
  canonicalDirectory: '/Users/max/Coding/40-Slide/outputs/2026-10-16-v23/budget/',
  journalName: 'product-llm.jsonl', modelSource: 'mysql-3306/deepseek-flash', cachedInputIsSubset: true });
type Send = { kind: 'send'; sequence: number; inputUpperBound: number; outputCeiling: number; at: string };
// Max's approval is specific to this stopped send. It is not a general reset
// capability, a usage receipt, or permission to replay the original request.
const AUTHORIZED_UNKNOWN = Object.freeze({
  authorizationCommentId: '01a156ae-9f84-7acd-b1a5-a48bed356da9',
  priorJournalSha256: '6f071978def110c5645ba56529989381311149cb931c68d8be9233570e6f998b',
  priorJournalBytes: 1016, sequence: 4, tokens: 17221,
  sendAt: '2026-10-20T00:13:24.133Z', stopAt: '2026-10-20T00:13:24.145Z',
  noReplay: true, actualUsageUnknown: true,
});
type ConservativeDisposition = typeof AUTHORIZED_UNKNOWN & { kind: 'conservative-disposition'; at: string };
type Entry = { kind: 'init'; schemaVersion: 1; batchId: string; tokenLimit: number; at: string }
  | Send | { kind: 'usage'; sequence: number; usage: BudgetUsage; at: string }
  | { kind: 'stop' | 'checkpoint'; reason: string; at: string } | ConservativeDisposition;
const fail = (code: string): never => { throw new Error(`OPERATIONS_BUDGET_${code}`); };
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const phase = (used: number) => used >= 10_000_000 ? 'stop' : used >= 8_000_000 ? 'converge' : used >= 5_000_000 ? 'report' : 'normal';
function synced(path: string, text: string, flag: 'wx' | 'a') {
  const fd = openSync(path, flag, 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string) {
  const fd = openSync(dirname(path), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Low-level journal port for isolated tests. Actual batch consumers MUST use
 * operationsProductBudget() below; never choose a per-worktree path. */
export class OperationsBudgetJournal {
  private readonly path: string;
  constructor(path: string) {
    this.path = join(realpathSync(dirname(resolve(path))), basename(path));
    // A redirected journal/lock/pointer is not an alternative batch owner.
    if (existsSync(this.path) && realpathSync(this.path) !== this.path) fail('PATH_INVALID');
  }
  /** Explicit once, never called implicitly by read/reserve/settle. */
  initialize(): void {
    this.locked(() => {
      if (existsSync(this.path) || existsSync(`${this.path}.sha256`)) fail('JOURNAL_EXISTS');
      synced(this.path, `${JSON.stringify({ kind: 'init', schemaVersion: 1, batchId: OPERATIONS_PRODUCT_BUDGET.batchId,
        tokenLimit: OPERATIONS_PRODUCT_BUDGET.tokenLimit, at: new Date().toISOString() })}\n`, 'wx');
      synced(`${this.path}.sha256`, digest(this.path), 'wx'); syncDirectory(this.path);
    });
  }
  read() { return this.locked(() => this.snapshot()); }
  /** Explicit one-time audit append for the approved sequence; never invoked
   * by read/reserve/settle or startup. The original unknown receipt stays unknown. */
  conservativelyAccountAuthorizedUnknown(authorizationCommentId: string) {
    return this.locked(() => {
      if (authorizationCommentId !== AUTHORIZED_UNKNOWN.authorizationCommentId) fail('AUTHORIZATION_INVALID');
      const state = this.snapshot();
      if (digest(this.path) !== AUTHORIZED_UNKNOWN.priorJournalSha256
        || !state.stopped || state.pending?.sequence !== AUTHORIZED_UNKNOWN.sequence
        || state.reservedTokens !== AUTHORIZED_UNKNOWN.tokens) fail('DISPOSITION_INVALID');
      this.append([{ kind: 'conservative-disposition', ...AUTHORIZED_UNKNOWN, at: new Date().toISOString() }]);
      return this.snapshot();
    });
  }
  reserve(inputUpperBound: number, outputCeiling: number): Send {
    return this.locked(() => {
      const state = this.snapshot();
      if (state.stopped) fail('STOPPED');
      if (state.pending) fail('USAGE_UNKNOWN');
      if (!integer(inputUpperBound) || !integer(outputCeiling) || !outputCeiling
        || !integer(inputUpperBound + outputCeiling) || state.usedTokens + inputUpperBound + outputCeiling > OPERATIONS_PRODUCT_BUDGET.tokenLimit) fail('TOKEN_LIMIT');
      const send: Send = { kind: 'send', sequence: state.requests + 1, inputUpperBound, outputCeiling, at: new Date().toISOString() };
      this.append([send]); return send;
    });
  }
  settle(sequence: number, usage: BudgetUsage | null) {
    return this.locked(() => {
      const state = this.snapshot();
      if (state.stopped) fail('STOPPED');
      if (!state.pending || state.pending.sequence !== sequence) fail('RECEIPT_INVALID');
      let value: BudgetUsage;
      try { value = budgetUsage(usage!); }
      catch { this.append([{ kind: 'stop', reason: 'USAGE_UNKNOWN', at: new Date().toISOString() }]); return fail('USAGE_UNKNOWN'); }
      const total = state.usedTokens + value.inputTokens + value.outputTokens;
      const entries: Entry[] = [{ kind: 'usage', sequence, usage: value, at: new Date().toISOString() }];
      const exceeded = value.inputTokens > state.pending.inputUpperBound || value.outputTokens > state.pending.outputCeiling
        || total > OPERATIONS_PRODUCT_BUDGET.tokenLimit;
      for (const [threshold, reason] of [[5_000_000, 'BATCH_50_REPORT'], [8_000_000, 'BATCH_80_CONVERGE'], [10_000_000, 'BATCH_100_STOP']] as const) {
        if (total >= threshold && !state.checkpoints.includes(reason)) entries.push({ kind: 'checkpoint', reason, at: new Date().toISOString() });
      }
      if (exceeded || total >= OPERATIONS_PRODUCT_BUDGET.tokenLimit) entries.push({ kind: 'stop', reason: exceeded ? 'BOUND_EXCEEDED' : 'BATCH_100_STOP', at: new Date().toISOString() });
      this.append(entries);
      if (exceeded) fail('BOUND_EXCEEDED');
      return this.snapshot();
    });
  }
  private snapshot() {
    if (readFileSync(`${this.path}.sha256`, 'utf8') !== digest(this.path)) fail('JOURNAL_INVALID');
    const raw = readFileSync(this.path);
    const lines = raw.toString('utf8').trim().split('\n');
    let entries: Entry[];
    try { entries = lines.map(line => JSON.parse(line)); }
    catch { return fail('JOURNAL_INVALID'); }
    const header = entries[0];
    if (header?.kind !== 'init' || header.schemaVersion !== 1 || header.batchId !== OPERATIONS_PRODUCT_BUDGET.batchId
      || header.tokenLimit !== OPERATIONS_PRODUCT_BUDGET.tokenLimit) fail('JOURNAL_INVALID');
    let usedTokens = 0, measuredTokens = 0, conservativelyAccountedTokens = 0;
    let requests = 0, pending: Send | null = null, stopped = false;
    let previous: Entry | null = null, prefixBytes = 0;
    const checkpoints: string[] = [];
    for (const [index, entry] of entries.entries()) {
      const priorBytes = prefixBytes;
      prefixBytes += Buffer.byteLength(lines[index] + '\n');
      if (!entry || !Number.isFinite(Date.parse(entry.at))) fail('JOURNAL_INVALID');
      if (entry === header) continue;
      if (entry.kind === 'conservative-disposition') {
        if (Object.entries(AUTHORIZED_UNKNOWN).some(([key, value]) => entry[key] !== value)
          || priorBytes !== AUTHORIZED_UNKNOWN.priorJournalBytes
          || createHash('sha256').update(raw.subarray(0, priorBytes)).digest('hex') !== AUTHORIZED_UNKNOWN.priorJournalSha256
          || !stopped || previous?.kind !== 'stop' || previous.reason !== 'USAGE_UNKNOWN'
          || previous.at !== AUTHORIZED_UNKNOWN.stopAt || pending?.sequence !== 4
          || pending.at !== AUTHORIZED_UNKNOWN.sendAt || pending.inputUpperBound !== 15173 || pending.outputCeiling !== 2048
          || usedTokens !== 12397 || requests !== 4 || conservativelyAccountedTokens !== 0) fail('JOURNAL_INVALID');
        conservativelyAccountedTokens = entry.tokens;
        usedTokens += entry.tokens; pending = null; stopped = false; previous = entry;
        continue;
      }
      if (stopped) fail('JOURNAL_INVALID');
      if (entry.kind === 'send') {
        if (pending || entry.sequence !== requests + 1 || !integer(entry.inputUpperBound) || !integer(entry.outputCeiling)
          || !entry.outputCeiling || usedTokens + entry.inputUpperBound + entry.outputCeiling > OPERATIONS_PRODUCT_BUDGET.tokenLimit) fail('JOURNAL_INVALID');
        pending = entry; requests++;
      } else if (entry.kind === 'usage') {
        if (!pending || entry.sequence !== pending.sequence) fail('JOURNAL_INVALID');
        let usage: BudgetUsage;
        try { usage = budgetUsage(entry.usage); } catch { return fail('JOURNAL_INVALID'); }
        measuredTokens += usage.inputTokens + usage.outputTokens;
        usedTokens += usage.inputTokens + usage.outputTokens; pending = null;
        if (!integer(usedTokens)) fail('JOURNAL_INVALID');
      } else if (entry.kind === 'stop') stopped = true;
      else if (entry.kind === 'checkpoint') checkpoints.push(entry.reason);
      else fail('JOURNAL_INVALID');
      previous = entry;
    }
    const reservedTokens = pending ? pending.inputUpperBound + pending.outputCeiling : 0;
    return { usedTokens, measuredTokens, conservativelyAccountedTokens, reservedTokens, remainingTokens: Math.max(0, OPERATIONS_PRODUCT_BUDGET.tokenLimit - usedTokens - reservedTokens),
      requests, pending, stopped, checkpoints, phase: phase(usedTokens) };
  }
  private append(entries: Entry[]): void {
    synced(this.path, entries.map(entry => `${JSON.stringify(entry)}\n`).join(''), 'a');
    // Crash between durable append and pointer replacement fails closed. No
    // stale lock deletion, counter rollback, or unknown-send replay is automatic.
    const temporary = `${this.path}.sha256.next`;
    synced(temporary, digest(this.path), 'wx');
    renameSync(temporary, `${this.path}.sha256`); syncDirectory(this.path);
  }
  private locked<T>(action: () => T): T {
    const lock = `${this.path}.lock`;
    // Chief/receiver checks and provider reservation share this same protocol.
    // Wait only for acquisition: never repeat an action or remove another lock.
    const deadline = performance.now() + 5000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let fd: number;
    for (;;) {
      try { fd = openSync(lock, 'wx', 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) fail('LOCK_TIMEOUT');
        Atomics.wait(pause, 0, 0, Math.min(remaining, 5 + Math.random() * 10));
      }
    }
    try { return action(); } finally { closeSync(fd); unlinkSync(lock); }
  }
}

/** This is the only production-batch entry point. No env/worktree override.
 * initialize=true is explicit P01 provisioning; existing bytes are never reset. */
export function operationsProductBudget(initialize = false): OperationsBudgetJournal {
  if (initialize) mkdirSync(OPERATIONS_PRODUCT_BUDGET.canonicalDirectory, { recursive: true, mode: 0o700 });
  const journal = new OperationsBudgetJournal(join(OPERATIONS_PRODUCT_BUDGET.canonicalDirectory, OPERATIONS_PRODUCT_BUDGET.journalName));
  if (initialize) journal.initialize();
  return journal;
}
