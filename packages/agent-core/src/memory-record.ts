import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { withMemoryLock, writeMemoryFile } from './memory-history.js';

export const MEMORY_KINDS = ['fact', 'preference', 'decision', 'constraint', 'task_state'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];
/** Identity is supplied by the authenticated caller, never by model output or a path. */
export interface MemoryScope { workspaceId: string; actorId: string; sessionId: string; }
export interface MemorySource { id: string; hash: string; quote: string; }
export interface MemoryCandidate {
  kind: MemoryKind; subject: string; content: string;
  sources: MemorySource[]; confidence: number;
  operation: 'new' | 'update' | 'conflict' | 'negate';
}
export interface MemoryRecord extends MemoryCandidate {
  schemaVersion: 1; id: string; scope: MemoryScope;
  evidence: 'user_statement' | 'legacy/unknown';
  status: 'active' | 'superseded' | 'uncertain';
  createdAt: string; updatedAt: string;
  jobIds: string[]; supersedes: string[]; sharedWith: string[];
  invalidSourceIds: string[];
}
export interface MemoryInput { id: string; hash: string; content: string; }
export interface MemoryLimits { maxMessages: number; maxCandidates: number; maxInputBytes: number; maxOutputTokens: number; maxTotalTokens: number; maxProviderAttempts: number; deadlineMs: number; }
export interface MemoryJob {
  schemaVersion: 1; id: string; scope: MemoryScope; boundary: string;
  inputs: MemoryInput[]; limits: MemoryLimits; createdAt: number; deadlineAt: number;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'budget_exhausted' | 'obsolete';
  attempts: number; usage: Record<string, number>; reservedTokens: number;
  requests: Array<{ attempt: number; requestId?: string; usage: Record<string, number>; reservation: number; outcome: string; errorCode?: string; providerStatus?: number }>;
  owner?: { pid: number; host: string; token: string };
  errorCode?: string;
}
export interface MemoryState {
  schemaVersion: 1; records: MemoryRecord[]; jobs: MemoryJob[];
  tombstones: string[];
  budgets: Record<string, { attempts: number; tokens: number }>;
}
export function memoryHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function scopeKey(scope: MemoryScope): string { return memoryHash([scope.workspaceId, scope.actorId, scope.sessionId]); }
export function assertMemoryScope(scope: MemoryScope): void {
  if (!scope || Object.values(scope).length !== 3 || [scope.workspaceId, scope.actorId, scope.sessionId].some(v => typeof v !== 'string' || !v.trim() || v.length > 256)) throw new Error('MEMORY_SCOPE_INVALID');
}
/** Fail closed for credentials, approvals and instruction/policy text. No secret goes to extraction. */
export function unsafeMemoryText(text: string): boolean {
  return /(?:\b(?:[a-z][a-z0-9]*[_-])*(?:password|passwd|pwd|token|secret|api[_ -]?key|authorization|cookie|credential|private[_ -]?key)(?:[_-][a-z0-9]+)*\b|密码|口令|密钥|令牌|凭据|-----BEGIN|\bsk-[a-z0-9]|\bBearer\s|[a-z]+:\/\/[^\s/@]+:[^\s/@]+@|\b(?:approve[ds]?|approval|permission|system\s+prompt|ignore\s+(?:all|previous)|developer\s+message)\b|批准|审批|授权|忽略.{0,8}指令)/i.test(text);
}
export function validateCandidates(value: unknown, inputs: MemoryInput[], maxCandidates: number): MemoryCandidate[] {
  if (!Array.isArray(value) || value.length > maxCandidates) throw new Error('MEMORY_SCHEMA_INVALID');
  const sources = new Map(inputs.map(m => [m.id, m]));
  return value.map(c => {
    if (!c || typeof c !== 'object' || Object.keys(c).some(k => !['kind', 'subject', 'content', 'sources', 'confidence', 'operation'].includes(k))
      || !MEMORY_KINDS.includes(c.kind) || typeof c.subject !== 'string' || !c.subject.trim() || c.subject.length > 200
      || typeof c.content !== 'string' || !c.content.trim() || c.content.length > 4000 || unsafeMemoryText(c.subject + '\n' + c.content)
      || !Number.isFinite(c.confidence) || c.confidence < 0 || c.confidence > 1
      || !['new', 'update', 'conflict', 'negate'].includes(c.operation)
      || !Array.isArray(c.sources) || !c.sources.length || c.sources.length > inputs.length) throw new Error('MEMORY_SCHEMA_INVALID');
    for (const s of c.sources) {
      const input = sources.get(s?.id);
      if (!input || Object.keys(s).some(k => !['id', 'hash', 'quote'].includes(k)) || s.hash !== input.hash || typeof s.quote !== 'string'
        || !s.quote.trim() || !input.content.includes(s.quote) || s.quote !== c.content) throw new Error('MEMORY_EVIDENCE_INVALID');
    }
    // An update/negation requires explicit evidence in the quoted statement.
    if (c.operation === 'update' && !/\b(?:now|instead|changed|update|replace|no longer)\b|现在|改为|更新|替换|不再/i.test(c.content)) throw new Error('MEMORY_UPDATE_UNSUPPORTED');
    if (c.operation === 'negate' && !/\b(?:not|never|no longer|incorrect|false)\b|不|否|错误|取消/i.test(c.content)) throw new Error('MEMORY_NEGATION_UNSUPPORTED');
    return structuredClone(c);
  });
}
function subjectKey(scope: MemoryScope, kind: MemoryKind, subject: string): string { return memoryHash([scopeKey(scope), kind, subject.trim().toLowerCase()]); }
export function recordKey(r: Pick<MemoryRecord, 'scope' | 'kind' | 'subject'>): string { return subjectKey(r.scope, r.kind, r.subject); }
export function applyCandidates(state: MemoryState, job: MemoryJob, candidates: MemoryCandidate[]): void {
  const now = new Date().toISOString();
  for (const candidate of candidates) {
    const key = subjectKey(job.scope, candidate.kind, candidate.subject);
    if (state.tombstones.includes(key)) continue;
    const peers = state.records.filter(r => recordKey(r) === key && r.status !== 'superseded');
    const id = 'mem_' + memoryHash([key, candidate.content, candidate.operation]);
    const existing = state.records.find(r => r.id === id);
    if (existing) {
      // An invalidated source must not be revived by an older replay.
      if (!existing.invalidSourceIds.length) {
        for (const source of candidate.sources) if (!existing.sources.some(s => s.id === source.id && s.hash === source.hash)) existing.sources.push(source);
        if (!existing.jobIds.includes(job.id)) existing.jobIds.push(job.id);
        existing.updatedAt = now;
      }
      continue;
    }
    const explicit = candidate.operation === 'update' || candidate.operation === 'negate';
    const conflict = candidate.operation === 'conflict' || (!explicit && peers.some(r => r.content !== candidate.content));
    for (const peer of peers) { peer.status = explicit ? 'superseded' : conflict ? 'uncertain' : peer.status; peer.updatedAt = now; }
    state.records.push({ ...structuredClone(candidate), id, schemaVersion: 1, scope: structuredClone(job.scope),
      evidence: 'user_statement', status: conflict || candidate.operation === 'negate' || /\b(?:maybe|perhaps|might|uncertain|unverified|not sure)\b|可能|不确定|未验证/i.test(candidate.content) ? 'uncertain' : 'active',
      createdAt: now, updatedAt: now, jobIds: [job.id], supersedes: explicit ? peers.map(r => r.id) : [], sharedWith: [], invalidSourceIds: [] });
  }
}

/** Single-host crash-recoverable file transactions. Stop older writers before upgrading the lock protocol. */
export class StructuredMemoryStore {
  readonly file: string;
  constructor(directory: string) { this.file = path.resolve(directory, 'memory-v1.json'); }
  /** One file open reads either inode around an atomic rename, never a partial write.
   * A concurrent mutation may finish after this snapshot; the next read sees it.
   * Reads neither recover locks nor initialize/persist a missing store.
   */
  private async readSnapshot(): Promise<MemoryState> {
    let state: MemoryState;
    try { state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { schemaVersion: 1, records: [], jobs: [], tombstones: [], budgets: {} };
    }
    if (!state || state.schemaVersion !== 1 || !Array.isArray(state.records) || !Array.isArray(state.jobs) || !Array.isArray(state.tombstones) || !state.budgets) throw new Error('MEMORY_STORE_INVALID');
    return state;
  }
  async transaction<T>(action: (state: MemoryState) => T | Promise<T>): Promise<T> {
    return withMemoryLock(this.file, async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const lock = this.file + '.lock';
      const owner = { pid: process.pid, host: os.hostname(), token: crypto.randomUUID() };
      const release = await acquireMemoryGuard(lock + '.owner', owner);
      let handle;
      try {
        // All upgraded writers hold the guard even while this diagnostic file is
        // empty/partial. Legacy empty/truncated files can therefore be recovered
        // without an age heuristic. Mixed old/new writer versions are unsupported.
        try {
          const content = await fs.readFile(lock, 'utf8');
          let old;
          try { old = JSON.parse(content); } catch { /* interrupted legacy write */ }
          if (old && ownerAlive(old)) throw new Error('MEMORY_STORE_BUSY');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        handle = await fs.open(lock, 'w', 0o600);
        await handle.chmod(0o600);
        await handle.writeFile(JSON.stringify(owner)); await handle.sync();
        const state = await this.readSnapshot();
        const result = await action(state);
        await writeMemoryFile(this.file, JSON.stringify(state), 0o600);
        await fs.chmod(this.file, 0o600);
        return structuredClone(result);
      } finally {
        try {
          if (handle) {
            try { await handle.close(); } finally { await fs.unlink(lock); }
          }
        } finally { await release(); }
      }
    });
  }
  async list(scope: MemoryScope): Promise<MemoryRecord[]> {
    assertMemoryScope(scope);
    const state = await this.readSnapshot();
    return state.records.filter(r => r.scope.workspaceId === scope.workspaceId
      && ((r.scope.actorId === scope.actorId && r.scope.sessionId === scope.sessionId) || r.sharedWith.includes(scope.actorId)));
  }
  async delete(scope: MemoryScope, id: string): Promise<void> {
    assertMemoryScope(scope);
    await this.transaction(state => {
      const record = state.records.find(r => r.id === id && scopeKey(r.scope) === scopeKey(scope));
      if (!record) throw new Error('MEMORY_NOT_FOUND');
      const key = recordKey(record);
      if (!state.tombstones.includes(key)) state.tombstones.push(key);
      state.records = state.records.filter(r => recordKey(r) !== key);
      for (const job of state.jobs.filter(j => scopeKey(j.scope) === scopeKey(scope) && j.state !== 'succeeded')) job.state = 'cancelled';
    });
  }
  async share(scope: MemoryScope, id: string, actors: string[]): Promise<void> {
    assertMemoryScope(scope);
    if (!Array.isArray(actors) || actors.length > 50 || actors.some(a => typeof a !== 'string' || !a.trim() || a.length > 256)) throw new Error('MEMORY_SHARE_INVALID');
    await this.transaction(state => {
      const r = state.records.find(r => r.id === id && scopeKey(r.scope) === scopeKey(scope));
      if (!r) throw new Error('MEMORY_NOT_FOUND');
      r.sharedWith = [...new Set(actors.filter(a => a !== scope.actorId))]; r.updatedAt = new Date().toISOString();
    });
  }
  async invalidate(scope: MemoryScope, live: Map<string, string>, ids: string[]): Promise<void> {
    assertMemoryScope(scope);
    // Reconciliation with unchanged evidence is a read. Keep the transactional
    // recheck below when either records or jobs need persistent invalidation.
    const snapshot = await this.readSnapshot();
    const own = scopeKey(scope);
    const sourceChanged = (s: { id: string; hash: string }) => ids.includes(s.id) && live.get(s.id) !== s.hash;
    if (!snapshot.records.some(r => scopeKey(r.scope) === own && r.sources.some(sourceChanged))
      && !snapshot.jobs.some(j => scopeKey(j.scope) === own && j.inputs.some(sourceChanged))) return;
    await this.transaction(state => {
      for (const r of state.records.filter(r => scopeKey(r.scope) === scopeKey(scope))) {
        const changed = r.sources.filter(s => ids.includes(s.id) && live.get(s.id) !== s.hash).map(s => s.id);
        if (changed.length) { r.status = 'uncertain'; r.invalidSourceIds = [...new Set([...r.invalidSourceIds, ...changed])]; r.updatedAt = new Date().toISOString(); }
      }
      for (const job of state.jobs.filter(j => scopeKey(j.scope) === scopeKey(scope))) {
        if (job.inputs.some(s => ids.includes(s.id) && live.get(s.id) !== s.hash)) { job.state = 'obsolete'; job.errorCode = 'MEMORY_SOURCE_CHANGED'; }
      }
    });
  }
  async export(scope: MemoryScope): Promise<string> {
    return JSON.stringify({ schemaVersion: 1, records: await this.list(scope) });
  }
  /** Restore evidence without restoring sharing or resetting runtime/job budgets.
   * Source validity is checked by the pipeline before retrieval. Deleted topics
   * remain deleted even when restoring an older export.
   */
  async importVersioned(scope: MemoryScope, value: unknown): Promise<void> {
    assertMemoryScope(scope);
    const data = value as { schemaVersion?: number; records?: MemoryRecord[] };
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.records) || data.records.length > 1000) throw new Error('MEMORY_EXPORT_INVALID');
    const records = structuredClone(data.records);
    for (const r of records) {
      if (!r || Object.keys(r).some(k => !['schemaVersion','id','scope','kind','subject','content','sources','confidence','operation','evidence','status','createdAt','updatedAt','jobIds','supersedes','sharedWith','invalidSourceIds'].includes(k))
        || r.schemaVersion !== 1 || scopeKey(r.scope) !== scopeKey(scope) || !/^(?:mem|legacy)_[a-f0-9]{64}$/.test(r.id)
        || !MEMORY_KINDS.includes(r.kind) || typeof r.subject !== 'string' || !r.subject.trim() || r.subject.length > 200
        || typeof r.content !== 'string' || !r.content.trim() || r.content.length > 16000 || unsafeMemoryText(r.content + '\n' + r.subject)
        || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1 || !['new','update','conflict','negate'].includes(r.operation)
        || !/^\d{4}-\d{2}-\d{2}T/.test(r.createdAt) || !Number.isFinite(Date.parse(r.createdAt))
        || !/^\d{4}-\d{2}-\d{2}T/.test(r.updatedAt) || !Number.isFinite(Date.parse(r.updatedAt))
        || !['user_statement', 'legacy/unknown'].includes(r.evidence) || !Array.isArray(r.sources)
        || !Array.isArray(r.jobIds) || !Array.isArray(r.supersedes) || !Array.isArray(r.invalidSourceIds)
        || r.jobIds.some(id => !/^extract_[a-f0-9]{64}$/.test(id)) || r.supersedes.some(id => !/^(?:mem|legacy)_[a-f0-9]{64}$/.test(id))
        || r.invalidSourceIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(id) || unsafeMemoryText(id))
        || r.sources.some(src => !src || Object.keys(src).some(k => !['id','hash','quote'].includes(k)) || typeof src.id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(src.id) || unsafeMemoryText(src.id) || !/^[a-f0-9]{64}$/.test(src.hash) || src.quote !== r.content)
        || (r.evidence === 'user_statement' && !r.sources.length)) throw new Error('MEMORY_EXPORT_INVALID');
      r.scope = structuredClone(scope); r.status = 'uncertain'; r.sharedWith = [];
    }
    await this.transaction(state => {
      for (const r of records) {
        if (state.tombstones.includes(recordKey(r)) || state.records.some(existing => existing.id === r.id)) continue;
        state.records.push(r);
      }
    });
  }

  /** Legacy text remains a private uncertain reference. It never overwrites MEMORY.md. */
  async importLegacy(scope: MemoryScope, text: string): Promise<void> {
    assertMemoryScope(scope);
    if (!text.trim() || text.length > 16000 || unsafeMemoryText(text)) throw new Error('MEMORY_LEGACY_UNSAFE');
    await this.transaction(state => {
      const id = 'legacy_' + memoryHash([scopeKey(scope), text]);
      if (state.records.some(r => r.id === id) || state.tombstones.includes(subjectKey(scope, 'fact', 'legacy MEMORY.md'))) return;
      const now = new Date().toISOString();
      state.records.push({ id, schemaVersion: 1, scope, kind: 'fact', subject: 'legacy MEMORY.md', content: text, sources: [], confidence: 0,
        operation: 'new', evidence: 'legacy/unknown', status: 'uncertain', createdAt: now, updatedAt: now, jobIds: [], supersedes: [], sharedWith: [], invalidSourceIds: [] });
    });
  }
}

type MemoryLockOwner = { host: string; pid: number; token: string };

/** Publish ownership together with the guard: rename never replaces a nonempty
 * directory. A stale remover addresses the unique marker, then uses rmdir,
 * which cannot remove a fresh owner's nonempty directory (including ABA races).
 * No age-based expiry and no reclaim lock that itself needs another lock.
 */
async function acquireMemoryGuard(guard: string, owner: MemoryLockOwner): Promise<() => Promise<void>> {
  const marker = Buffer.from(JSON.stringify(owner)).toString('base64url');
  const staging = guard + '.' + owner.token;
  await fs.mkdir(staging, { mode: 0o700 });
  let published = false;
  const removeEmpty = async (directory: string) => {
    try { await fs.rmdir(directory); }
    catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  };
  try {
    await fs.mkdir(path.join(staging, marker), { mode: 0o700 });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fs.rename(staging, guard);
        published = true;
        return async () => {
          await removeEmpty(path.join(guard, marker));
          await removeEmpty(guard);
        };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      let entries: string[];
      try { entries = await fs.readdir(guard); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (entries.length) {
        let previous: MemoryLockOwner;
        try { previous = JSON.parse(Buffer.from(entries[0], 'base64url').toString('utf8')); }
        catch { throw new Error('MEMORY_STORE_BUSY'); }
        if (entries.length !== 1 || !previous || typeof previous.token !== 'string' || !previous.token
          || ownerAlive(previous)) throw new Error('MEMORY_STORE_BUSY');
        await removeEmpty(path.join(guard, entries[0]));
      }
      await removeEmpty(guard);
    }
    throw new Error('MEMORY_STORE_BUSY');
  } finally {
    if (!published) {
      await removeEmpty(path.join(staging, marker));
      await removeEmpty(staging);
    }
  }
}
export function ownerAlive(owner: { host: string; pid: number } | undefined): boolean {
  if (!owner) return false;
  if (owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
