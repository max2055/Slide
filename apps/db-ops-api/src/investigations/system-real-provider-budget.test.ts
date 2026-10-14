import { fork } from 'node:child_process';
import { realpathSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { initializeSystemJournal, readSystemJournal, receiveSystemUsage, reserveSystemSend, stopSystemSends, SYSTEM_REAL_AUTHORIZATION } from './system-real-provider-budget.js';
const dirs: string[] = [];
const journal = () => { const dir = mkdtempSync(join(tmpdir(), 't09-budget-')); dirs.push(dir);
  const path = join(dir, 'journal.jsonl'), previousJournal = join(dir, 'previous.jsonl');
  writeFileSync(previousJournal, readFileSync(new URL('./fixtures/system-real-stopped-journal.jsonl', import.meta.url)));
  initializeSystemJournal(path, { authorization: SYSTEM_REAL_AUTHORIZATION, previousJournal }); return path; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });
it('three actual HTTP attempts are durable; cached input is never counted twice or old history replenished', () => {
  const path = journal();
  for (let i = 1; i <= 3; i++) {
    expect(reserveSystemSend(path, 1000, 2048).sequence).toBe(i);
    receiveSystemUsage(path, i, { inputTokens: 500, cachedInputTokens: 400, outputTokens: 100 });
  }
  expect(readSystemJournal(path)).toMatchObject({ requests: 3, cumulativeRequests: 10, totalTokens: 1800,
    usage: { inputTokens: 1500, cachedInputTokens: 1200, outputTokens: 300 } });
  expect(() => reserveSystemSend(path, 1000, 2048)).toThrow('T09_REQUEST_LIMIT');
  expect(() => initializeSystemJournal(path, { authorization: SYSTEM_REAL_AUTHORIZATION, previousJournal: join(path, '..', 'previous.jsonl') })).toThrow();
});
it('reserves the complete next input bound plus output before I/O and blocks unknown/incomplete usage', () => {
  const path = journal();
  expect(() => reserveSystemSend(path, 30_000, 2048)).toThrow('T09_TOKEN_LIMIT');
  reserveSystemSend(path, 25_000, 2048);
  expect(() => reserveSystemSend(path, 1, 1)).toThrow('T09_PROVIDER_DIAGNOSIS_REQUIRED');
  receiveSystemUsage(path, 1, { inputTokens: 25_000, cachedInputTokens: 0, outputTokens: 2000 });
  expect(() => reserveSystemSend(path, 1, 2048)).toThrow('T09_TOKEN_LIMIT');
  reserveSystemSend(path, 1, 1);
  expect(() => receiveSystemUsage(path, 2, { inputTokens: NaN, outputTokens: 1, cachedInputTokens: 0 })).toThrow('T09_USAGE_UNAVAILABLE');
  expect(readSystemJournal(path).stopped).toBe(true);
});
it('HTTP failure and underestimated usage stop later processes while preserving actual consumption', () => {
  const path = journal(); reserveSystemSend(path, 10, 10);
  expect(() => receiveSystemUsage(path, 1, { inputTokens: 11, outputTokens: 10, cachedInputTokens: 0 })).toThrow('T09_USAGE_BOUND_EXCEEDED');
  expect(readSystemJournal(path)).toMatchObject({ stopped: true, totalTokens: 21 });
  expect(() => reserveSystemSend(path, 1, 1)).toThrow('T09_PROVIDER_DIAGNOSIS_REQUIRED');
  const http = journal(); reserveSystemSend(http, 100, 100); stopSystemSends(http, 'PROVIDER_HTTP_402');
  expect(readSystemJournal(http)).toMatchObject({ requests: 1, stopped: true });
  expect(() => reserveSystemSend(http, 1, 1)).toThrow('T09_PROVIDER_DIAGNOSIS_REQUIRED');
});
it('racing processes admit exactly one unreceipted send, including a process exit before transport', async () => {
  const path = journal();
  const codes = await Promise.all(Array.from({ length: 6 }, () => new Promise<number | null>((resolve, reject) => {
    const child = fork(new URL('./system-real-provider-budget.ts', import.meta.url), [], {
      execArgv: ['--import', import.meta.resolve('tsx'), '--eval',
        `import {reserveSystemSend} from ${JSON.stringify(new URL('./system-real-provider-budget.ts', import.meta.url).href)}; try {reserveSystemSend(process.env.T09_TEST_JOURNAL,100,100);process.exit(0);}catch{process.exit(1);}`],
      env: { ...process.env, T09_TEST_JOURNAL: path }, silent: true });
    child.once('error', reject); child.once('exit', resolve);
  })));
  expect(codes.filter(code => code === 0)).toHaveLength(1);
  expect(readSystemJournal(path).requests).toBe(1);
}, 30_000);
it('missing/corrupt journals and abandoned locks fail closed without resetting counters', () => {
  const path = journal();
  expect(() => readSystemJournal(path + '.missing')).toThrow();
  writeFileSync(path + '.lock', 'abandoned');
  expect(() => reserveSystemSend(path, 10, 10)).toThrow();
  const before = readFileSync(path, 'utf8');
  expect(readSystemJournal(path).requests).toBe(0);
  writeFileSync(path, before.replace('"requests":3', '"requests":4'));
  expect(() => readSystemJournal(path)).toThrow('T09_JOURNAL_INVALID');
});

it('links immutable stopped history and rejects cumulative overflow, invalid authorization and duplicate grants', () => {
  const path = journal(), previousJournal = join(path, '..', 'previous.jsonl');
  const before = readFileSync(previousJournal, 'utf8');
  expect(readSystemJournal(path)).toMatchObject({ baselineTokens: 3081, cumulativeRequests: 7, cumulativeTokens: 3081 });
  expect(() => reserveSystemSend(path, 26872, 2048)).toThrow('T09_TOKEN_LIMIT');
  expect(() => reserveSystemSend(path, 1, 2049)).toThrow();
  expect(() => initializeSystemJournal(path + '.new', { authorization: 'expired', previousJournal })).toThrow();
  expect(() => initializeSystemJournal(path + '.new', { authorization: SYSTEM_REAL_AUTHORIZATION, previousJournal })).toThrow();
  expect(readFileSync(previousJournal, 'utf8')).toBe(before);
  expect(() => reserveSystemSend(previousJournal, 1, 1)).toThrow();
  writeFileSync(previousJournal, before.replace('3081', '3082') + ' ');
  expect(() => reserveSystemSend(path, 1, 1)).toThrow();
});

it('copied, truncated and unlinked scenes fail closed, and receipt baseline stays counted', () => {
  const path = journal(), raw = readFileSync(path, 'utf8');
  writeFileSync(path + '.copy', raw);
  expect(() => reserveSystemSend(path + '.copy', 1, 1)).toThrow('T09_AUTHORIZATION_ALREADY_CONSUMED');
  expect(() => initializeSystemJournal(path + '.missing', undefined as never)).toThrow('T09_EXPLICIT_AUTHORIZATION_REQUIRED');
  reserveSystemSend(path, 26000, 2000);
  receiveSystemUsage(path, 1, { inputTokens: 26000, outputTokens: 2000, cachedInputTokens: 1000 });
  expect(readSystemJournal(path)).toMatchObject({ totalTokens: 28000, cumulativeTokens: 31081, cumulativeRequests: 8 });
  expect(() => reserveSystemSend(path, 920, 1)).toThrow('T09_TOKEN_LIMIT');
  writeFileSync(path, raw.slice(0, -10));
  expect(() => reserveSystemSend(path, 1, 1)).toThrow();
});

const standingAuthorization = '01a137d7-4d36-757f-a0ad-2d92cb91299b';
const standingJournal = () => {
  const previousJournal = journal();
  for (let i = 1; i <= 2; i++) {
    reserveSystemSend(previousJournal, 4000, 2048);
    receiveSystemUsage(previousJournal, i, { inputTokens: 1200, outputTokens: 285, cachedInputTokens: 576 });
  }
  stopSystemSends(previousJournal, 'CONTEXT_UNRECOVERABLE');
  const path = previousJournal + '.standing';
  initializeSystemJournal(path, { authorization: standingAuthorization, batchLedger: join(previousJournal, '..', 'batch.json'), previousJournal });
  return { path, previousJournal };
};
it('standing authorization removes approval ceilings while accumulating both stopped scenes', () => {
  const { path, previousJournal } = standingJournal(), before = readFileSync(previousJournal, 'utf8');
  for (let i = 1; i <= 4; i++) {
    reserveSystemSend(path, 20_000, 4096);
    receiveSystemUsage(path, i, { inputTokens: 15_000, outputTokens: 3000, cachedInputTokens: 1000 });
  }
  expect(readSystemJournal(path)).toMatchObject({ requests: 4, totalTokens: 72_000,
    baselineTokens: 6051, cumulativeTokens: 78_051, cumulativeRequests: 13 });
  expect(readFileSync(previousJournal, 'utf8')).toBe(before);
  expect(() => reserveSystemSend(previousJournal, 1, 1)).toThrow('T09_PROVIDER_DIAGNOSIS_REQUIRED');
});
it('standing scenes cannot branch, copy or reopen a stopped scene; a new linked scene retains usage', () => {
  const { path, previousJournal } = standingJournal();
  expect(() => initializeSystemJournal(path + '.branch', { authorization: standingAuthorization, batchLedger: join(previousJournal, '..', 'batch.json'), previousJournal })).toThrow();
  const oldest = join(previousJournal, '..', 'previous.jsonl');
  expect(() => initializeSystemJournal(path + '.bypass', { authorization: standingAuthorization, batchLedger: join(previousJournal, '..', 'batch.json'), previousJournal: oldest })).toThrow();
  writeFileSync(path + '.copy', readFileSync(path));
  expect(() => reserveSystemSend(path + '.copy', 1, 1)).toThrow('T09_AUTHORIZATION_ALREADY_CONSUMED');
  reserveSystemSend(path, 1000, 4096);
  receiveSystemUsage(path, 1, { inputTokens: 100, outputTokens: 200, cachedInputTokens: 50 });
  expect(() => initializeSystemJournal(path + '.next', { authorization: standingAuthorization, batchLedger: join(previousJournal, '..', 'batch.json'), previousJournal: path })).toThrow();
  stopSystemSends(path, 'QUALIFICATION_ASSERTION_OR_ENVIRONMENT');
  initializeSystemJournal(path + '.next', { authorization: standingAuthorization, batchLedger: join(previousJournal, '..', 'batch.json'), previousJournal: path });
  expect(readSystemJournal(path + '.next')).toMatchObject({ requests: 0, baselineTokens: 6351, cumulativeRequests: 10 });
});
it('standing authorization still blocks unknown sends, missing usage, corrupt history and locks', () => {
  const { path, previousJournal } = standingJournal();
  reserveSystemSend(path, 1000, 4096);
  stopSystemSends(path, 'PROVIDER_HTTP_500');
  expect(() => initializeSystemJournal(path + '.next', { authorization: standingAuthorization, batchLedger: join(previousJournal, '..', 'batch.json'), previousJournal: path })).toThrow('T09_BASELINE_INVALID');
  expect(() => reserveSystemSend(path, 1, 1)).toThrow('T09_PROVIDER_DIAGNOSIS_REQUIRED');
  const other = standingJournal();
  reserveSystemSend(other.path, 1000, 4096);
  expect(() => receiveSystemUsage(other.path, 1, { inputTokens: NaN, outputTokens: 1, cachedInputTokens: 0 })).toThrow('T09_USAGE_UNAVAILABLE');
  expect(() => initializeSystemJournal(other.path + '.next', { authorization: standingAuthorization, batchLedger: join(previousJournal, '..', 'batch.json'), previousJournal: other.path })).toThrow();
  writeFileSync(previousJournal, readFileSync(previousJournal, 'utf8') + ' ');
  expect(() => readSystemJournal(path)).toThrow('T09_BASELINE_INVALID');
});
it('explicit worktree relocation verifies unchanged historical bytes and claims without resetting usage', () => {
  const legacy = journal(), before = readFileSync(join(legacy, '..', 'previous.jsonl'), 'utf8');
  reserveSystemSend(legacy, 1000, 1000);
  receiveSystemUsage(legacy, 1, { inputTokens: 100, outputTokens: 100, cachedInputTokens: 0 });
  stopSystemSends(legacy, 'QUALIFICATION_COMPLETED');
  const legacyDir = join(legacy, '..'), relocatedDir = legacyDir + '.moved';
  const legacyBefore = readFileSync(legacy, 'utf8');
  renameSync(legacyDir, relocatedDir); dirs[dirs.indexOf(legacyDir)] = relocatedDir;
  const next = join(relocatedDir, 'next.jsonl');
  initializeSystemJournal(next, { authorization: standingAuthorization, batchLedger: join(relocatedDir, 'batch.json'), previousJournal: join(relocatedDir, 'journal.jsonl'),
    historicalPaths: { [legacy]: join(relocatedDir, 'journal.jsonl'),
      [join(legacyDir, 'previous.jsonl')]: join(relocatedDir, 'previous.jsonl') } });
  expect(readSystemJournal(next)).toMatchObject({ cumulativeTokens: 3281, cumulativeRequests: 8 });
  expect(readFileSync(join(relocatedDir, 'previous.jsonl'), 'utf8')).toBe(before);
  expect(readFileSync(join(relocatedDir, 'journal.jsonl'), 'utf8')).toBe(legacyBefore);
  writeFileSync(next + '.lock', 'abandoned');
  expect(() => reserveSystemSend(next, 1, 1)).toThrow();
  expect(readSystemJournal(next).requests).toBe(0);
});
it('a standing history can be imported into a later worktree with exact path aliases', () => {
  const { path, previousJournal } = standingJournal();
  reserveSystemSend(path, 1000, 4096);
  receiveSystemUsage(path, 1, { inputTokens: 100, outputTokens: 200, cachedInputTokens: 50 });
  stopSystemSends(path, 'QUALIFICATION_COMPLETED');
  const oldDir = realpathSync(join(path, '..')), newDir = oldDir + '.moved';
  renameSync(oldDir, newDir); dirs[dirs.indexOf(join(path, '..'))] = newDir;
  const next = join(newDir, 'next.jsonl');
  initializeSystemJournal(next, { authorization: standingAuthorization, batchLedger: join(newDir, 'batch.json'), previousJournal: join(newDir, 'journal.jsonl.standing'),
    historicalPaths: { [join(oldDir, 'journal.jsonl.standing')]: join(newDir, 'journal.jsonl.standing'), [path]: join(newDir, 'journal.jsonl.standing'), [join(oldDir, 'batch.json')]: join(newDir, 'batch.json'), [previousJournal]: join(newDir, 'journal.jsonl'),
      [join(previousJournal, '..', 'previous.jsonl')]: join(newDir, 'previous.jsonl') } });
  expect(readSystemJournal(next)).toMatchObject({ cumulativeTokens: 6351, cumulativeRequests: 10 });
});


it('T09-BATCH-01 rejects a standing reservation exceeding the fixed batch before any send', () => {
  const { path } = standingJournal();
  expect(() => reserveSystemSend(path, 10_000_000, 4096)).toThrow('T09_TOKEN_LIMIT');
  expect(readSystemJournal(path)).toMatchObject({ requests: 0, cumulativeTokens: 6051 });
});
it('settles actual usage, persists 50/80 checkpoints and stops at the exact batch boundary', () => {
  const { path } = standingJournal();
  reserveSystemSend(path, 6_000_000, 1000);
  receiveSystemUsage(path, 1, { inputTokens: 4_993_948, outputTokens: 1, cachedInputTokens: 1000 });
  expect(readSystemJournal(path)).toMatchObject({ cumulativeTokens: 5_000_000,
    batch: { id: 'T09-System-V1', tokenLimit: 10_000_000, phase: 'report' } });
  // Unused reservation released: the next 3M fits against actual 5M.
  reserveSystemSend(path, 2_999_999, 1);
  receiveSystemUsage(path, 2, { inputTokens: 2_999_999, outputTokens: 1, cachedInputTokens: 0 });
  expect(readSystemJournal(path).batch.phase).toBe('converge');
  expect(() => reserveSystemSend(path, 2_000_000, 1)).toThrow('T09_TOKEN_LIMIT');
  reserveSystemSend(path, 1_999_999, 1);
  receiveSystemUsage(path, 3, { inputTokens: 1_999_999, outputTokens: 1, cachedInputTokens: 0 });
  expect(readSystemJournal(path)).toMatchObject({ cumulativeTokens: 10_000_000, stopped: true,
    batch: { phase: 'stop' } });
  expect(readSystemJournal(path).entries.filter(e => e.kind === 'checkpoint').map(e => e.reason))
    .toEqual(['BATCH_50_REPORT', 'BATCH_80_CONVERGE', 'BATCH_100_STOP']);
  expect(() => initializeSystemJournal(path + '.next', { authorization: standingAuthorization,
    previousJournal: path, batchLedger: join(path, '..', 'batch.json') })).toThrow('T09_TOKEN_LIMIT');
});
it('a shared batch rejects alternate roots and copied journals even when copied claims match', () => {
  const one = standingJournal(), two = journal();
  stopSystemSends(two, 'QUALIFICATION_COMPLETED');
  expect(() => initializeSystemJournal(two + '.standing', { authorization: standingAuthorization,
    previousJournal: two, batchLedger: join(one.path, '..', 'batch.json') })).toThrow('T09_BATCH_FORK');
  reserveSystemSend(one.path, 1000, 1000);
  receiveSystemUsage(one.path, 1, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 });
  stopSystemSends(one.path, 'QUALIFICATION_COMPLETED');
  const copy = one.path + '.copy';
  writeFileSync(copy, readFileSync(one.path));
  const claimPath = one.previousJournal + '.' + standingAuthorization + '.claim';
  writeFileSync(claimPath, readFileSync(claimPath, 'utf8').replace(one.path, copy));
  expect(() => initializeSystemJournal(copy + '.next', { authorization: standingAuthorization,
    previousJournal: copy, batchLedger: join(one.path, '..', 'batch.json') })).toThrow('T09_BATCH_FORK');
});
it('unknown usage and overbound receipts survive restart and cannot replenish a batch', () => {
  const { path } = standingJournal();
  reserveSystemSend(path, 9_993_948, 1);
  expect(() => receiveSystemUsage(path, 1, { inputTokens: 9_993_949, outputTokens: 1, cachedInputTokens: 0 }))
    .toThrow('T09_USAGE_BOUND_EXCEEDED');
  expect(readSystemJournal(path)).toMatchObject({ cumulativeTokens: 10_000_001, stopped: true });
  expect(() => reserveSystemSend(path, 1, 1)).toThrow();
  const other = standingJournal();
  reserveSystemSend(other.path, 1000, 1000);
  expect(() => receiveSystemUsage(other.path, 1, { inputTokens: NaN, outputTokens: 1, cachedInputTokens: 0 })).toThrow();
  expect(() => initializeSystemJournal(other.path + '.next', { authorization: standingAuthorization,
    previousJournal: other.path, batchLedger: join(other.path, '..', 'batch.json') })).toThrow();
});
it('racing new processes share the standing batch reservation and preserve the full bound', async () => {
  const { path } = standingJournal();
  const codes = await Promise.all(Array.from({ length: 6 }, () => new Promise<number | null>((resolve, reject) => {
    const child = fork(new URL('./system-real-provider-budget.ts', import.meta.url), [], {
      execArgv: ['--import', import.meta.resolve('tsx'), '--eval',
        `import {reserveSystemSend} from ${JSON.stringify(new URL('./system-real-provider-budget.ts', import.meta.url).href)}; try {reserveSystemSend(process.env.T09_TEST_JOURNAL,9993948,1);process.exit(0);}catch{process.exit(1);}`],
      env: { ...process.env, T09_TEST_JOURNAL: path }, silent: true });
    child.once('error', reject); child.once('exit', resolve);
  })));
  expect(codes.filter(code => code === 0)).toHaveLength(1);
  expect(readSystemJournal(path)).toMatchObject({ requests: 1, cumulativeTokens: 6051,
    batch: { reservedTokens: 9_993_949, remainingTokens: 0 } });
}, 30_000);

it('a valid rollback to an earlier scene snapshot cannot replenish shared batch usage', () => {
  const { path } = standingJournal(), before = readFileSync(path);
  reserveSystemSend(path, 1000, 1000);
  receiveSystemUsage(path, 1, { inputTokens: 500, outputTokens: 500, cachedInputTokens: 0 });
  writeFileSync(path, before);
  expect(() => reserveSystemSend(path, 1000, 1000)).toThrow('T09_BATCH_JOURNAL_CHANGED');
});
it('missing batch state and abandoned shared locks never recreate a fresh batch', () => {
  const { path } = standingJournal(), ledger = readSystemJournal(path).batch!.ledger;
  stopSystemSends(path, 'QUALIFICATION_COMPLETED');
  renameSync(ledger, ledger + '.saved');
  expect(() => initializeSystemJournal(path + '.next', { authorization: standingAuthorization,
    previousJournal: path, batchLedger: ledger })).toThrow('T09_BATCH_LEDGER_MISSING');
  renameSync(ledger + '.saved', ledger);
  writeFileSync(ledger + '.lock', 'abandoned');
  expect(() => reserveSystemSend(path, 1, 1)).toThrow();
});

it('linked scenes retain cumulative usage and cannot change their shared batch ledger', () => {
  const { path } = standingJournal(), ledger = readSystemJournal(path).batch!.ledger;
  reserveSystemSend(path, 9_993_946, 1);
  receiveSystemUsage(path, 1, { inputTokens: 9_993_946, outputTokens: 1, cachedInputTokens: 1000 });
  stopSystemSends(path, 'QUALIFICATION_COMPLETED');
  expect(() => initializeSystemJournal(path + '.fork', { authorization: standingAuthorization,
    previousJournal: path, batchLedger: ledger + '.another' })).toThrow('T09_BATCH_FORK');
  initializeSystemJournal(path + '.next', { authorization: standingAuthorization, previousJournal: path, batchLedger: ledger });
  expect(readSystemJournal(path + '.next').cumulativeTokens).toBe(9_999_998);
  expect(() => reserveSystemSend(path + '.next', 2, 1)).toThrow('T09_TOKEN_LIMIT');
  reserveSystemSend(path + '.next', 1, 1);
  receiveSystemUsage(path + '.next', 1, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 });
  expect(readSystemJournal(path + '.next')).toMatchObject({ stopped: true, cumulativeTokens: 10_000_000 });
});
