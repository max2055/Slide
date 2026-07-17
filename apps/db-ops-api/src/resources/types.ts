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
export type ObservationQuality = 'good' | 'degraded' | 'invalid' | 'unknown';
export interface Observation { resource: ResourceRef; metricId: string; value: number | null; observedAt: Date | null; validUntil: Date | null; source: string; quality: ObservationQuality; reason?: string; }
export function resourceKey(ref: ResourceRef): string { return `${ref.type}:${ref.id}`; }
