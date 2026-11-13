/** Native catalogs are selected only by a parsed HTTP(S) endpoint. */
export function isNativeEndpoint(baseUrl: string | undefined, hosts: readonly string[], port?: string): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && hosts.includes(url.hostname) && (port === undefined || url.port === port);
  } catch {
    return false;
  }
}
