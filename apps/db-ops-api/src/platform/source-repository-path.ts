export function assertRepositoryPath(path: string, provider?: 'github' | 'gitlab'): void {
  const parts = typeof path === 'string' ? path.split('/') : [];
  if (typeof path !== 'string' || path.length > 256 || parts.length < 2 || (provider === 'github' && parts.length !== 2)
    || parts.some(part => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) || part.endsWith('.git')))
    throw new Error('SOURCE_CONFIG_INVALID');
}
