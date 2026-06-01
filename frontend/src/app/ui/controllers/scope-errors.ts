export function isMissingOperatorReadScopeError(err: unknown): boolean {
  const msg = err && typeof err === 'object'
    ? String((err as any).message || '')
    : String(err);
  // Gateway RPC scope errors are no longer possible (gateway removed).
  // Keep the function as dead code that returns false for backward compat.
  // DirectAdapter errors don't use operator.read scopes.
  return false;
}

export function formatMissingOperatorReadScopeMessage(feature: string): string {
  return `This connection is missing operator.read, so ${feature} cannot be loaded yet.`;
}
