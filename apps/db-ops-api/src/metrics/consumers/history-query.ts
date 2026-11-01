import type { ConfigurationAt } from '../../contracts/metrics/configuration-history.js';
import type { NormalizedObservation } from '../../contracts/metrics/index.js';
import { aggregate, type SemanticQuery, type SemanticBucket } from '../query.js';
import { historySampling } from './history-context.js';

/** Settings follow each sample revision, never the resource's current binding. */
export async function aggregateHistory(q: SemanticQuery, points: NormalizedObservation[],
  configurationAt: (revision: number) => Promise<ConfigurationAt>): Promise<SemanticBucket[]> {
  const revisions = [...new Set(points.map(p => p.versions.config_revision))];
  if (revisions.length > 100) throw new Error('QUERY_LIMIT_EXCEEDED');
  const windows = await Promise.all(revisions.map(async revision => {
    const configuration = await configurationAt(revision);
    const settings = configuration.state === 'effective' ? configuration.settings : null;
    return aggregate({ ...q, interval_ms: settings?.interval_ms ?? historySampling.interval_ms,
      max_gap_ms: settings?.max_counter_gap_ms ?? historySampling.max_gap_ms,
      stale_after_ms: settings?.stale_after_ms ?? historySampling.max_gap_ms },
    [points.filter(p => p.versions.config_revision === revision)]);
  }));
  const empty = aggregate(q, [[]]);
  return empty.map((bucket, i) => {
    const candidates = windows.map(w => w[i]).filter(b => b.sources.length);
    if (candidates.length === 1) return candidates[0];
    if (!candidates.length) return bucket;
    // A bucket spanning revisions has no single proven cadence. Keep provenance,
    // reject a blended value/coverage, and never bridge counters across revisions.
    return { ...bucket, sources: candidates.flatMap(b => b.sources), value: null, coverage: 0,
      observed_at: candidates.map(b => b.observed_at).filter((at): at is string => Boolean(at)).sort().at(-1) ?? null,
      quality: { status: 'unknown', reason: 'gap' }, stats: undefined };
  });
}
