export type SchedulableMetric = { id: string; default_interval: number };

export function dueMetricIds(definitions: readonly SchedulableMetric[], lastSuccessMs: ReadonlyMap<string, number>, nowMs: number): string[] {
  return definitions
    .filter((definition) => {
      const last = lastSuccessMs.get(definition.id);
      return last === undefined || nowMs - last >= definition.default_interval * 1000;
    })
    .map((definition) => definition.id);
}

export function recordCollectionResult(lastSuccessMs: Map<string, number>, metricId: string, nowMs: number, succeeded: boolean): void {
  if (succeeded) lastSuccessMs.set(metricId, nowMs);
}
