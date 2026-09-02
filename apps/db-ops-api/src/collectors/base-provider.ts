/**
 * MetricProvider interface + BaseMetricProvider abstract class
 *
 * Defines the contract for metric collectors that Registry<MetricProvider> manages.
 */
import type { DatabaseConnection } from '../database-service.js';
import type { MetricDefinition } from '../metric-registry.js';

export interface MetricProvider {
  readonly name: string;
  readonly supportedDbTypes: string[];
  enabled: boolean;
  consecutiveFailures: number;
  collect(instance: DatabaseConnection, metricDef: MetricDefinition): Promise<number | null>;
  describeSchema?(instanceId: number): Promise<string>;
  resetFailures(): void;
}

export abstract class BaseMetricProvider implements MetricProvider {
  abstract readonly name: string;
  abstract readonly supportedDbTypes: string[];
  enabled = true;
  consecutiveFailures = 0;

  abstract collect(instance: DatabaseConnection, metricDef: MetricDefinition): Promise<number | null>;

  describeSchema(instanceId: number): Promise<string> {
    return Promise.resolve('');
  }

  resetFailures(): void {
    this.consecutiveFailures = 0;
  }
}

export function calculateCounterRate(
  instance: DatabaseConnection,
  metricId: string,
  currentValue: number,
  now: number = Date.now(),
  precision: number = 0,
): number {
  const counters = instance.collectorDeltaCounters ??= {};
  const previous = counters[metricId];
  counters[metricId] = { value: currentValue, timestamp: now };
  if (!previous || currentValue < previous.value || now <= previous.timestamp) return 0;
  const factor = 10 ** precision;
  return Math.max(0, Math.round((currentValue - previous.value) / ((now - previous.timestamp) / 1000) * factor) / factor);
}
