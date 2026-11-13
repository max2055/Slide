export const DEFAULT_SESSION_RETENTION_DAYS = 30;
// Bound retention to 100 years, well within MySQL's date arithmetic range.
export const MAX_SESSION_RETENTION_DAYS = 36_500;

export function assertSessionRetentionDays(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SESSION_RETENTION_DAYS) {
    throw new RangeError(`Session retention days must be an integer between 1 and ${MAX_SESSION_RETENTION_DAYS}`);
  }
}

export function parseSessionRetentionDays(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_SESSION_RETENTION_DAYS;
  if (/[^0-9]/.test(value)) {
    throw new RangeError('SESSION_RETENTION_DAYS must contain only decimal digits');
  }
  const days = Number(value);
  assertSessionRetentionDays(days);
  return days;
}
