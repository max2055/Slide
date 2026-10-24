import type { MetricDefinition } from '../../contracts/metrics/index.js';

/** Bounded selection index, not a replacement definition. One explicit ID
 * returns the full definition. Offsets apply to the same config revision. */
export function metricDiscoveryPage(definitions: MetricDefinition[], offset = 0, limit = 64, id?: string) {
  const selected = id ? definitions.filter(d => d.id === id) : definitions.slice(offset, offset + limit);
  return {
    definitions: id ? selected : selected.map(d => ({
      id: d.id, semantic_version: d.semantic_version, meaning: d.meaning,
      category: d.category, scope: d.scope, unit: d.unit, kind: d.kind,
      temporality: d.temporality, dimensions: d.dimensions,
    })),
    metric_ids: selected.map(d => d.id),
    discovery: { detail: id ? 'definition' : 'index', total: definitions.length,
      offset: id ? null : offset, limit: id ? 1 : limit,
      next_offset: !id && offset + limit < definitions.length ? offset + limit : null },
  };
}
