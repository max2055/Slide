/** Opt-in T09 qualification journal; never used by production startup. */
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, realpathSync, renameSync, closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const PREVIOUS_AUTHORIZATION = '01a135cd-25dd-7ab7-aca4-f92d31398f37';
export const SYSTEM_REAL_AUTHORIZATION = '01a13794-14e8-7972-84d2-dceb59de6552';
export const SYSTEM_STANDING_AUTHORIZATION = '01a137d7-4d36-757f-a0ad-2d92cb91299b';
export const SYSTEM_PREVIOUS_SHA256 = '5469172ebc7d9135248ec93c357202e76d966c20fe1fe5fed9abab84e3c40377';
export const SYSTEM_REAL_LIMITS = Object.freeze({ requests: 3, tokens: 32_000, output: 2048 });
export const SYSTEM_BATCH = Object.freeze({ id: 'T09-System-V1', tokenLimit: 10_000_000 });
export const SYSTEM_BATCH_LEDGER = resolve(homedir(), '.slide/qualification/T09-System-V1.json');
type BatchBinding = typeof SYSTEM_BATCH & { ledger: string };
const canonical = (path: string) => existsSync(path) ? realpathSync(path) : resolve(realpathSync(dirname(path)), basename(path));
const phase = (tokens: number) => tokens >= SYSTEM_BATCH.tokenLimit ? 'stop' : tokens >= SYSTEM_BATCH.tokenLimit * .8 ? 'converge' : tokens >= SYSTEM_BATCH.tokenLimit * .5 ? 'report' : 'normal';
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
export function initializeSystemJournal(path: string, options: {
  authorization: string; previousJournal: string; historicalPaths?: Record<string, string>; batchLedger?: string;
}) {
  if (![SYSTEM_REAL_AUTHORIZATION, SYSTEM_STANDING_AUTHORIZATION].includes(options?.authorization)) fail('T09_EXPLICIT_AUTHORIZATION_REQUIRED');
  if (existsSync(path)) fail('T09_JOURNAL_EXISTS');
  const previousJournal = resolve(options.previousJournal);
  if (options.authorization === SYSTEM_STANDING_AUTHORIZATION) {
    // One shared pointer selects the only active scene across worktrees. The
    // immutable journal chain remains the source of actual usage, not a second counter.
    const ledgerPath = options.batchLedger ?? SYSTEM_BATCH_LEDGER;
    mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
    const ledger = canonical(ledgerPath);
    return locked(ledger, () => locked(previousJournal, () => {
      const previous = readSystemJournal(previousJournal, new Set(), options.historicalPaths);
      const paths = { ...(previous.entries[0] as any).historicalPaths, ...options.historicalPaths };
      if (!previous.stopped || previous.pending) fail('T09_BASELINE_INVALID');
      if (previous.cumulativeTokens >= SYSTEM_BATCH.tokenLimit) fail('T09_TOKEN_LIMIT');
      if (previous.batch && previous.batch.ledger !== ledger) fail('T09_BATCH_FORK');
      if (existsSync(ledger)) assertBatchOwner(ledger, previousJournal, paths);
      else {
        if (previous.batch) fail('T09_BATCH_LEDGER_MISSING');
        if (!options.batchLedger && previous.cumulativeTokens < 12_536) fail('T09_BASELINE_INVALID');
        syncWrite(ledger, { ...SYSTEM_BATCH, activeJournal: canonical(previousJournal), sha256: digest(previousJournal) }, 'wx');
      }
      if (existsSync(claimPath(previousJournal)) || existsSync(claimPath(previousJournal, SYSTEM_STANDING_AUTHORIZATION)))
        fail('T09_AUTHORIZATION_ALREADY_CONSUMED');
      const baseline = { previousJournal, sha256: digest(previousJournal), requests: previous.cumulativeRequests, tokens: previous.cumulativeTokens };
      syncWrite(claimPath(previousJournal, options.authorization), { authorization: options.authorization, journal: canonical(path), baseline }, 'wx');
      syncWrite(path, { kind: 'authorization', authorization: options.authorization, at: new Date().toISOString(),
        limits: null, batch: { ...SYSTEM_BATCH, ledger }, historicalRequests: 5, historicalStopped: true, baseline,
        historicalPaths: paths }, 'wx');
      // Crash before pointer replacement fails closed: the predecessor grant is
      // consumed, and the new scene cannot send until it is the recorded owner.
      writeBatchPointer(ledger, path);
    }));
  }
  const old = readSystemJournal(previousJournal, new Set(), options.historicalPaths);
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
const claimPath = (path: string, authorization = SYSTEM_REAL_AUTHORIZATION) => `${path}.${authorization}.claim`;


export function readSystemJournal(path: string, ancestors: Set<string> = new Set(), historicalPaths: Record<string, string> = {}) {
  if (ancestors.has(canonical(path))) fail('T09_BASELINE_INVALID');
  ancestors.add(canonical(path));
  const entries = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as RecordEntry[];
  const standing = entries[0]?.authorization === SYSTEM_STANDING_AUTHORIZATION;
  const binding = (entries[0] as any)?.batch as BatchBinding | undefined;
  if (binding && (!standing || binding.id !== SYSTEM_BATCH.id || binding.tokenLimit !== SYSTEM_BATCH.tokenLimit
    || typeof binding.ledger !== 'string' || resolve(binding.ledger) !== binding.ledger)) fail('T09_JOURNAL_INVALID');
  if (standing) historicalPaths = { ...(entries[0] as any).historicalPaths, ...historicalPaths };
  if (!historicalPaths || typeof historicalPaths !== 'object' || Array.isArray(historicalPaths)
    || Object.entries(historicalPaths).some(([from, to]) => typeof to !== 'string'
      || resolve(from) !== from || resolve(to) !== to)) fail('T09_BASELINE_INVALID');
  // Exact aliases only: verify original bytes and claim bindings, never rewrite history.
  const relocated = (original: string) => historicalPaths[original] ?? original;
  if (JSON.stringify((entries[0] as any)?.limits) !== JSON.stringify(standing ? null : SYSTEM_REAL_LIMITS)
    || (entries[0] as any)?.historicalRequests !== 5 || !(entries[0] as any)?.historicalStopped
    || entries[0]?.kind !== 'authorization') fail('T09_JOURNAL_INVALID');
  const authorization = entries[0].authorization;
  if (![PREVIOUS_AUTHORIZATION, SYSTEM_REAL_AUTHORIZATION, SYSTEM_STANDING_AUTHORIZATION].includes(authorization)) fail('T09_JOURNAL_INVALID');
  const baseline = (entries[0] as any).baseline;
  let baselineTokens = authorization === SYSTEM_REAL_AUTHORIZATION ? 3081 : 0;
  let baselineRequests = baselineTokens ? 7 : 5;
  if (standing) {
    if (!baseline || !validInt(baseline.tokens) || !validInt(baseline.requests)
      || typeof baseline.previousJournal !== 'string' || resolve(baseline.previousJournal) !== baseline.previousJournal
      || digest(relocated(baseline.previousJournal)) !== baseline.sha256) fail('T09_BASELINE_INVALID');
    const previous = readSystemJournal(relocated(baseline.previousJournal), ancestors, historicalPaths);
    if (!previous.stopped || previous.pending || previous.cumulativeTokens !== baseline.tokens
      || previous.cumulativeRequests !== baseline.requests) fail('T09_BASELINE_INVALID');
    baselineTokens = baseline.tokens; baselineRequests = baseline.requests;
    const claim = JSON.parse(readFileSync(claimPath(relocated(baseline.previousJournal), authorization), 'utf8'));
    if (claim.authorization !== authorization || canonical(relocated(claim.journal)) !== canonical(path)
      || JSON.stringify(claim.baseline) !== JSON.stringify(baseline)) fail('T09_AUTHORIZATION_ALREADY_CONSUMED');
  } else if (baselineTokens) {
    if (!baseline || baseline.sha256 !== SYSTEM_PREVIOUS_SHA256 || baseline.requests !== 2 || baseline.tokens !== 3081
      || typeof baseline.previousJournal !== 'string' || resolve(baseline.previousJournal) !== baseline.previousJournal
      || digest(relocated(baseline.previousJournal)) !== SYSTEM_PREVIOUS_SHA256) fail('T09_BASELINE_INVALID');
    const claim = JSON.parse(readFileSync(claimPath(relocated(baseline.previousJournal)), 'utf8'));
    if (claim.authorization !== authorization || canonical(relocated(claim.journal)) !== canonical(path)
      || JSON.stringify(claim.baseline) !== JSON.stringify(baseline)) fail('T09_AUTHORIZATION_ALREADY_CONSUMED');
  } else if (baseline) fail('T09_JOURNAL_INVALID');
  let requests = 0, pending: RecordEntry | undefined, stopped = false;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  for (const e of entries) {
    if (e.authorization !== authorization || !Number.isFinite(Date.parse(e.at))) fail('T09_JOURNAL_INVALID');
    if (e === entries[0]) continue;
    if (e.kind === 'stop') { stopped = true; continue; }
    if (e.kind === 'send') {
      if (stopped || pending || e.sequence !== requests + 1 || (++requests > SYSTEM_REAL_LIMITS.requests && !standing)
        || !validInt(e.inputUpperBound!) || !validInt(e.outputCeiling!) || !e.outputCeiling
        || (!standing && (e.outputCeiling > SYSTEM_REAL_LIMITS.output
        || baselineTokens + usage.inputTokens + usage.outputTokens + e.inputUpperBound + e.outputCeiling > SYSTEM_REAL_LIMITS.tokens)))
        fail('T09_JOURNAL_INVALID');
      pending = e;
    } else if (e.kind === 'receipt') {
      const u = e.usage;
      if (!pending || e.sequence !== pending.sequence || !u || ![u.inputTokens, u.outputTokens, u.cachedInputTokens].every(validInt)
        || u.cachedInputTokens > u.inputTokens) fail('T09_JOURNAL_INVALID');
      usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens; usage.cachedInputTokens += u.cachedInputTokens;
      pending = undefined;
    } else if (e.kind === 'checkpoint') {
      const tokens = baselineTokens + usage.inputTokens + usage.outputTokens;
      const thresholds: Record<string, number> = { BATCH_50_REPORT: .5, BATCH_80_CONVERGE: .8, BATCH_100_STOP: 1 };
      const threshold = thresholds[e.reason!];
      if (!binding || pending || !threshold || tokens < SYSTEM_BATCH.tokenLimit * threshold) fail('T09_JOURNAL_INVALID');
    } else fail('T09_JOURNAL_INVALID');
  }
  const cumulativeTokens = baselineTokens + usage.inputTokens + usage.outputTokens;
  const reservedTokens = pending ? pending.inputUpperBound! + pending.outputCeiling! : 0;
  const batch = binding ? { ...binding, ledger: canonical(relocated(binding.ledger)), phase: phase(cumulativeTokens),
    reservedTokens, remainingTokens: Math.max(0, SYSTEM_BATCH.tokenLimit - cumulativeTokens - reservedTokens) } : undefined;
  return { entries, requests, pending, stopped, usage, batch, totalTokens: usage.inputTokens + usage.outputTokens,
    baselineTokens, cumulativeTokens: baselineTokens + usage.inputTokens + usage.outputTokens,
    cumulativeRequests: baselineRequests + requests, historicalTokenUsage: 'unavailable; original stopped journal not reset' };
}
function writeBatchPointer(ledger: string, journal: string) {
  const next = ledger + '.next';
  syncWrite(next, { ...SYSTEM_BATCH, activeJournal: canonical(journal), sha256: digest(journal) }, 'wx');
  renameSync(next, ledger);
  const fd = openSync(dirname(ledger), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function assertBatchOwner(ledger: string, journal: string, paths: Record<string, string> = {}) {
  const state = JSON.parse(readFileSync(ledger, 'utf8'));
  if (state.id !== SYSTEM_BATCH.id || state.tokenLimit !== SYSTEM_BATCH.tokenLimit
    || typeof state.activeJournal !== 'string' || resolve(state.activeJournal) !== state.activeJournal) fail('T09_BATCH_LEDGER_INVALID');
  // Aliases may relocate unavailable originals; they cannot steal an extant owner.
  const active = existsSync(state.activeJournal) ? state.activeJournal : paths[state.activeJournal] ?? state.activeJournal;
  if (!existsSync(active) || canonical(active) !== canonical(journal)) fail('T09_BATCH_FORK');
  if (state.sha256 !== digest(journal)) fail('T09_BATCH_JOURNAL_CHANGED');
}
function sceneLocked<T>(path: string, action: () => T): T {
  const s = readSystemJournal(path);
  if (s.entries[0].authorization !== SYSTEM_STANDING_AUTHORIZATION) return locked(path, action);
  if (!s.batch) fail('T09_BATCH_INITIALIZATION_REQUIRED'); // legacy evidence stays readable only
  return locked(s.batch.ledger, () => {
    assertBatchOwner(s.batch!.ledger, path, (s.entries[0] as any).historicalPaths);
    return locked(path, () => {
      const before = digest(path);
      try { return action(); } finally {
        // Persist the new hash even when usage validation appended a stop and threw.
        // An interrupted write leaves a mismatch/lock, requiring diagnosis, never a reset.
        if (digest(path) !== before) writeBatchPointer(s.batch!.ledger, path);
      }
    });
  });
}
function locked<T>(path: string, action: () => T): T {
  path = canonical(path);
  const fd = openSync(`${path}.lock`, 'wx', 0o600);
  try { return action(); } finally { closeSync(fd); unlinkSync(`${path}.lock`); }
}
const entry = (authorization: string, value: Omit<RecordEntry, 'authorization' | 'at'>) =>
  ({ ...value, authorization, at: new Date().toISOString() });
export function stopSystemSends(path: string, reason: string) {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(reason)) fail('T09_STOP_REASON_INVALID');
  sceneLocked(path, () => { const s = readSystemJournal(path);
    if (!s.stopped) syncWrite(path, entry(s.entries[0].authorization, { kind: 'stop', reason }), 'a'); });
}
/** Count fsynced BEFORE transport. A crash/incomplete usage blocks every later process. */
export function reserveSystemSend(path: string, inputUpperBound: number, outputCeiling: number) {
  return sceneLocked(path, () => {
    const s = readSystemJournal(path);
    const authorization = s.entries[0].authorization, standing = authorization === SYSTEM_STANDING_AUTHORIZATION;
    if (!standing && authorization !== SYSTEM_REAL_AUTHORIZATION) fail('T09_EXPLICIT_AUTHORIZATION_REQUIRED');
    if (s.stopped || s.pending) fail('T09_PROVIDER_DIAGNOSIS_REQUIRED');
    if (!standing && s.requests >= SYSTEM_REAL_LIMITS.requests) fail('T09_REQUEST_LIMIT');
    if (!validInt(inputUpperBound) || !validInt(outputCeiling) || !outputCeiling || (!standing && (outputCeiling > SYSTEM_REAL_LIMITS.output
      || s.cumulativeTokens + inputUpperBound + outputCeiling > SYSTEM_REAL_LIMITS.tokens))
      || (standing && s.cumulativeTokens + inputUpperBound + outputCeiling > SYSTEM_BATCH.tokenLimit)) fail('T09_TOKEN_LIMIT');
    const send = entry(authorization, { kind: 'send', sequence: s.requests + 1, inputUpperBound, outputCeiling });
    syncWrite(path, send, 'a'); return send;
  });
}
export function receiveSystemUsage(path: string, sequence: number, usage: Usage) {
  return sceneLocked(path, () => {
    const s = readSystemJournal(path), pending = s.pending;
    const authorization = s.entries[0].authorization;
    if (!pending || pending.sequence !== sequence || s.stopped) fail('T09_RECEIPT_INVALID');
    if (![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens].every(validInt) || usage.cachedInputTokens > usage.inputTokens) {
      syncWrite(path, entry(authorization, { kind: 'stop', reason: 'USAGE_UNAVAILABLE' }), 'a');
      fail('T09_USAGE_UNAVAILABLE');
    }
    syncWrite(path, entry(authorization, { kind: 'receipt', sequence, usage }), 'a');
    if (usage.inputTokens > pending.inputUpperBound! || usage.outputTokens > pending.outputCeiling!
      || (s.cumulativeTokens + usage.inputTokens + usage.outputTokens > (authorization === SYSTEM_STANDING_AUTHORIZATION ? SYSTEM_BATCH.tokenLimit : SYSTEM_REAL_LIMITS.tokens))) {
      syncWrite(path, entry(authorization, { kind: 'stop', reason: 'USAGE_BOUND_EXCEEDED' }), 'a');
      fail('T09_USAGE_BOUND_EXCEEDED');
    }
    if (s.batch) {
      const total = s.cumulativeTokens + usage.inputTokens + usage.outputTokens;
      for (const [threshold, reason] of [[.5, 'BATCH_50_REPORT'], [.8, 'BATCH_80_CONVERGE'], [1, 'BATCH_100_STOP']] as const) {
        if (total >= SYSTEM_BATCH.tokenLimit * threshold && !s.entries.some(e => e.kind === 'checkpoint' && e.reason === reason))
          syncWrite(path, entry(authorization, { kind: 'checkpoint', reason }), 'a');
      }
      if (total >= SYSTEM_BATCH.tokenLimit) syncWrite(path, entry(authorization, { kind: 'stop', reason: 'BATCH_100_STOP' }), 'a');
    }
    return readSystemJournal(path);
  });
}
