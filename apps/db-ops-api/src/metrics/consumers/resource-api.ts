import type { ActorContext } from '../../auth/actor-context.js';
import type { Ref } from '../policy/model.js';
import { rule } from '../policy/model.js';
import { migrateReference } from './migration.js';
import { metricConsumerService } from './runtime.js';

/** Old resource routes forward to the same formal query, preserving its complete evidence. */
export async function resourceMetricRead(actor: ActorContext, resource: Ref,
  options: { from?: string; to?: string; bucket_ms?: number; metric_ids?: string[] } = {},
  service: Pick<typeof metricConsumerService, 'discover' | 'query'> = metricConsumerService) {
  let ids = options.metric_ids;
  if (ids?.length) {
    const catalog = await service.discover(actor, resource);
    const engine = catalog.effective?.resolved.plan.binding.package.id.split('-')[0] ?? '';
    ids = ids.map(id => {
      const mapped = migrateReference(resource, engine, id).metric_id;
      rule(mapped && catalog.definitions.some(d => d.id === mapped), 'METRIC_REFERENCE_REVIEW_REQUIRED', 422);
      return mapped;
    });
  }
  const semantic = await service.query(actor, { resource, view: 'all', ...options,
    ...(ids ? { metric_ids: ids } : {}) });
  const metrics = semantic.metrics.flatMap(metric => metric.series.flatMap(series =>
    series.buckets.filter(bucket => bucket.observed_at).map(bucket => ({
      metric_id: metric.definition.id, semantic_version: metric.definition.semantic_version,
      dimensions: series.dimensions, value: bucket.value, unit: bucket.unit,
      recorded_at: bucket.observed_at, quality: bucket.quality, freshness: bucket.freshness,
    }))));
  const recorded_at = metrics.reduce<string | null>((latest, row) =>
    !latest || row.recorded_at! > latest ? row.recorded_at! : latest, null);
  return { source_contract: 'metrics' as const, metrics, recorded_at, semantic_metrics: semantic };
}
