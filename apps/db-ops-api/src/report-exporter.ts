/**
 * 报表导出服务
 */
import PDFDocument from 'pdfkit';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import type { Report, ReportFormat } from './report-database-service';

const reportFont = fileURLToPath(new URL('../assets/fonts/NotoSansCJKsc-Regular.otf', import.meta.url));

// Parse before decoding: encoded angle brackets belong to text, not HTML tags.
function reportMarkdownContent(content: string): string {
  const parts: string[] = [];
  const visit = (node: DefaultTreeAdapterMap['node']) => {
    if (node.nodeName === '#text') {
      parts.push((node as DefaultTreeAdapterMap['textNode']).value);
      return;
    }
    if ('tagName' in node && ['script', 'style', 'template', 'head'].includes(node.tagName)) return;
    if ('childNodes' in node) node.childNodes.forEach(visit);
    if ('tagName' in node && /^(br|div|p|tr|li|h[1-6]|blockquote|pre|th|td)$/.test(node.tagName)) parts.push('\n');
  };
  visit(parseFragment(content));
  return parts.join('')
    // Keep extracted text literal when the Markdown is rendered.
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+\-.!|])/g, '\\$1')
    .replace(/\n{3,}/g, '\n\n').trim();
}

class ReportExporter {
  /**
   * 导出为 PDF
   */
  async exportToPDF(report: Report): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
      });

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // 标题
      doc
        .fontSize(24)
        .font(reportFont)
        .text(report.name, { align: 'center' })
        .moveDown(0.5);

      // 元信息
      doc
        .fontSize(10)
        .font(reportFont)
        .text(`类型：${report.type} | 格式：${report.format}`, { align: 'center' })
        .text(`生成时间：${report.created_at}`, { align: 'center' })
        .moveDown(1);

      // 分隔线
      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
      doc.moveDown(0.5);

      // 内容
      doc
        .fontSize(12)
        .font(reportFont)
        .text(report.content || '无内容', {
          align: 'left',
          width: 500,
        });

      doc.end();
    });
  }

  /**
   * 导出为 Markdown
   */
  async exportToMarkdown(report: Report): Promise<string> {
    const lines: string[] = [];

    // 标题
    lines.push(`# ${report.name}`);
    lines.push('');

    // 元信息
    lines.push(`**类型**: ${report.type}`);
    lines.push(`**格式**: ${report.format}`);
    lines.push(`**生成时间**: ${report.created_at}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // 内容
    if (report.data) {
      lines.push('## 数据摘要');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(report.data, null, 2));
      lines.push('```');
      lines.push('');
    }

    if (report.content) {
      lines.push('## 详细内容');
      lines.push('');
      lines.push(reportMarkdownContent(report.content));
    }

    return lines.join('\n');
  }

  /**
   * 导出为 HTML
   */
  async exportToHTML(report: Report): Promise<string> {
    // content is a complete HTML document persisted by the report generators.
    // Generators must escape untrusted values at interpolation; this is not a sanitizer
    // for arbitrary uploaded HTML. Preserve markup and avoid double-escaping on export.
    if (report.content) {
      return report.content;
    }

    // 如果没有 content，生成简单的 HTML
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${ejs.escapeXML(report.name)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; }
    h1 { color: #333; }
    .meta { color: #666; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
  </style>
</head>
<body>
  <h1>${ejs.escapeXML(report.name)}</h1>
  <p class="meta">类型：${ejs.escapeXML(report.type)} | 生成时间：${ejs.escapeXML(report.created_at)}</p>
  <pre>${ejs.escapeXML(JSON.stringify(report.data, null, 2))}</pre>
</body>
</html>`;
  }

  /**
   * 导出为 JSON
   */
  async exportToJSON(report: Report): Promise<string> {
    return JSON.stringify(
      {
        id: report.id,
        name: report.name,
        type: report.type,
        format: report.format,
        instance_id: report.instance_id,
        data: report.data,
        content: report.content,
        status: report.status,
        created_at: report.created_at,
      },
      null,
      2
    );
  }

  async exportToCSV(report: Report): Promise<string> {
    const cell = (value: unknown) => {
      let text = String(value ?? '');
      // Quoting alone does not prevent spreadsheet formula evaluation.
      if (/^\s*[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    return 'id,name,type,status,created_at,data\r\n' +
      [report.id, report.name, report.type, report.status, report.created_at, JSON.stringify(report.data ?? null)]
        .map(cell).join(',') + '\r\n';
  }

  /**
   * 统一导出方法
   */
  async export(report: Report, format: ReportFormat | 'md'): Promise<string | Buffer> {
    switch (format) {
      case 'pdf':
        return this.exportToPDF(report);
      case 'html':
        return this.exportToHTML(report);
      case 'json':
        return this.exportToJSON(report);
      case 'md':
        return this.exportToMarkdown(report);
      case 'csv':
        return this.exportToCSV(report);
      default:
        throw new Error(`不支持的导出格式：${format}`);
    }
  }

  /**
   * 获取 MIME 类型
   */
  getFormatMimeType(format: string): string {
    const mimeTypes: Record<string, string> = {
      pdf: 'application/pdf',
      html: 'text/html',
      json: 'application/json',
      md: 'text/markdown',
      csv: 'text/csv',
    };
    return mimeTypes[format] || 'text/plain';
  }

  /**
   * 获取文件扩展名
   */
  getExtension(format: string): string {
    const extensions: Record<string, string> = {
      pdf: 'pdf',
      html: 'html',
      json: 'json',
      md: 'md',
      csv: 'csv',
    };
    return extensions[format] || 'txt';
  }
}

// 单例
export const reportExporter = new ReportExporter();
