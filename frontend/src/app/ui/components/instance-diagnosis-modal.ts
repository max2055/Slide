import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { icons } from "../../../icons.js";
import "./app-dialog.js";
import "../views/ai-analysis-result.js";

@customElement("instance-diagnosis-modal")
export class InstanceDiagnosisModal extends LitElement {
  createRenderRoot() { return this; }

  @property({ type: Number }) instanceId: number | null = null;
  @property({ type: Boolean }) open = false;
  @property({ type: Object }) diagnosis: any = null;
  @property({ type: Boolean }) loading = false;
  @property() error: string | null = null;
  @property({ type: Object }) diagnosisRecord: any = null;

  static styles = css`
    .empty-state { text-align: center; padding: 40px; }
    .empty-title { font-size: var(--text-lg); font-weight: 600; color: var(--text-strong); margin-bottom: var(--space-sm); }
    .empty-desc { font-size: var(--text-md); color: var(--muted); margin-bottom: var(--space-lg); }
    .btn-primary {
      display: inline-flex; align-items: center; gap: var(--space-sm);
      padding: var(--space-sm) var(--space-xl);
      background: var(--accent); color: var(--accent-foreground);
      border: none; border-radius: var(--radius-sm);
      font-size: var(--text-md); font-weight: 500;
      cursor: pointer; transition: all 0.15s ease;
    }
    .btn-primary:hover { opacity: 0.9; }
    .btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      display: inline-block;
      width: 18px; height: 18px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
  `;

  private _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  private _requestDiagnosis() {
    this.dispatchEvent(new CustomEvent("request-diagnosis", {
      detail: { instanceId: this.instanceId },
      bubbles: true,
      composed: true,
    }));
  }

  override render() {
    return html`
      <app-dialog .open=${this.open} size="xl" title="AI 诊断" @app-dialog-close=${this._close}>
        ${this.loading ? html`
          <div class="empty-state">
            <div class="spinner" style="margin:0 auto var(--space-lg);"></div>
            <div class="empty-title">AI 诊断分析中...</div>
            <div class="empty-desc">正在分析实例运行状态，请稍候</div>
          </div>
        ` : this.error ? html`
          <div class="empty-state">
            <div class="empty-title" style="color:var(--destructive);">诊断失败</div>
            <div class="empty-desc">${this.error}</div>
          </div>
        ` : this.diagnosis ? html`
          <ai-analysis-result
            .result=${typeof this.diagnosis === 'string' ? this.diagnosis : (this.diagnosis?.result || null)}
            analysisType="fault_diagnosis"
            triggerType="manual"
            status="completed"
            .errorMessage=${null}
            title="AI 诊断结果"
          ></ai-analysis-result>
        ` : html`
          <div class="empty-state">
            <div style="font-size:48px;margin-bottom:var(--space-lg);color:var(--muted);">${icons['zap']}</div>
            <div class="empty-title">开始诊断</div>
            <div class="empty-desc">点击下方按钮对实例进行 AI 智能诊断</div>
            <button class="btn-primary" @click=${this._requestDiagnosis}>
              运行诊断
            </button>
          </div>
        `}
        ${!this.loading ? html`
          <div slot="footer">
            <button class="btn-primary" style="background:transparent;color:var(--muted);border:1px solid var(--border);" @click=${this._close}>关闭</button>
          </div>
        ` : nothing}
      </app-dialog>
    `;
  }
}

if (!customElements.get("instance-diagnosis-modal")) {
  customElements.define("instance-diagnosis-modal", InstanceDiagnosisModal);
}
