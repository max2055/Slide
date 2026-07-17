export type ResourceType = 'instance' | 'server';
export interface ResourceRef { type: ResourceType; id: number; }
export type ResourceRelationType = 'runs_on' | 'hosts' | 'replicates_to' | 'depends_on';
export interface ResourceRelation {
  source: ResourceRef;
  target: ResourceRef;
  relationType: ResourceRelationType;
  provenance: string;
  validFrom: Date;
  validUntil?: Date | null;
}
export interface ResourceDetail { resource: ResourceRef; label: string; status: string; attributes: Record<string, string | number | boolean | null>; }
export type ObservationQuality = 'good' | 'degraded' | 'invalid' | 'unknown';
export interface Observation { resource: ResourceRef; metricId: string; dimensions?: Record<string, string>; value: number | null; observedAt: Date | null; validUntil: Date | null; source: string; quality: ObservationQuality; reason?: string; }
export function resourceKey(ref: ResourceRef): string { return `${ref.type}:${ref.id}`; }

export function canonicalDimensions(dimensions?: Record<string, string>): Record<string, string> | undefined {
  if (!dimensions) return undefined;
  const entries = Object.entries(dimensions)
    .filter(([, value]) => value !== '')
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return undefined;
  if (entries.length > 16 || entries.some(([key, value]) => !/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 256)) {
    throw new Error('OBSERVATION_DIMENSIONS_INVALID');
  }
  return Object.fromEntries(entries);
}
