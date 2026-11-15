import fs from 'node:fs';
import ts from 'typescript';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { reportExporter } from './report-exporter.js';
import { reportAttachmentDisposition } from './report-download.js';
import type { Report } from './report-database-service.js';

// Execute the production download handler without starting unrelated collectors/DB.
// Authentication and persistence are isolated; exporter and HTTP serialization are real.
const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const start = source.indexOf("  fastify.get('/api/reports/:id/download'");
const end = source.indexOf('\n  // 删除报表', start);
if (start < 0 || end < start) throw new Error('Production report download route not found');
const route = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2023 },
}).outputText;
const report: Report = {
  id: 619, name: '中文报表测试 health-01', type: 'health', format: 'pdf', instance_id: 8,
  content: '<p>中文健康报告 &amp;lt;tag&amp;gt; &lt;tag&gt; CPU 80%</p>',
  data: null, generated_by: 1, status: 'completed', created_at: '2026-11-16 02:00:00',
};

describe('normal PDF/Markdown download entry (#547/#548)', () => {
  it.each(['pdf', 'md', undefined] as const)('downloads %s with matching bytes and headers', async format => {
    const app = Fastify();
    new Function('fastify', 'verifyToken', 'requirePermission', 'hasInstanceAccess', 'reportDatabaseService', 'reportExporter', 'reportAttachmentDisposition', route)(
      app, async () => {}, () => async () => {}, () => true,
      { getReportById: async () => report }, reportExporter, reportAttachmentDisposition,
    );
    try {
      const response = await app.inject({ method: 'GET', url: `/api/reports/619/download${format ? `?format=${format}` : ''}` });
      const actualFormat = format || report.format;
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain(reportExporter.getFormatMimeType(actualFormat));
      expect(response.headers['content-disposition']).toContain(`attachment; filename="report-619.${actualFormat}";`);
      if (actualFormat === 'pdf') {
        expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
        expect(response.rawPayload.toString('binary')).toContain('NotoSansCJKsc-Regular');
      } else {
        expect(response.body).toBe(await reportExporter.export(report, 'md'));
        expect(response.body).toContain('中文健康报告 &amp;lt;tag&amp;gt; &lt;tag&gt; CPU 80%');
      }
    } finally { await app.close(); }
  });
  it('escapes a persisted name and preserves URLs at the download boundary (R1/R2)', async () => {
    const persisted = { ...report, name: '<svg onload="window.__pwn=1"></svg>',
      content: '<p>https://example.invalid/x &amp;lt;tag&amp;gt; &lt;img src=x&gt;</p>' };
    const app = Fastify();
    new Function('fastify', 'verifyToken', 'requirePermission', 'hasInstanceAccess', 'reportDatabaseService', 'reportExporter', 'reportAttachmentDisposition', route)(
      app, async () => {}, () => async () => {}, () => true,
      { getReportById: async () => persisted }, reportExporter, reportAttachmentDisposition,
    );
    try {
      const response = await app.inject({ method: 'GET', url: '/api/reports/619/download?format=md' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/markdown');
      expect(response.headers['content-disposition']).toContain('attachment;');
      expect(response.body).toBe(await reportExporter.exportToMarkdown(persisted));
      expect(response.body).toContain('# &lt;svg onload="window\\.\\_\\_pwn=1"&gt;&lt;/svg&gt;');
      expect(response.body).toContain('](<https://example.invalid/x>)');
      expect(response.body).toContain('&amp;lt;tag&amp;gt; &lt;img src=x&gt;');
    } finally { await app.close(); }
  });

});
