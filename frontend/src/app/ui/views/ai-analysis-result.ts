import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { Marked } from "marked";

const marked = new Marked();

/**
 * Sanitize HTML output to prevent XSS from untrusted Agent-generated Markdown.
 * Strips <script>, <iframe>, and on* event handlers.
 */
function sanitize(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

/**
 * Render analysis result that may be a Markdown string or structured JSON object.
 */
function renderResult(result: any): string {
  if (!result) return "";

  if (typeof result === "string") {
    const rawHtml = marked.parse(result, { async: false }) as string;
    return sanitize(rawHtml);
  }

  // JSON backward-compat renderer
  let html = "";
  if (result.summary) {
    html += `<div style="margin-bottom:16px;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);border:1px solid var(--border);">
      <strong style="color:var(--text-strong);">摘要</strong>
      <p style="margin:8px 0 0;font-size:14px;color:var(--text);line-height:1.6;">${result.summary}</p>
    </div>`;
  }
  for (const [key, value] of Object.entries(result)) {
    if (key === "summary") continue;
    if (Array.isArray(value)) {
      html += `<div style="margin-bottom:12px;"><strong style="color:var(--text-strong);font-size:13px;">${key}</strong>
        <ul style="margin:6px 0 0 20px;font-size:13px;color:var(--text);line-height:1.8;">
          ${value.map((item: any) => {
            if (typeof item === "string") return `<li>${item}</li>`;
            if (typeof item === "object" && item !== null) {
              const entries = Object.entries(item).map(([k, v]) => `${k}: ${v}`).join("; ");
              return `<li>${entries}</li>`;
            }
            return `<li>${String(item)}</li>`;
          }).join("")}
        </ul></div>`;
    } else if (typeof value === "object" && value !== null) {
      html += `<div style="margin-bottom:12px;"><strong style="color:var(--text-strong);font-size:13px;">${key}</strong>
        <pre style="margin:6px 0 0;padding:10px;background:var(--bg-elevated);border-radius:var(--radius-sm);font-size:12px;color:var(--text);white-space:pre-wrap;overflow-x:auto;">${JSON.stringify(value, null, 2)}</pre></div>`;
    } else {
      // Null-safe numeric formatting (Research Pitfall 5)
      const displayVal = value != null ? String(value) : "0";
      html += `<div style="margin-bottom:8px;font-size:13px;"><strong style="color:var(--text-strong);">${key}:</strong> <span style="color:var(--text);">${displayVal}</span></div>`;
    }
  }
  return html;
}

@customElement("ai-analysis-result")
export class AIAnalysisResult extends LitElement {
  @property({ type: String }) result: string | null = null;
  @property({ type: String }) analysisType: string = "alert_rca";
  @property({ type: String }) triggerType: string = "manual";
  @property({ type: Boolean }) loading: boolean = false;
  @property({ type: String }) status: string = "completed";
  @property({ type: String }) errorMessage: string | null = null;
  @property({ type: String }) title: string = "AI 分析结果";

  static styles = [sharedBtnStyles, css`
    :host {
      display: block;
    }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-elevated);
    }

    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-strong);
    }

    .card-body {
      padding: 16px;
    }

    .loading-state {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 24px;
      color: var(--muted);
      font-size: 14px;
    }

    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .error-state {
      padding: 16px;
      background: var(--danger-subtle);
      border: 1px solid var(--destructive);
      border-radius: var(--radius-md);
      color: var(--destructive);
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .result-content {
      font-size: 14px;
      line-height: 1.6;
      color: var(--text);
    }

    .result-content h2 {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-strong);
      margin: 16px 0 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border);
    }

    .result-content h3 {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-strong);
      margin: 12px 0 6px;
    }

    .result-content ul,
    .result-content ol {
      margin: 6px 0;
      padding-left: 20px;
      color: var(--text);
      line-height: 1.8;
    }

    .result-content code {
      font-family: var(--mono);
      font-size: 12px;
      background: var(--bg-elevated);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
    }

    .result-content pre {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 12px;
      overflow-x: auto;
      margin: 8px 0;
    }

    .result-content pre code {
      background: none;
      padding: 0;
      border-radius: 0;
    }

    .result-content table {
      border-collapse: collapse;
      width: 100%;
      margin: 8px 0;
      font-size: 13px;
    }

    .result-content th,
    .result-content td {
      border: 1px solid var(--border);
      padding: 8px;
      text-align: left;
      color: var(--text);
    }

    .result-content th {
      background: var(--bg-elevated);
      font-weight: 600;
      color: var(--text-strong);
    }

    .result-content blockquote {
      margin: 8px 0;
      padding: 8px 12px;
      border-left: 3px solid var(--accent);
      background: rgba(210, 190, 252, 0.06);
      color: var(--text);
      font-style: italic;
    }

    .source-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      line-height: 1.25;
    }

    .source-tag.auto {
      background: rgba(210, 190, 252, 0.15);
      color: #d2befc;
    }

    .source-tag.manual {
      background: rgba(59, 130, 246, 0.12);
      color: #3b82f6;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
  `];

  override render() {
    if (this.loading) {
      return html`
        <div class="card">
          <div class="card-body">
            <div class="loading-state">
              <div class="spinner"></div>
              <span>AI 分析中，请稍候...</span>
            </div>
          </div>
        </div>
      `;
    }

    if (this.status === "running") {
      return html`
        <div class="card">
          <div class="card-body">
            <div class="loading-state">
              <div class="spinner"></div>
              <span>分析中...</span>
            </div>
          </div>
        </div>
      `;
    }

    if (this.status === "failed") {
      return html`
        <div class="card">
          <div class="card-header">
            <span class="card-title">AI 分析失败</span>
          </div>
          <div class="card-body">
            <div class="error-state">
              <span>!</span>
              <span>${this.errorMessage || "Unknown error"}</span>
            </div>
          </div>
        </div>
      `;
    }

    // completed + null result
    if (this.status === "completed" && this.result === null) {
      return html`
        <div class="card">
          <div class="card-header">
            <span class="card-title">${this.title}</span>
            <div class="header-right">
              <span class="source-tag ${this.triggerType}">
                ${this.triggerType === "auto" ? "自动分析" : "手动分析"}
              </span>
            </div>
          </div>
          <div class="card-body">
            <p style="color:var(--muted);font-size:14px;">分析完成，但暂无结果数据</p>
          </div>
        </div>
      `;
    }

    // completed + result string or object
    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">${this.title}</span>
          <div class="header-right">
            <span class="source-tag ${this.triggerType}">
              ${this.triggerType === "auto" ? "自动分析" : "手动分析"}
            </span>
          </div>
        </div>
        <div class="card-body">
          <div class="result-content">
            ${this.result
              ? html`<div>${unsafeHTML(renderResult(this.result))}</div>`
              : html`<p style="color:var(--muted);">分析完成，但暂无结果数据</p>`}
          </div>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("ai-analysis-result")) {
  customElements.define("ai-analysis-result", AIAnalysisResult);
}
