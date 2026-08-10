export function parseFaultDiagnosisInstanceId(value: unknown): number | null {
  const candidate = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
}
