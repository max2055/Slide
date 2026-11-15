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

// #547: verify the real PDF writer embeds the bundled font, including concurrent exports.
describe('Chinese PDF reports (#547)', () => {
  it('embeds an extractable CJK font for Chinese and mixed ASCII reports', async () => {
    const sample = { ...report, name: '中文报表测试 health-01', content: '中文健康报告：正常，容量 80%；CPU 12.5%。\n第二段：数据库 MySQL 8.4，延迟 < 10ms。' };
    const results = await Promise.all([reportExporter.export(sample, 'pdf'), reportExporter.export({ ...sample, content: null }, 'pdf')]);
    for (const result of results) {
      expect(Buffer.isBuffer(result)).toBe(true);
      const pdf = result.toString('binary');
      expect(pdf).toContain('/FontFile3');
      expect(pdf).toContain('/ToUnicode');
      expect(pdf).toContain('NotoSansCJKsc-Regular');
      expect(pdf).not.toMatch(/\/BaseFont \/Helvetica/);
    }
  });
});

// #548: assert Markdown source preserves one HTML decode and remains inert HTML.
describe('Markdown text semantics (#548)', () => {
  it.each([
    ['<p>literal: &amp;lt;tag&amp;gt;</p>', 'literal: &amp;lt;tag&amp;gt;'],
    ['<p>literal: &lt;tag&gt;</p>', 'literal: &lt;tag&gt;'],
    ['<p>A &amp; B &quot;双引号&quot; &#39;单引号&#39; &#x4E2D;&#25991; &copy;</p>', 'A &amp; B "双引号" \'单引号\' 中文 ©'],
    ['<p>中文 <b>health</b><br>第二行</p><div>第三行</div>', '中文 health\n第二行\n第三行'],
    ['<p title="a > b">前 &lt;img src=x onerror=alert(1)&gt; 后</p>', '前 &lt;img src=x onerror=alert\\(1\\)&gt; 后'],
    ['<script>alert(1)</script><style>body{}</style><template>隐藏</template><p>正文</p>', '正文'],
    ['<p>&amp;amp; &#38;lt; &#x26;lt; &unknown;</p>', '&amp;amp; &amp;lt; &amp;lt; &amp;unknown;'],
    ['<p>*literal* [link](javascript:evil) `code`</p>', '\\*literal\\* \\[link\\]\\(javascript:evil\\) \\`code\\`'],
    ['普通中文与 SQL: a < 5 && b > 3', '普通中文与 SQL: a &lt; 5 &amp;&amp; b &gt; 3'],
  ])('preserves text from %s', async (content, expected) => {
    const markdown = String(await reportExporter.export({ ...report, data: null, content }, 'md'));
    expect(markdown.split('## 详细内容\n\n')[1]).toBe(expected);
    expect(markdown).not.toMatch(/<\/?(?:script|img|p|div|b)\b/i);
  });
});

// Independent review R1: persisted report names are text, not inline HTML/Markdown.
describe('literal Markdown metadata (MAX-619 R1)', () => {
  it.each([
    '<svg onload="window.__pwn=1"></svg>',
    '<img src="https://example.invalid/title" onerror="window.__attack=619">',
    '普通标题\n# injected\r\n<script>window.__pwn=1</script>',
    '*强调* [链接](javascript:alert(1)) &lt;svg&gt;',
  ])('escapes the report name %s without treating it as HTML input', async name => {
    const md = await reportExporter.exportToMarkdown({ ...report, name, data: null, content: '<p>普通正文</p>' });
    expect(md.split('\n\n')[0]).toMatch(/^# [^\r\n]+$/);
    expect(md).not.toMatch(/<(?:svg|img|script)\b/i);
    expect(md).not.toContain('[链接](javascript:');
    if (name.includes('&lt;')) expect(md).toContain('&amp;lt;svg&amp;gt;');
    if (name.includes('\n')) expect(md).toContain('&#10;');
  });
  it('accepts a database driver Date value in report metadata', async () => {
    const md = await reportExporter.exportToMarkdown({ ...report, created_at: new Date('2026-11-16T00:00:00Z') as any });
    expect(md).toContain('**生成时间**:');
    expect(md).toContain('2026');
  });
  it('applies the same boundary to the other literal metadata', async () => {
    const md = await reportExporter.exportToMarkdown({ ...report, type: '<svg onload=1>' as any, created_at: '<img src=x>', data: null });
    expect(md).toContain('**类型**: &lt;svg onload=1&gt;');
    expect(md).toContain('**生成时间**: &lt;img src=x&gt;');
  });
});

// Independent review R2: explicit link destinations keep Markdown escape syntax
// out of automatic link detection, while the displayed label remains literal.
describe('Markdown URL fidelity (MAX-619 R2)', () => {
  it.each([
    ['https://example.invalid/x', '[https://example\\.invalid/x](<https://example.invalid/x>)'],
    ['https://example.invalid/a_b?q=one&v=2#anchor', '[https://example\\.invalid/a\\_b?q=one&amp;v=2\\#anchor](<https://example.invalid/a_b?q=one&amp;v=2#anchor>)'],
    ['https://example.invalid/a_(b)', '[https://example\\.invalid/a\\_\\(b\\)](<https://example.invalid/a_(b)>)'],
    ['(https://example.invalid/x).', '\\([https://example\\.invalid/x](<https://example.invalid/x>)\\)\\.'],
  ])('preserves the destination for %s', async (url, expected) => {
    const md = await reportExporter.exportToMarkdown({ ...report, data: null, content: `<p>${url.replace(/&/g, '&amp;')}</p>` });
    expect(md.split('## 详细内容\n\n')[1]).toBe(expected);
  });
});
