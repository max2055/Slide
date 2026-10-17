import type { Ref } from '../../metrics/policy/model.js';

export type FormalSourceState = 'legacy' | 'semantic' | 'pending';
export type MetricReadResult<Legacy, Semantic> =
  | { source: 'legacy'; data: Legacy }
  | { source: 'semantic'; semantic: Semantic }
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
  if (source === 'semantic') return { source, semantic: await semanticRead() };
  return { source: 'pending' };
}
