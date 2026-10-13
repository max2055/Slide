import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
