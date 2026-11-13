/** Public storage failure: never expose driver SQL, addresses or credentials. */
export function cronStorageError(operation: string, error?: unknown): Error {
  console.error('Cron storage operation failed:', operation);
  return new Error('CRON_STORAGE_UNAVAILABLE', { cause: error });
}

export function validateCronPagination(limit: number, offset: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647) {
    throw new Error('CRON_INVALID_PAGINATION');
  }
}
