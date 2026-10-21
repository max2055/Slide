const extensions: Record<string, string> = {
  'text/html': 'html', 'application/pdf': 'pdf', 'application/json': 'json',
  'text/markdown': 'md', 'text/csv': 'csv', 'text/plain': 'txt',
};

export function reportDownloadFilename(headers: Headers, fallback: string, format?: string): string {
  const disposition = headers.get('Content-Disposition') || '';
  const extended = /(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition);
  let filename: string | undefined;
  const encoded = /^UTF-8'[^']*'(.*)$/i.exec((extended?.[1] ?? extended?.[2] ?? '').trim());
  if (encoded) {
    try { filename = decodeURIComponent(encoded[1]); } catch { /* Fall back to filename. */ }
  }
  if (!filename) {
    const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i.exec(disposition);
    filename = (plain?.[1]?.replace(/\\(.)/g, '$1') ?? plain?.[2])?.trim();
  }
  // A response filename is a basename, never a path. Keep localized names.
  const safe = (filename || fallback || 'report').split(/[\\/]/).pop()!
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+|[. ]+$/g, '') || 'report';
  const mime = (headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const extension = extensions[mime];
  if (extension) {
    return `${safe.replace(/\.(pdf|html?|json|md|markdown|csv|txt|bin)$/i, '')}.${extension}`;
  }
  // Opaque/legacy responses can still supply a filename or stored format.
  if (filename) return safe;
  const fallbackExtension = format && /^(pdf|html|json|md|csv)$/.test(format) ? format : 'bin';
  return `${safe.replace(/\.(pdf|html?|json|md|markdown|csv|txt|bin)$/i, '')}.${fallbackExtension}`;
}
