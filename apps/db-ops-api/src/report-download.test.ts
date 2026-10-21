import { expect, it } from 'vitest';
import { reportAttachmentDisposition } from './report-download.js';

it.each(['html', 'pdf', 'json', 'md', 'csv'])('preserves Chinese filenames and a safe ASCII fallback for %s', ext => {
  const header = reportAttachmentDisposition('数据库健康报告 2026-10-21', ext, 32);
  expect(header).toContain(`filename="report-32.${ext}"`);
  expect(header).toMatch(/^[\x20-\x7e]+$/);
  expect(decodeURIComponent(header.split("UTF-8''")[1])).toBe(`数据库健康报告 2026-10-21.${ext}`);
});
it('encodes delimiters and strips path, control and bidirectional characters', () => {
  const header = reportAttachmentDisposition('../报表\\x\r\n";\u202e\0(1)\'😀', 'pdf', 7);
  const filename = decodeURIComponent(header.split("UTF-8''")[1]);
  expect(filename).not.toMatch(/[\\/\r\n"\u202e\0]/);
  expect(header).toContain('%27'); expect(header).toContain('%28');
  expect(header).not.toContain('\r'); expect(header).not.toContain('\n');
  expect(filename).toContain('报表');
});
it('bounds Unicode names without splitting surrogate pairs and handles empty names', () => {
  expect(() => reportAttachmentDisposition('😀'.repeat(200), 'csv', 1)).not.toThrow();
  expect(reportAttachmentDisposition('...', '../pdf', 0)).toContain('filename="report-export.bin"');
});
