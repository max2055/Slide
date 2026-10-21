import { describe, expect, it } from 'vitest';
import { reportExporter } from './report-exporter.js';
import type { Report } from './report-database-service.js';

const report: Report = {
  id: 1, name: 'Historical health', type: 'health', format: 'html', instance_id: 8,
  content: '<!DOCTYPE html><html><body>load 10</body></html>',
  data: { load: 10, detail: 'a,"b"\nc' }, generated_by: 1, status: 'completed', created_at: '2026-10-21',
};
describe('report export bytes agree with MIME and extension', () => {
  it('preserves historical HTML', async () => {
    expect(await reportExporter.export(report, 'html')).toBe(report.content);
    expect(reportExporter.getFormatMimeType('html')).toBe('text/html');
    expect(reportExporter.getExtension('html')).toBe('html');
  });
  it('produces a real PDF document', async () => {
    const result = await reportExporter.export(report, 'pdf');
    expect(Buffer.isBuffer(result)).toBe(true);
    if (!Buffer.isBuffer(result)) throw new Error('Expected PDF bytes');
    expect(result.subarray(0, 5).toString()).toBe('%PDF-');
    expect(result.toString()).toContain('%%EOF');
  });
  it('exports JSON and Markdown', async () => {
    expect(JSON.parse(String(await reportExporter.export(report, 'json'))).data).toEqual(report.data);
    expect(await reportExporter.export(report, 'md')).toContain('# Historical health');
  });
  it('exports CSV rather than labeling HTML as CSV, escaping cells', async () => {
    const result = String(await reportExporter.export(report, 'csv'));
    expect(result).not.toContain('<!DOCTYPE html>');
    expect(result).toContain('id,name,type,status,created_at,data\r\n');
    expect(result).toContain('"{""load"":10,');
  });
  it('rejects unknown formats rather than labeling fallback HTML', async () => {
    await expect(reportExporter.export(report, 'unsupported' as any)).rejects.toThrow(/format|格式/i);
  });
  it('protects CSV names from spreadsheet formulas and handles empty data', async () => {
    const result = String(await reportExporter.export({ ...report, name: '=1+1', data: null }, 'csv'));
    expect(result).toContain('"\'=1+1"');
    expect(result).toContain('"null"\r\n');
  });
});
