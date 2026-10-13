/** Opt-in T09 qualification journal; never used by production startup. */
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export const SYSTEM_REAL_AUTHORIZATION = '01a135cd-25dd-7ab7-aca4-f92d31398f37';
export const SYSTEM_REAL_LIMITS = Object.freeze({ requests: 3, tokens: 32_000, output: 2048 });
type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens: number };
type RecordEntry = { kind: string; authorization: string; at: string; sequence?: number;
  inputUpperBound?: number; outputCeiling?: number; usage?: Usage; reason?: string };
const header = { kind: 'authorization', authorization: SYSTEM_REAL_AUTHORIZATION,
  at: new Date().toISOString(), limits: SYSTEM_REAL_LIMITS, historicalRequests: 5, historicalStopped: true };
const fail = (code: string): never => { throw new Error(code); };
const validInt = (n: number) => Number.isSafeInteger(n) && n >= 0;
const syncWrite = (path: string, value: unknown, flag: 'wx' | 'a') => {
  const fd = openSync(path, flag, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
};
/** Explicit one-time operator initialization. Existing history cannot be reset. */
export const initializeSystemJournal = (path: string) => syncWrite(path, header, 'wx');

export function readSystemJournal(path: string) {
  const entries = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as RecordEntry[];
  if (JSON.stringify((entries[0] as any)?.limits) !== JSON.stringify(SYSTEM_REAL_LIMITS)
    || (entries[0] as any)?.historicalRequests !== 5 || !(entries[0] as any)?.historicalStopped
    || entries[0]?.kind !== 'authorization') fail('T09_JOURNAL_INVALID');
  let requests = 0, pending: RecordEntry | undefined, stopped = false;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  for (const e of entries) {
    if (e.authorization !== SYSTEM_REAL_AUTHORIZATION || !Number.isFinite(Date.parse(e.at))) fail('T09_JOURNAL_INVALID');
    if (e === entries[0]) continue;
    if (e.kind === 'stop') { stopped = true; continue; }
    if (e.kind === 'send') {
      if (stopped || pending || e.sequence !== requests + 1 || ++requests > SYSTEM_REAL_LIMITS.requests
        || !validInt(e.inputUpperBound!) || !validInt(e.outputCeiling!) || !e.outputCeiling
        || e.outputCeiling > SYSTEM_REAL_LIMITS.output
        || usage.inputTokens + usage.outputTokens + e.inputUpperBound + e.outputCeiling > SYSTEM_REAL_LIMITS.tokens)
        fail('T09_JOURNAL_INVALID');
      pending = e;
    } else if (e.kind === 'receipt') {
      const u = e.usage;
      if (!pending || e.sequence !== pending.sequence || !u || ![u.inputTokens, u.outputTokens, u.cachedInputTokens].every(validInt)
        || u.cachedInputTokens > u.inputTokens) fail('T09_JOURNAL_INVALID');
      usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens; usage.cachedInputTokens += u.cachedInputTokens;
      pending = undefined;
    } else fail('T09_JOURNAL_INVALID');
  }
  return { entries, requests, pending, stopped, usage, totalTokens: usage.inputTokens + usage.outputTokens,
    cumulativeRequests: 5 + requests, historicalTokenUsage: 'unavailable; original stopped journal not reset' };
}
function locked<T>(path: string, action: () => T): T {
  const fd = openSync(`${path}.lock`, 'wx', 0o600);
  try { return action(); } finally { closeSync(fd); unlinkSync(`${path}.lock`); }
}
const entry = (value: Omit<RecordEntry, 'authorization' | 'at'>) =>
  ({ ...value, authorization: SYSTEM_REAL_AUTHORIZATION, at: new Date().toISOString() });
export function stopSystemSends(path: string, reason: string) {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(reason)) fail('T09_STOP_REASON_INVALID');
  locked(path, () => { if (!readSystemJournal(path).stopped) syncWrite(path, entry({ kind: 'stop', reason }), 'a'); });
}
/** Count fsynced BEFORE transport. A crash/incomplete usage blocks every later process. */
export function reserveSystemSend(path: string, inputUpperBound: number, outputCeiling: number) {
  return locked(path, () => {
    const s = readSystemJournal(path);
    if (s.stopped || s.pending) fail('T09_PROVIDER_DIAGNOSIS_REQUIRED');
    if (s.requests >= SYSTEM_REAL_LIMITS.requests) fail('T09_REQUEST_LIMIT');
    if (!validInt(inputUpperBound) || !validInt(outputCeiling) || !outputCeiling || outputCeiling > SYSTEM_REAL_LIMITS.output
      || s.totalTokens + inputUpperBound + outputCeiling > SYSTEM_REAL_LIMITS.tokens) fail('T09_TOKEN_LIMIT');
    const send = entry({ kind: 'send', sequence: s.requests + 1, inputUpperBound, outputCeiling });
    syncWrite(path, send, 'a'); return send;
  });
}
export function receiveSystemUsage(path: string, sequence: number, usage: Usage) {
  return locked(path, () => {
    const s = readSystemJournal(path), pending = s.pending;
    if (!pending || pending.sequence !== sequence || s.stopped) fail('T09_RECEIPT_INVALID');
    if (![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens].every(validInt) || usage.cachedInputTokens > usage.inputTokens) {
      syncWrite(path, entry({ kind: 'stop', reason: 'USAGE_UNAVAILABLE' }), 'a');
      fail('T09_USAGE_UNAVAILABLE');
    }
    syncWrite(path, entry({ kind: 'receipt', sequence, usage }), 'a');
    if (usage.inputTokens > pending.inputUpperBound! || usage.outputTokens > pending.outputCeiling!
      || s.totalTokens + usage.inputTokens + usage.outputTokens > SYSTEM_REAL_LIMITS.tokens) {
      syncWrite(path, entry({ kind: 'stop', reason: 'USAGE_BOUND_EXCEEDED' }), 'a');
      fail('T09_USAGE_BOUND_EXCEEDED');
    }
    return readSystemJournal(path);
  });
}
