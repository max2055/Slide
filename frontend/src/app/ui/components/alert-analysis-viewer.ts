/**
 * AI analysis result modal showing RCA/diagnosis text.
 * Uses <app-dialog size="xl"> with ai-analysis-result for completed results.
 *
 * Properties:
 *   .analysis=${{ alert: Alert, record: { status, trigger_type, result } }|null}
 *   .open=${boolean} .loading=${boolean}
 *
 * Events: close
 */
import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./app-dialog.js";
import "../views/ai-analysis-result.js";

interface Alert {
  id: number;
  instance_id: number;
  instance_name?: string;
  alert_type: string;
  severity: string;
  title: string;
  message: string;
  status: string;
  created_at: string;
}

@customElement("alert-analysis-viewer")
export class AlertAnalysisViewer extends LitElement {
  @property({ type: Object }) analysis: { alert: Alert; record: any } | null = null;
  @property({ type: Boolean }) open = false;
  @property({ type: Boolean }) loading = false;

  private _emit(name: string, detail?: any) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  override render() {
    if (!this.analysis || !this.open) return nothing;
    const { alert, record } = this.analysis;

    return html`
      <app-dialog size="xl" .open=${this.open} title="AI 分析结果" @app-dialog-close=${() => this._emit('close')}>
        <!-- Alert meta -->
        <div style="display:grid;grid-template-columns:60px 1fr;gap:var(--space-sm) var(--space-md);font-size:var(--text-sm);margin-bottom:var(--space-lg);padding:var(--space-md);background:var(--bg-elevated);border-radius:var(--radius-sm);">
          <span style="color:var(--muted);">标题</span><span style="font-weight:500;">${this._cleanTitle(alert.title)}</span>
          <span style="color:var(--muted);">实例</span><span>${alert.instance_name || '—'}</span>
          <span style="color:var(--muted);">时间</span><span>${new Date(alert.created_at).toLocaleString('zh-CN')}</span>
        </div>

        <!-- Result content -->
        <div style="overflow-y:auto;max-height:50vh;">
          ${record.status === 'failed' ? html`
            <div style="padding:var(--space-lg);background:var(--danger-subtle);border-radius:var(--radius-sm);color:var(--danger);text-align:center;">
              <div style="font-size:var(--text-md);font-weight:600;margin-bottom:var(--space-sm);">AI 分析失败</div>
              <div style="font-size:var(--text-sm);">${record.result?.error || '分析过程中出现错误，请稍后重试。'}</div>
            </div>
          ` : record.result ? html`
            <ai-analysis-result
              .result=${record.result}
              analysisType="alert_rca"
              triggerType=${record.trigger_type}
              status="completed"
              title="AI 根因分析"
            ></ai-analysis-result>
          ` : html`
            <div style="text-align:center;padding:40px 20px;color:var(--muted);">
              <div style="font-size:var(--text-md);margin-bottom:var(--space-sm);">暂无分析结果数据</div>
            </div>
          `}
        </div>
      </app-dialog>
    `;
  }

  private _cleanTitle(t: string): string {
    return t.replace(/^\[(CRITICAL|WARNING|INFO|ERROR)\]\s*/i, '');
  }
}

try { customElements.define("alert-analysis-viewer", AlertAnalysisViewer); } catch (e: any) { if (!(e instanceof DOMException)) throw e; }
