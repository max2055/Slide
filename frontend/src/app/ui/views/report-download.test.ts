import { describe, expect, it } from 'vitest';
import { reportDownloadFilename } from './report-download.js';

describe('report download response filename', () => {
  it.each([
    ['attachment; filename="fallback.pdf"; filename*=UTF-8\'zh\'%E5%81%A5%E5%BA%B7.html', '健康.html'],
    ['attachment; filename*=UTF-8\'\'%ZZ; filename="fallback.pdf"', 'fallback.html'],
    ['attachment; filename="../report.pdf"', 'report.html'],
    ['attachment; filename="report; final.html"', 'report; final.html'],
    ['attachment; filename=""', '历史.html'],
  ])('uses response filename %s safely with HTML MIME', (disposition, expected) => {
    expect(reportDownloadFilename(new Headers({ 'Content-Disposition': disposition, 'Content-Type': 'TEXT/HTML; charset=utf-8' }), '历史.pdf')).toBe(expected);
  });
  it('uses stored format only for an opaque response without filename', () => {
    expect(reportDownloadFilename(new Headers(), '历史.pdf', 'json')).toBe('历史.json');
    expect(reportDownloadFilename(new Headers(), '历史.pdf', 'invalid')).toBe('历史.bin');
  });
  it('retains supplied names for opaque binary responses', () => {
    expect(reportDownloadFilename(new Headers({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="export.pdf"' }), '历史')).toBe('export.pdf');
  });
});
