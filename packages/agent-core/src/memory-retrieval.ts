import { memoryHash, assertMemoryScope, recordKey, scopeKey, unsafeMemoryText, type MemoryKind, type MemoryRecord, type MemoryScope } from './memory-record.js';
import type { MemorySourceReader } from './memory-pipeline.js';
import { projectContextBlocks, type ContextBlock } from './context-block.js';
import { estimatePromptTokens } from './runtime/context-manager.js';

export interface MemoryRetrievalLimits { maxCount: number; maxTokens: number; maxRecords: number; maxQueryBytes: number; }
export const DEFAULT_RETRIEVAL_LIMITS: MemoryRetrievalLimits = { maxCount: 5, maxTokens: 4096, maxRecords: 1000, maxQueryBytes: 4096 };
export interface MemoryQuery { text: string; kinds?: MemoryKind[]; subject?: string; }
export interface MemoryReference {
  id: string; kind: MemoryKind; subject: string; content: string;
  evidence: MemoryRecord['evidence']; status: 'active' | 'uncertain';
  sources: Array<{ id: string; hash: string }>;
}
export interface MemoryRetrievalResult {
  status: 'ok' | 'empty' | 'disabled' | 'degraded'; errorCode?: string;
  items: MemoryReference[]; tokens: number; count: number;
  method: 'utf8-upper-bound'; limits: MemoryRetrievalLimits;
}
export function retrievalLimits(limits: Partial<MemoryRetrievalLimits> = {}): MemoryRetrievalLimits {
  const result = { ...DEFAULT_RETRIEVAL_LIMITS, ...limits };
  if (Object.values(result).some(v => !Number.isSafeInteger(v) || v < 0)
    || result.maxCount > 20 || result.maxTokens > 32768 || result.maxRecords < 1 || result.maxRecords > 10000
    || result.maxQueryBytes < 1 || result.maxQueryBytes > 16384) throw new Error('MEMORY_RETRIEVAL_LIMITS_INVALID');
  return result;
}
export function emptyRetrieval(limits: MemoryRetrievalLimits, status: MemoryRetrievalResult['status'] = 'empty', errorCode?: string): MemoryRetrievalResult {
  return { status, ...(errorCode ? { errorCode } : {}), items: [], count: 0, tokens: 0, method: 'utf8-upper-bound', limits };
}
export function memoryReferenceBlock(items: MemoryReference[]): ContextBlock {
  return { kind: 'memory', sourceIds: items.flatMap(r => [r.id, ...r.sources.map(s => s.id)]), authority: 'reference',
    lifetime: 'request', priority: 40, tokenPolicy: 'bounded', value: { records: items } };
}
export function memoryReferenceTokens(items: MemoryReference[]): number {
  return items.length ? estimatePromptTokens(projectContextBlocks([memoryReferenceBlock(items)]), []) : 0;
}

const stopWords = new Set('a an the is are of to for in on and or i my me what which how please tell about do does 的 是 有 我 请 如何 什么'.split(' '));
/** No model calls: Unicode normalization, identifiers and overlapping CJK bigrams. */
function terms(text: string): string[] {
  const result: string[] = [];
  for (const word of text.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) ?? []) {
    if (/^\p{Script=Han}+$/u.test(word) && word.length > 1) {
      for (let i = 0; i < word.length - 1; i++) result.push(word.slice(i, i + 2));
    } else if (!stopWords.has(word)) result.push(word);
  }
  return result;
}
const stable = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** Input MUST already be permission-filtered and source-validated. IDF never sees foreign records. */
export function projectMemory(records: MemoryRecord[], query: MemoryQuery, limits: MemoryRetrievalLimits): MemoryRetrievalResult {
  if (typeof query.text !== 'string' || Buffer.byteLength(query.text) > limits.maxQueryBytes
    || (query.subject !== undefined && (typeof query.subject !== 'string' || query.subject.length > 200))) return emptyRetrieval(limits, 'degraded', 'MEMORY_QUERY_INVALID');
  const words = [...new Set(terms(query.text))];
  if (!words.length || !limits.maxCount || !limits.maxTokens) return emptyRetrieval(limits);
  const docs = records.filter(r => (!query.kinds || query.kinds.includes(r.kind))
    && (!query.subject || r.subject.normalize('NFKC').toLowerCase() === query.subject.normalize('NFKC').toLowerCase()))
    .map(record => {
      const docWords = terms(record.subject + '\n' + record.content);
      const frequencies = new Map<string, number>();
      for (const word of docWords) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
      return { record, length: docWords.length, frequencies };
    });
  const avg = docs.reduce((sum, d) => sum + d.length, 0) / (docs.length || 1);
  const df = new Map(words.map(w => [w, docs.filter(d => d.frequencies.has(w)).length]));
  const ranked = docs.map(d => {
    let score = 0;
    for (const word of words) {
      const tf = d.frequencies.get(word) ?? 0;
      if (tf) score += Math.log(1 + (docs.length - df.get(word)! + 0.5) / (df.get(word)! + 0.5))
        * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * d.length / (avg || 1)));
    }
    return { record: d.record, score };
  }).filter(d => d.score > 0).sort((a, b) => b.score - a.score
    || stable(b.record.updatedAt, a.record.updatedAt) || stable(a.record.id, b.record.id));
  const items: MemoryReference[] = [];
  for (const { record: r } of ranked) {
    const item: MemoryReference = { id: r.id, kind: r.kind, subject: r.subject, content: r.content,
      evidence: r.evidence, status: r.evidence === 'legacy/unknown' ? 'uncertain' : 'active',
      sources: r.sources.length ? r.sources.map(s => ({ id: s.id, hash: s.hash })) : [{ id: 'MEMORY.md:legacy', hash: memoryHash(r.content) }] };
    if (memoryReferenceTokens([...items, item]) <= limits.maxTokens) items.push(item);
    if (items.length === limits.maxCount) break;
  }
  return { ...emptyRetrieval(limits, items.length ? 'ok' : 'empty'), items, count: items.length, tokens: memoryReferenceTokens(items) };
}

/** Permission filtering is repeated defensively before status checks, source lookup or ranking. */
export class MemoryRetriever {
  readonly limits: MemoryRetrievalLimits;
  constructor(private records: (scope: MemoryScope) => Promise<MemoryRecord[]>, private reader: MemorySourceReader,
    limits: Partial<MemoryRetrievalLimits> = {}) { this.limits = retrievalLimits(limits); }
  async retrieve(scope: MemoryScope, query: MemoryQuery): Promise<MemoryRetrievalResult> {
    assertMemoryScope(scope);
    if (typeof query.text !== 'string' || Buffer.byteLength(query.text) > this.limits.maxQueryBytes) return emptyRetrieval(this.limits, 'degraded', 'MEMORY_QUERY_INVALID');
    if (!query.text.trim() || !this.limits.maxCount || !this.limits.maxTokens) return emptyRetrieval(this.limits);
    try {
      const accessible = (await this.records(scope)).filter(r => r.scope.workspaceId === scope.workspaceId
        && (scopeKey(r.scope) === scopeKey(scope) || r.sharedWith.includes(scope.actorId)));
      if (accessible.length > this.limits.maxRecords) return emptyRetrieval(this.limits, 'degraded', 'MEMORY_SCAN_LIMIT');
      const topics = new Map<string, Set<string>>();
      for (const r of accessible.filter(r => r.status !== 'superseded')) {
        const key = recordKey(r); const contents = topics.get(key) ?? new Set<string>();
        contents.add(r.content); topics.set(key, contents);
      }
      const eligible = accessible.filter(r => r.schemaVersion === 1 && /^(?:mem|legacy)_[a-f0-9]{64}$/.test(r.id)
        && r.sources.every(s => /^[a-zA-Z0-9_-]{1,256}$/.test(s.id) && !unsafeMemoryText(s.id) && /^[a-f0-9]{64}$/.test(s.hash))
        && !r.invalidSourceIds.length && !unsafeMemoryText(r.subject + '\n' + r.content)
        && r.content.length <= 16000 && r.subject.length <= 200
        && (r.evidence === 'legacy/unknown' ? r.status === 'uncertain' && r.operation === 'new' : r.status === 'active' && r.sources.length > 0 && !['conflict', 'negate'].includes(r.operation))
        && topics.get(recordKey(r))!.size === 1);
      const owners = new Map(eligible.filter(r => r.evidence === 'user_statement').map(r => [scopeKey(r.scope), r.scope]));
      // Imported manual files are excerpts, not a large all-or-nothing record.
      // Cite both the fragment's line/hash and its private stored import ID.
      const valid: MemoryRecord[] = [];
      for (const r of eligible.filter(r => r.evidence === 'legacy/unknown')) {
        const fragments = legacyMemoryRecords(r.content, r.scope, this.limits.maxRecords - valid.length);
        if (fragments.length + valid.length > this.limits.maxRecords) return emptyRetrieval(this.limits, 'degraded', 'MEMORY_SCAN_LIMIT');
        valid.push(...fragments.map(fragment => ({ ...fragment, kind: r.kind, subject: r.subject,
          createdAt: r.createdAt, updatedAt: r.updatedAt,
          sources: [...fragment.sources, { id: r.id, hash: memoryHash(r.content), quote: fragment.content }] })));
      }
      for (const owner of owners.values()) {
        const owned = eligible.filter(r => r.evidence === 'user_statement' && scopeKey(r.scope) === scopeKey(owner));
        const ids = [...new Set(owned.flatMap(r => r.sources.map(s => s.id)))];
        if (ids.length > this.limits.maxRecords * 10) return emptyRetrieval(this.limits, 'degraded', 'MEMORY_SCAN_LIMIT');
        const live = new Map<string, { hash: string; content: string }>();
        for (let i = 0; i < ids.length; i += 1000) {
          for (const input of await this.reader(owner, ids.slice(i, i + 1000))) live.set(input.id, input);
        }
        valid.push(...owned.filter(r => r.sources.every(src => {
          const input = live.get(src.id);
          return input && input.hash === src.hash && memoryHash(input.content) === src.hash && src.quote === r.content && input.content.includes(src.quote);
        })));
      }
      if (valid.length > this.limits.maxRecords) return emptyRetrieval(this.limits, 'degraded', 'MEMORY_SCAN_LIMIT');
      // Sharing does not resolve contradictory owners' statements. Exclude the
      // topic before ranking/budget selection can silently retain only one side.
      const topic = (r: MemoryRecord) => memoryHash([r.kind, r.subject.normalize('NFKC').trim().toLowerCase()]);
      const statements = new Map<string, Set<string>>();
      for (const r of valid.filter(r => r.evidence === 'user_statement')) {
        const key = topic(r); const contents = statements.get(key) ?? new Set<string>();
        contents.add(r.content); statements.set(key, contents);
      }
      return projectMemory(valid.filter(r => r.evidence === 'legacy/unknown' || statements.get(topic(r))!.size === 1), query, this.limits);
    } catch {
      // No exception text or full-memory fallback: corruption, DB outage and source-read errors are contained.
      return emptyRetrieval(this.limits, 'degraded', 'MEMORY_RETRIEVAL_FAILED');
    }
  }
}

/** Compatibility only: caller must bind file ownership before using this private reference. */
export function legacyMemoryRecords(text: string, scope: MemoryScope, maxRecords = DEFAULT_RETRIEVAL_LIMITS.maxRecords): MemoryRecord[] {
  assertMemoryScope(scope);
  const hash = memoryHash(text);
  const result: MemoryRecord[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    const content = line.trim();
    if (!content || content.startsWith('#') || content.length > 4000 || unsafeMemoryText(content)) continue;
    const id = 'legacy_' + memoryHash([scopeKey(scope), hash, index]);
    result.push({ id, schemaVersion: 1, scope, kind: 'fact', subject: 'legacy MEMORY.md', content,
      sources: [{ id: `MEMORY.md:L${index + 1}`, hash, quote: content }], confidence: 0, operation: 'new', evidence: 'legacy/unknown',
      status: 'uncertain', createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z',
      jobIds: [], supersedes: [], sharedWith: [], invalidSourceIds: [] });
    // One sentinel lets callers report overflow without projecting an arbitrary prefix.
    if (result.length > maxRecords) break;
  }
  return result;
}
