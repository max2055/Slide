import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Report } from './report-database-service.js';

const mocks = vi.hoisted(() => ({
  create: vi.fn(), update: vi.fn(), read: vi.fn(), instance: vi.fn(), slowQueries: vi.fn(),
}));
vi.mock('./report-database-service', () => ({ reportDatabaseService: {
  createReport: mocks.create, updateReportStatus: mocks.update, getReportById: mocks.read,
} }));
vi.mock('./instance-database-service', () => ({ instanceDatabaseService: { getInstanceById: mocks.instance } }));
vi.mock('./metrics-database-service', () => ({ metricsDatabaseService: { getSlowQueries: mocks.slowQueries } }));
vi.mock('./database-service', () => ({ databaseService: {} }));
vi.mock('./metrics/consumers/runtime.js', () => ({
  internalMetricConsumerService: {}, authenticatedMetricConsumerService: {}, operationalSource: vi.fn(),
}));

import { reportService } from './report-service.js';
import { reportExporter } from './report-exporter.js';
import { reportAttachmentDisposition } from './report-download.js';

// Shared adversarial fixture for GitHub #279 (generation) and #362 (export).
const payload = `</title></pre><img src=x onerror="void(0)"><script>void(0)</script>&"'中文`;
const escaped = '&lt;/title&gt;&lt;/pre&gt;&lt;img src=x onerror=&#34;void(0)&#34;&gt;&lt;script&gt;void(0)&lt;/script&gt;&amp;&#34;&#39;中文';
const stored: Report = {
  id: 91, name: payload, type: 'slow_query', format: 'html', instance_id: 7,
  content: null, data: { [payload]: payload }, generated_by: 1,
  status: 'completed', created_at: '2026-11-16',
};

describe('HTML report text boundaries (#279 / #362)', () => {
  beforeEach(() => {
    mocks.create.mockResolvedValue({ ...stored, status: 'pending' });
    mocks.instance.mockResolvedValue({ id: 7, name: payload });
    mocks.slowQueries.mockResolvedValue([{ sql_text: payload, avg_time_ms: 2, execution_count: 3, rows_examined: 4 }]);
    mocks.update.mockImplementation(async (_id, status, content, data) => {
      mocks.read.mockResolvedValue({ ...stored, status, content, data });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it.each([false, true])('generates and exports literal text with missing template=%s', async missing => {
    if (missing) {
      const exists = fs.existsSync.bind(fs);
      vi.spyOn(fs, 'existsSync').mockImplementation(file => String(file).endsWith('/slow-query.ejs') ? false : exists(file));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    }
    const result = await reportService.generateReport('slow_query', 7);
    expect(result.status).toBe('completed');
    const html = result.content!;
    expect(html).toContain('<table>');
    expect(html).not.toMatch(/<(?:img|script)\b/i);
    expect(html).toContain('&lt;img src=x onerror=');
    expect(html).not.toContain('&amp;lt;img');
    expect(html).toContain('&amp;');
    expect(result.data.top_slow_queries[0].sql_text).toBe(payload);
    // Generated content is an HTML document; exporting must not escape its markup again.
    expect(await reportExporter.export(result, 'html')).toBe(html);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(91, 'completed', html, expect.any(Object));
  });

  it('escapes every fallback export text field, including JSON keys and values', async () => {
    const html = String(await reportExporter.export({ ...stored, type: payload as Report['type'], created_at: payload }, 'html'));
    expect(html).toContain(`<title>${escaped}</title>`);
    expect(html).toContain(`<h1>${escaped}</h1>`);
    expect(html).toContain(`类型：${escaped} | 生成时间：${escaped}`);
    expect(html).not.toMatch(/<(?:img|script)\b/i);
    expect(html).not.toContain('</pre><img');
    expect(html).toContain('&lt;/pre&gt;');
    expect(html).toContain('&#34;');
    expect(html).not.toContain('&amp;lt;');
  });

  it.each([false, true])('preserves literal entities and truncates SQL before escaping, missing=%s', async missing => {
    if (missing) {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    }
    mocks.slowQueries.mockResolvedValue([
      { sql_text: 'x'.repeat(79) + '<img src=x>', avg_time_ms: 0, execution_count: 0, rows_examined: 0 },
      { sql_text: '&lt;img&gt; & "中文"', avg_time_ms: 0, execution_count: 0, rows_examined: 0 },
      {},
    ]);
    const result = await reportService.generateReport('slow_query', 7);
    expect(result.content).toContain(`<code>${'x'.repeat(79)}&lt;...</code>`);
    expect(result.content).toContain('&amp;lt;img&amp;gt; &amp;');
    expect(result.content).toContain('<code></code>');
    expect(result.data.top_slow_queries[0].sql_text).toHaveLength(90);
  });

  it('escapes unexpected text in fallback count fields', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.slowQueries.mockResolvedValue([{ execution_count: payload, rows_examined: payload }]);
    const result = await reportService.generateReport('slow_query', 7);
    expect(result.content).toContain(`<td>${escaped}</td>`);
    expect(result.content).not.toMatch(/<(?:img|script)\b/i);
  });

  it('preserves ordinary Chinese text, JSON formatting, and null data', async () => {
    const html = await reportExporter.exportToHTML({ ...stored, name: '中文报表', data: { count: 3 } });
    expect(html).toContain('<h1>中文报表</h1>');
    expect(html).toContain('<pre>{\n  &#34;count&#34;: 3\n}</pre>');
    expect(await reportExporter.exportToHTML({ ...stored, data: null })).toContain('<pre>null</pre>');
  });

  it('keeps the attachment filename boundary for HTML with adversarial names', () => {
    const header = reportAttachmentDisposition(`${payload}\r\nX-Injected: yes`, 'html', 91);
    expect(header).toMatch(/^attachment; /);
    expect(header).toContain('filename="report-91.html"');
    expect(header).not.toMatch(/[\r\n<>]/);
    expect(header).toContain("filename*=UTF-8''");
  });
});
