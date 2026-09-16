/** Source targets are operator-approved origins, never arbitrary Agent URLs. */
export function sourceOrigin(value: string, allowedOrigins: readonly string[]): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('SOURCE_ORIGIN_DENIED'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || !allowedOrigins.includes(url.origin)) throw new Error('SOURCE_ORIGIN_DENIED');
  return url;
}

/** Accept literal branch/tag names and SHA-1s, not revision expressions or refspecs. */
export function sourceRef(value?: string): string {
  const ref = value || 'HEAD';
  const hasControlOrSpace = [...ref].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127);
  if (ref.length > 256 || ref.startsWith('-') || ref.startsWith('+') || ref === '@' || hasControlOrSpace || /[~^:?*[\\]/.test(ref) || ref.includes('..') || ref.includes('@{')
    || ref.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new Error('SOURCE_REF_INVALID');
  }
  return ref;
}
