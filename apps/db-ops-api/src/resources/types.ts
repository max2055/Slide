export type ResourceType = 'instance' | 'server';
export interface ResourceRef { type: ResourceType; id: number; }
export type ObservationQuality = 'good' | 'degraded' | 'invalid' | 'unknown';
export interface Observation { resource: ResourceRef; metricId: string; value: number | null; observedAt: Date | null; validUntil: Date | null; source: string; quality: ObservationQuality; reason?: string; }
export function resourceKey(ref: ResourceRef): string { return `${ref.type}:${ref.id}`; }
