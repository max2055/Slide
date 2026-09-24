import type { Ref } from '../policy/model.js';

export type FormalSourceState = 'legacy' | 'v2' | 'pending';
export type MetricReadResult<Legacy, Semantic> =
  | { source: 'legacy'; data: Legacy }
  | { source: 'v2'; semantic: Semantic }
  | { source: 'pending' };

/** Select exactly one formal store. Pending/mixed state never falls back across generations. */
export async function routeMetricRead<Legacy, Semantic>(
  ref: Ref,
  sourceState: (ref: Ref) => Promise<FormalSourceState>,
  legacyRead: () => Promise<Legacy>,
  semanticRead: () => Promise<Semantic>,
): Promise<MetricReadResult<Legacy, Semantic>> {
  const source = await sourceState(ref);
  if (source === 'legacy') return { source, data: await legacyRead() };
  if (source === 'v2') return { source, semantic: await semanticRead() };
  return { source: 'pending' };
}
