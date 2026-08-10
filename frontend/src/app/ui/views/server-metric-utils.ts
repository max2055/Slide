export interface ServerMetricValue {
  metric_name: string;
  metric_value: number | string;
  dimensions?: Record<string, unknown> | string | null;
}

function hasMountDimension(metric: ServerMetricValue): boolean {
  let dimensions = metric.dimensions;
  if (typeof dimensions === 'string') {
    try {
      dimensions = JSON.parse(dimensions) as Record<string, unknown>;
    } catch {
      return false;
    }
  }
  return Boolean(
    dimensions
    && typeof dimensions === 'object'
    && !Array.isArray(dimensions)
    && typeof dimensions.mount === 'string'
    && dimensions.mount.length > 0,
  );
}

export function aggregateServerDiskUsage(metrics: readonly ServerMetricValue[]): number | null {
  const canonical = metrics.filter((metric) =>
    metric.metric_name === 'disk_usage' && hasMountDimension(metric)
  );
  const selected = canonical.length > 0
    ? canonical
    : metrics.filter((metric) => metric.metric_name.startsWith('disk_usage_'));
  const values = selected
    .map((metric) => Number(metric.metric_value))
    .filter(Number.isFinite);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
