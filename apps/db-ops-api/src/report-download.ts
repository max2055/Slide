/** RFC 6266/5987: an ASCII fallback plus a UTF-8 basename for modern clients. */
export function reportAttachmentDisposition(name: string, extension: string, reportId: number): string {
  const ext = /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'bin';
  const basename = Array.from(name.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, '_')
    .replace(/^\.+|[. ]+$/g, '').trim()).slice(0, 120).join('') || '报表';
  const filename = encodeURIComponent(`${basename}.${ext}`).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const id = Number.isSafeInteger(reportId) && reportId > 0 ? reportId : 'export';
  return `attachment; filename="report-${id}.${ext}"; filename*=UTF-8''${filename}`;
}
