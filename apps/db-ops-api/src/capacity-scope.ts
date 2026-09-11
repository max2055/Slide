/** A bounded explicit scope; never turn an empty or malformed filter into all instances. */
export function capacityInstanceIds(value: unknown, canRead: (id: number) => boolean): number[] | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d+(,\d+)*$/.test(value)) throw new Error('CAPACITY_SCOPE_INVALID');
  const ids = [...new Set(value.split(',').map(Number))];
  if (ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('CAPACITY_SCOPE_INVALID');
  if (ids.some(id => !canRead(id))) throw new Error('CAPACITY_SCOPE_FORBIDDEN');
  return ids;
}
