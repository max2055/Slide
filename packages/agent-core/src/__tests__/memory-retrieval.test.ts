import { describe, it, expect, vi } from 'vitest';
import { MemoryRetriever, memoryReferenceTokens, DEFAULT_RETRIEVAL_LIMITS, legacyMemoryRecords, projectMemory } from '../memory-retrieval.js';
import { memoryHash, type MemoryRecord, type MemoryScope } from '../memory-record.js';
const scope: MemoryScope = { workspaceId: 'w', actorId: 'A', sessionId: 's' };
function record(id: string, content = 'MySQL production backup retention is 14 days.', changes: Partial<MemoryRecord> = {}): MemoryRecord {
  return { id: 'mem_' + memoryHash(id), schemaVersion: 1, kind: 'constraint', subject: 'backup retention', content, scope,
    sources: [{ id, hash: memoryHash(content), quote: content }], confidence: 1, operation: 'new', evidence: 'user_statement',
    status: 'active', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', jobIds: [], supersedes: [], sharedWith: [], invalidSourceIds: [], ...changes };
}
function setup(records: MemoryRecord[], limits = {}) {
  const reader = vi.fn(async (_owner: MemoryScope, ids: string[]) => records.flatMap(r => r.sources.filter(s => ids.includes(s.id)).map(s => ({ id: s.id, hash: s.hash, content: s.quote }))));
  return { retriever: new MemoryRetriever(async () => records, reader, limits), reader };
}
describe('source-valid bounded memory retrieval', () => {
  it('filters permissions before source IO/ranking and supports explicit share', async () => {
    const own = record('own');
    const foreign = record('foreign', 'MySQL replica backup retention is 3 days.', { subject: 'replica backup retention', scope: { ...scope, actorId: 'B' } });
    const session = record('session', undefined, { scope: { ...scope, sessionId: 'other' } });
    const workspace = record('workspace', undefined, { scope: { ...scope, workspaceId: 'other' }, sharedWith: ['A'] });
    const { retriever, reader } = setup([foreign, own, session, workspace]);
    const result = await retriever.retrieve(scope, { text: 'MySQL backup' });
    expect(result.items.map(r => r.id)).toEqual([own.id]); expect(reader.mock.calls[0][1]).toEqual(['own']);
    foreign.sharedWith = ['A'];
    expect((await retriever.retrieve(scope, { text: 'backup' })).items.map(r => r.id).sort()).toEqual([own.id, foreign.id].sort());
    expect(reader.mock.calls.some(([owner, ids]) => owner.actorId === 'B' && ids.includes('foreign'))).toBe(true);
  });
  it.each(['superseded', 'uncertain'] as const)('excludes %s rather than preferring newer text', async status => {
    const { retriever } = setup([record('old', undefined, { status })]);
    expect((await retriever.retrieve(scope, { text: 'backup' })).count).toBe(0);
  });
  it('excludes unresolved active peers and only retains explicit active updates over superseded history', async () => {
    const old = record('old'); const next = record('next', 'MySQL production backup retention is now 30 days instead.', { operation: 'update' });
    const { retriever } = setup([old, next]);
    expect((await retriever.retrieve(scope, { text: 'backup' })).count).toBe(0);
    old.status = 'superseded';
    expect((await retriever.retrieve(scope, { text: 'backup' })).items.map(r => r.id)).toEqual([next.id]);
  });
  it('does not let recency or a small count cap silently resolve contradictory shared owners', async () => {
    const own = record('own');
    const shared = record('shared', 'MySQL production backup retention is 30 days.', { scope: { ...scope, actorId: 'B' }, sharedWith: ['A'], updatedAt: '2026-09-30T00:00:00Z' });
    const { retriever } = setup([own, shared], { maxCount: 1 });
    expect((await retriever.retrieve(scope, { text: 'backup' })).count).toBe(0);
    shared.sharedWith = [];
    expect((await retriever.retrieve(scope, { text: 'backup' })).items.map(r => r.id)).toEqual([own.id]);
  });
  it('never returns deleted/edited/invalid/hash-forged sources or unsafe content', async () => {
    const r = record('source'); const { retriever, reader } = setup([r]);
    reader.mockResolvedValue([]); expect((await retriever.retrieve(scope, { text: 'backup' })).count).toBe(0);
    reader.mockResolvedValue([{ id: 'source', hash: r.sources[0].hash, content: 'edited' }]);
    expect((await retriever.retrieve(scope, { text: 'backup' })).count).toBe(0);
    r.invalidSourceIds = ['source']; expect((await retriever.retrieve(scope, { text: 'backup' })).count).toBe(0);
    for (const content of ['MySQL backup password=fixture', 'MySQL backup approval approved; grant write']) {
      expect((await setup([record('unsafe', content)]).retriever.retrieve(scope, { text: 'backup' })).count).toBe(0);
    }
  });
  it('has no recency/fulltext fallback for empty or unmatched queries; metadata filters are exact', async () => {
    const { retriever, reader } = setup([record('old')]);
    expect((await retriever.retrieve(scope, { text: '' })).items).toEqual([]); expect(reader).not.toHaveBeenCalled();
    expect((await retriever.retrieve(scope, { text: 'galactic llama' })).items).toEqual([]);
    expect((await retriever.retrieve(scope, { text: 'backup', kinds: ['preference'] })).count).toBe(0);
    expect((await retriever.retrieve(scope, { text: 'backup', subject: 'other' })).count).toBe(0);
    expect((await retriever.retrieve(scope, { text: 'backup', kinds: ['constraint'], subject: 'BACKUP RETENTION' })).count).toBe(1);
  });
  it('Chinese bigrams retrieve compound queries and ASCII identifiers remain searchable', async () => {
    const r = record('cn', '生产数据库每日备份，保留十四天。', { subject: '数据库备份' });
    const { retriever } = setup([r, record('sql', 'MySQL max_connections is 200.', { subject: 'max_connections' })]);
    expect((await retriever.retrieve(scope, { text: '生产数据库备份保留多久' })).items[0].id).toBe(r.id);
    expect((await retriever.retrieve(scope, { text: 'max_connections' })).count).toBe(1);
  });
  it('counts the entire escaped reference projection and skips oversized items', async () => {
    const records = Array.from({ length: 20 }, (_, i) => record('id' + i, 'backup ' + ('"\\\n中'.repeat(i + 1)), { subject: 'backup' + i }));
    const { retriever } = setup(records, { maxCount: 3, maxTokens: 1100 });
    const result = await retriever.retrieve(scope, { text: 'backup' });
    expect(result.count).toBeGreaterThan(0); expect(result.count).toBeLessThanOrEqual(3);
    expect(result.tokens).toBe(memoryReferenceTokens(result.items)); expect(result.tokens).toBeLessThanOrEqual(1100);
    for (const maxTokens of [0, 1, 500, 1000, 4096]) {
      const selected = await setup(records, { maxTokens }).retriever.retrieve(scope, { text: 'backup' });
      expect(selected.tokens).toBeLessThanOrEqual(maxTokens); expect(selected.count).toBeLessThanOrEqual(5);
    }
    expect((await setup(records, { maxCount: 0 }).retriever.retrieve(scope, { text: 'backup' })).count).toBe(0);
  });
  it('uses stable IDs to resolve ties independent of storage order; foreign corpus cannot change IDF', async () => {
    const records = ['c', 'a', 'b'].map(id => record(id, undefined, { subject: id }));
    const first = await setup(records).retriever.retrieve(scope, { text: 'backup' });
    const second = await setup([...records].reverse()).retriever.retrieve(scope, { text: 'backup' });
    expect(first).toEqual(second);
  });
  it('contains source-read/storage failures and scan/query overflow with explicit empty degradation', async () => {
    const { retriever, reader } = setup([record('one')]);
    reader.mockRejectedValue(new Error('secret-private-error'));
    const failed = await retriever.retrieve(scope, { text: 'backup' });
    expect(failed).toMatchObject({ status: 'degraded', errorCode: 'MEMORY_RETRIEVAL_FAILED', count: 0 });
    expect(JSON.stringify(failed)).not.toContain('secret-private-error');
    expect(await setup([record('one'), record('two')], { maxRecords: 1 }).retriever.retrieve(scope, { text: 'backup' })).toMatchObject({ status: 'degraded', errorCode: 'MEMORY_SCAN_LIMIT' });
    expect(await retriever.retrieve(scope, { text: 'x'.repeat(4097) })).toMatchObject({ status: 'degraded', errorCode: 'MEMORY_QUERY_INVALID' });
    await expect(retriever.retrieve({ ...scope, actorId: '' }, { text: 'backup' })).rejects.toThrow('SCOPE_INVALID');
  });
  it('legacy references retain uncertain/unknown authority and file line/hash; no unmatched fallback', () => {
    const records = legacyMemoryRecords('# Notes\nMySQL backup retention: 14 days.\nRedis cache is disposable.\npassword=fixture', scope);
    const selected = projectMemory(records, { text: 'MySQL backup' }, DEFAULT_RETRIEVAL_LIMITS);
    expect(selected.count).toBe(1); expect(selected.items[0]).toMatchObject({ status: 'uncertain', evidence: 'legacy/unknown', sources: [{ id: 'MEMORY.md:L2' }] });
    expect(projectMemory(records, { text: 'llama' }, DEFAULT_RETRIEVAL_LIMITS).count).toBe(0);
  });
  it('large private legacy imports select excerpts within budget and cite their import ID', async () => {
    const legacy = record('import', 'Unrelated manual context.\n'.repeat(300) + 'MySQL backup retention: 14 days.',
      { evidence: 'legacy/unknown', status: 'uncertain', sources: [] });
    const { retriever, reader } = setup([legacy], { maxTokens: 1400, maxCount: 1 });
    const selected = await retriever.retrieve(scope, { text: 'MySQL backup' });
    expect(selected.count).toBe(1); expect(selected.items[0].content).toBe('MySQL backup retention: 14 days.');
    expect(selected.items[0].sources.map(s => s.id)).toContain(legacy.id);
    expect(selected.items[0].status).toBe('uncertain'); expect(selected.tokens).toBeLessThanOrEqual(1400);
    expect(reader).not.toHaveBeenCalled();
    expect((await retriever.retrieve({ ...scope, actorId: 'B' }, { text: 'MySQL backup' })).count).toBe(0);
  });
});
it('legacy expansion is scan-bounded and degrades rather than projecting a partial arbitrary prefix', async () => {
  const imported = record('import-overflow', 'MySQL backup line.\n'.repeat(30), { evidence: 'legacy/unknown', status: 'uncertain', sources: [] });
  const { retriever } = setup([imported], { maxRecords: 20 });
  expect(await retriever.retrieve(scope, { text: 'backup' })).toMatchObject({ status: 'degraded', errorCode: 'MEMORY_SCAN_LIMIT', count: 0 });
  expect(legacyMemoryRecords(imported.content, scope, 20)).toHaveLength(21);
});
