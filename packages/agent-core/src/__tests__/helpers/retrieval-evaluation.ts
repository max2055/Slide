import fs from 'node:fs/promises';
import { MemoryRetriever, DEFAULT_RETRIEVAL_LIMITS, memoryReferenceTokens, type MemoryReference } from '../../memory-retrieval.js';
import { memoryHash, scopeKey, type MemoryRecord, type MemoryScope, type MemoryInput } from '../../memory-record.js';
export async function evaluateRetrieval() {
  const file = await fs.readFile(new URL('../fixtures/memory-retrieval-v1.json', import.meta.url), 'utf8');
  const fixture = JSON.parse(file);
  const records: MemoryRecord[] = fixture.records;
  const reader = async (scope: MemoryScope, ids: string[]): Promise<MemoryInput[]> => fixture.liveSources.filter((s: any) => scopeKey(s.scope) === scopeKey(scope) && ids.includes(s.id)).map((s: any) => ({ id: s.id, hash: s.hash, content: s.content }));
  const retriever = new MemoryRetriever(async () => records, reader);
  const reference = (r: MemoryRecord): MemoryReference => ({ id: r.id, kind: r.kind, subject: r.subject, content: r.content, evidence: r.evidence, status: 'active', sources: r.sources.map(({ id, hash }) => ({ id, hash })) });
  const recall = (ids: string[], relevant: string[]) => relevant.length ? relevant.filter(id => ids.includes(id)).length / relevant.length : 1;
  const precision = (ids: string[], relevant: string[]) => ids.length ? ids.filter(id => relevant.includes(id)).length / ids.length : 0;
  const results = [];
  for (const q of [...fixture.queries, ...fixture.negativeQueries]) {
    const selected = await retriever.retrieve(q.scope, q.query);
    const repeated = await retriever.retrieve(q.scope, q.query);
    // Baselines share the same permission/status/source-valid pool, but perform no lexical selection.
    const pool = records.filter(r => r.status === 'active' && !r.invalidSourceIds.length
      && r.scope.workspaceId === q.scope.workspaceId && (scopeKey(r.scope) === scopeKey(q.scope) || r.sharedWith.includes(q.scope.actorId))
      && r.sources.every(s => fixture.liveSources.some((live: any) => scopeKey(live.scope) === scopeKey(r.scope) && live.id === s.id && live.hash === s.hash)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const recency: MemoryReference[] = [];
    for (const r of pool) {
      if (memoryReferenceTokens([...recency, reference(r)]) <= retriever.limits.maxTokens) recency.push(reference(r));
      if (recency.length === retriever.limits.maxCount) break;
    }
    const ids = selected.items.map(r => r.id); const recencyIds = recency.map(r => r.id);
    results.push({ id: q.id, query: q.query, scope: q.scope, relevantIds: q.relevantIds, selectedIds: ids,
      sourceIds: selected.items.flatMap(r => r.sources.map(s => s.id)), tokens: selected.tokens,
      recallAt5: recall(ids.slice(0, 5), q.relevantIds), precision: precision(ids, q.relevantIds),
      precisionAt5: ids.slice(0, 5).filter(id => q.relevantIds.includes(id)).length / 5,
      full: { ids: pool.map(r => r.id), tokens: memoryReferenceTokens(pool.map(reference)), recallAt5: recall(pool.slice(0, 5).map(r => r.id), q.relevantIds), precision: precision(pool.map(r => r.id), q.relevantIds) },
      recency: { ids: recencyIds, tokens: memoryReferenceTokens(recency), recallAt5: recall(recencyIds, q.relevantIds), precision: precision(recencyIds, q.relevantIds) },
      deterministic: JSON.stringify(selected) === JSON.stringify(repeated), withinBudget: selected.count <= retriever.limits.maxCount && selected.tokens <= retriever.limits.maxTokens,
      negative: fixture.negativeQueries.some((n: any) => n.id === q.id) });
  }
  const positive = results.filter(r => r.relevantIds.length);
  const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
  const median = (values: number[]) => { const v = [...values].sort((a, b) => a - b); return (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) / 2; };
  const medianTokens = median(positive.map(r => r.tokens)); const fullMedianTokens = median(positive.map(r => r.full.tokens));
  return { schemaVersion: 1, fixtureHash: memoryHash(file), records: records.length, queries: fixture.queries.length, scopeNegativeQueries: fixture.negativeQueries.length,
    limits: DEFAULT_RETRIEVAL_LIMITS, tokenMethod: 'utf8-upper-bound, including complete synthetic reference messages; NOT measured provider tokens',
    metrics: { recallAt5: mean(positive.map(r => r.recallAt5)), precision: mean(positive.map(r => r.precision)), precisionAt5: mean(positive.map(r => r.precisionAt5)), medianTokens,
      full: { recallAt5: mean(positive.map(r => r.full.recallAt5)), precision: mean(positive.map(r => r.full.precision)), medianTokens: fullMedianTokens },
      recency: { recallAt5: mean(positive.map(r => r.recency.recallAt5)), precision: mean(positive.map(r => r.recency.precision)), medianTokens: median(positive.map(r => r.recency.tokens)) },
      medianTokenReduction: 1 - medianTokens / fullMedianTokens, rawUnfilteredTokens: memoryReferenceTokens(records.map(reference)),
      forbiddenReturned: results.flatMap(r => r.selectedIds).filter(id => !records.some(m => m.id === id && m.status === 'active' && !m.invalidSourceIds.length)).length,
      scopeNegativeReturned: results.filter(r => r.negative).reduce((sum, r) => sum + r.selectedIds.length, 0),
      unmatchedReturned: results.filter(r => !r.relevantIds.length).reduce((sum, r) => sum + r.selectedIds.length, 0),
      deterministic: results.every(r => r.deterministic), withinBudget: results.every(r => r.withinBudget) },
    limitations: 'Synthetic lexical benchmark with fixed labels. No synonym/semantic recall claim, production sampling, real provider tokenizer or paid LLM inference. Precision is selected-set precision; precisionAt5 divides by 5. Recall is macro averaged over nonempty relevance labels. Full baseline uses deterministic recency order for top-5 and includes all eligible records for input volume.', results };
}
