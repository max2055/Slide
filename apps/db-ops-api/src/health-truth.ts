export type HealthStatus = 'healthy' | 'degraded' | 'critical' | 'unknown';
export interface HealthDimension {
  status: HealthStatus;
  numerator: number;
  denominator: number;
  failedRefs?: Array<{ type: 'instance' | 'server' | 'system'; id: number | string }>;
  observedAt?: string;
  reason?: string;
}
export interface HealthTruth {
  controlPlane: HealthDimension;
  managedAvailability: HealthDimension;
  dataFreshness: HealthDimension;
  workflow: HealthDimension;
  overall: HealthStatus;
}

const rank: Record<HealthStatus, number> = { healthy: 0, degraded: 1, unknown: 2, critical: 3 };

export function aggregateHealth(input: Omit<HealthTruth, 'overall'>): HealthTruth {
  const statuses = [input.controlPlane.status, input.managedAvailability.status, input.dataFreshness.status, input.workflow.status];
  const overall = statuses.reduce<HealthStatus>((worst, status) => rank[status] > rank[worst] ? status : worst, 'healthy');
  return { ...input, overall };
}

export function statusFromCounts(numerator: number, denominator: number): HealthStatus {
  if (denominator <= 0) return 'unknown';
  if (numerator === denominator) return 'healthy';
  return numerator / denominator <= 0.2 ? 'critical' : 'degraded';
}
