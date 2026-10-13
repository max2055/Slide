/** Opt-in T09 qualification journal; never used by production startup. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync, closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const PREVIOUS_AUTHORIZATION = '01a135cd-25dd-7ab7-aca4-f92d31398f37';
export const SYSTEM_REAL_AUTHORIZATION = '01a13794-14e8-7972-84d2-dceb59de6552';
export const SYSTEM_PREVIOUS_SHA256 = '5469172ebc7d9135248ec93c357202e76d966c20fe1fe5fed9abab84e3c40377';
export const SYSTEM_REAL_LIMITS = Object.freeze({ requests: 3, tokens: 32_000, output: 2048 });
type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens: number };
type RecordEntry = { kind: string; authorization: string; at: string; sequence?: number;
  inputUpperBound?: number; outputCeiling?: number; usage?: Usage; reason?: string };
const fail = (code: string): never => { throw new Error(code); };
const validInt = (n: number) => Number.isSafeInteger(n) && n >= 0;
const syncWrite = (path: string, value: unknown, flag: 'wx' | 'a') => {
  const fd = openSync(path, flag, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
};
/** Explicit one-time operator initialization. Existing history cannot be reset. */
export function initializeSystemJournal(path: string, options: { authorization: string; previousJournal: string }) {
  if (options?.authorization !== SYSTEM_REAL_AUTHORIZATION) fail('T09_EXPLICIT_AUTHORIZATION_REQUIRED');
  if (existsSync(path)) fail('T09_JOURNAL_EXISTS');
  const previousJournal = resolve(options.previousJournal);
  const old = readSystemJournal(previousJournal);
  if (!old.stopped || old.pending || old.requests !== 2 || old.totalTokens !== 3081
    || old.usage.inputTokens !== 2469 || old.usage.outputTokens !== 612 || old.usage.cachedInputTokens !== 640
    || old.entries[0].authorization !== PREVIOUS_AUTHORIZATION || digest(previousJournal) !== SYSTEM_PREVIOUS_SHA256)
    fail('T09_BASELINE_INVALID');
  const baseline = { previousJournal, sha256: SYSTEM_PREVIOUS_SHA256, requests: 2, tokens: 3081 };
  // Durable one-time grant shared by every new scene linked to this old journal.
  // An interrupted initialization consumes the grant and requires diagnosis.
  syncWrite(claimPath(previousJournal), { authorization: SYSTEM_REAL_AUTHORIZATION, journal: resolve(path), baseline }, 'wx');
  syncWrite(path, { kind: 'authorization', authorization: SYSTEM_REAL_AUTHORIZATION, at: new Date().toISOString(),
    limits: SYSTEM_REAL_LIMITS, historicalRequests: 5, historicalStopped: true, baseline }, 'wx');
}
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const claimPath = (path: string) => `${path}.${SYSTEM_REAL_AUTHORIZATION}.claim`;


export function readSystemJournal(path: string) {
  const entries = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as RecordEntry[];
  if (JSON.stringify((entries[0] as any)?.limits) !== JSON.stringify(SYSTEM_REAL_LIMITS)
    || (entries[0] as any)?.historicalRequests !== 5 || !(entries[0] as any)?.historicalStopped
    || entries[0]?.kind !== 'authorization') fail('T09_JOURNAL_INVALID');
  const authorization = entries[0].authorization;
  if (![PREVIOUS_AUTHORIZATION, SYSTEM_REAL_AUTHORIZATION].includes(authorization)) fail('T09_JOURNAL_INVALID');
  const baseline = (entries[0] as any).baseline;
  const baselineTokens = authorization === SYSTEM_REAL_AUTHORIZATION ? 3081 : 0;
  if (baselineTokens) {
    if (!baseline || baseline.sha256 !== SYSTEM_PREVIOUS_SHA256 || baseline.requests !== 2 || baseline.tokens !== 3081
      || typeof baseline.previousJournal !== 'string' || resolve(baseline.previousJournal) !== baseline.previousJournal
      || digest(baseline.previousJournal) !== SYSTEM_PREVIOUS_SHA256) fail('T09_BASELINE_INVALID');
    const claim = JSON.parse(readFileSync(claimPath(baseline.previousJournal), 'utf8'));
    if (claim.authorization !== authorization || claim.journal !== resolve(path)
      || JSON.stringify(claim.baseline) !== JSON.stringify(baseline)) fail('T09_AUTHORIZATION_ALREADY_CONSUMED');
  } else if (baseline) fail('T09_JOURNAL_INVALID');
  let requests = 0, pending: RecordEntry | undefined, stopped = false;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  for (const e of entries) {
    if (e.authorization !== authorization || !Number.isFinite(Date.parse(e.at))) fail('T09_JOURNAL_INVALID');
    if (e === entries[0]) continue;
    if (e.kind === 'stop') { stopped = true; continue; }
    if (e.kind === 'send') {
      if (stopped || pending || e.sequence !== requests + 1 || ++requests > SYSTEM_REAL_LIMITS.requests
        || !validInt(e.inputUpperBound!) || !validInt(e.outputCeiling!) || !e.outputCeiling
        || e.outputCeiling > SYSTEM_REAL_LIMITS.output
        || baselineTokens + usage.inputTokens + usage.outputTokens + e.inputUpperBound + e.outputCeiling > SYSTEM_REAL_LIMITS.tokens)
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
    baselineTokens, cumulativeTokens: baselineTokens + usage.inputTokens + usage.outputTokens,
    cumulativeRequests: 5 + (baselineTokens ? 2 : 0) + requests, historicalTokenUsage: 'unavailable; original stopped journal not reset' };
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
    if (s.entries[0].authorization !== SYSTEM_REAL_AUTHORIZATION) fail('T09_EXPLICIT_AUTHORIZATION_REQUIRED');
    if (s.stopped || s.pending) fail('T09_PROVIDER_DIAGNOSIS_REQUIRED');
    if (s.requests >= SYSTEM_REAL_LIMITS.requests) fail('T09_REQUEST_LIMIT');
    if (!validInt(inputUpperBound) || !validInt(outputCeiling) || !outputCeiling || outputCeiling > SYSTEM_REAL_LIMITS.output
      || s.cumulativeTokens + inputUpperBound + outputCeiling > SYSTEM_REAL_LIMITS.tokens) fail('T09_TOKEN_LIMIT');
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
      || s.cumulativeTokens + usage.inputTokens + usage.outputTokens > SYSTEM_REAL_LIMITS.tokens) {
      syncWrite(path, entry({ kind: 'stop', reason: 'USAGE_BOUND_EXCEEDED' }), 'a');
      fail('T09_USAGE_BOUND_EXCEEDED');
    }
    return readSystemJournal(path);
  });
}
