import type { Observation, ObservationQuality, ResourceRef } from './types.js';

export function latestObservation(input: { resource: ResourceRef; metricId: string; value?: number | null; observedAt?: Date | null; validForMs: number; now?: Date; source: string; }): Observation {
  const now = input.now ?? new Date();
  const observedAt = input.observedAt ?? null;
  if (input.value == null || !observedAt) return { resource: input.resource, metricId: input.metricId, value: null, observedAt, validUntil: null, source: input.source, quality: 'unknown', reason: 'missing_observation' };
  const validUntil = new Date(observedAt.getTime() + input.validForMs);
  const quality: ObservationQuality = validUntil <= now ? 'unknown' : 'good';
  return { resource: input.resource, metricId: input.metricId, value: input.value, observedAt, validUntil, source: input.source, quality, reason: quality === 'unknown' ? 'stale_observation' : undefined };
}
