export const isMetricTimestamp = (value: string) => /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

export function formatMetricTime(value: string, includeDate = false): string {
  if (!isMetricTimestamp(value)) return value;
  return new Date(value).toLocaleString('zh-CN', {
    ...(includeDate ? { month: '2-digit', day: '2-digit' } as const : {}),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}
