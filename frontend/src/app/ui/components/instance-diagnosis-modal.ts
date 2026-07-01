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
  @property({ type: Object }) executionTrace: any = null;
  @property({ type: String }) instanceName: string | null = null;

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
    .btn-ghost {
      display: inline-flex; align-items: center; gap: var(--space-sm);
      padding: var(--space-sm) var(--space-lg);
      background: transparent; color: var(--accent);
      border: 1px solid var(--accent); border-radius: var(--radius-sm);
      font-size: var(--text-md); font-weight: 500;
      cursor: pointer; transition: all 0.15s ease;
    }
    .btn-ghost:hover { background: var(--accent-subtle); }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      display: inline-block;
      width: 18px; height: 18px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    .trace-list { text-align: left; max-width: 500px; margin: var(--space-lg) auto; }
    .trace-item { display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-xs) 0; font-size: 13px; color: var(--text); }
    .trace-item.ok { color: var(--success); }
    .trace-item.error { color: var(--danger); }
    .trace-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .trace-dot.pending { background: var(--muted); }
    .trace-dot.running { background: var(--accent); animation: pulse 1s infinite; }
    .trace-dot.ok { background: var(--success); }
    .trace-dot.error { background: var(--danger); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .continue-section { text-align: center; padding: var(--space-lg) 0 var(--space-md); border-top: 1px solid var(--border); margin-top: var(--space-lg); }
    .continue-section p { font-size: 13px; color: var(--muted); margin-bottom: var(--space-md); }
  `;

  private _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  private _requestDiagnosis() {
    this.dispatchEvent(new CustomEvent("request-diagnosis", {
      detail: { instanceId: this.instanceId },
      bubbles: true, composed: true,
    }));
  }

  private _continueInChat() {
    this.dispatchEvent(new CustomEvent("continue-in-chat", {
      detail: {
        instanceId: this.instanceId,
        instanceName: this.instanceName,
        analysisId: this.diagnosis?.id || this.diagnosisRecord?.id,
        diagnosisSummary: typeof this.diagnosis === 'string' ? this.diagnosis : (this.diagnosis?.result || ''),
      },
      bubbles: true, composed: true,
    }));
  }

  override render() {
    return html`
      <app-dialog .open=${this.open} size="xl" title="AI 诊断" @app-dialog-close=${this._close}>
        ${this._renderBody()}
        ${this._renderFooter()}
      </app-dialog>
    `;
  }

  private _renderBody() {
    if (this.loading) {
      const trace = this.executionTrace;
      const events = trace?.tool_events || [];
      return html`
        <div class="empty-state">
          <div class="spinner" style="margin:0 auto var(--space-lg);"></div>
          <div class="empty-title">AI 诊断${this.diagnosisRecord ? '执行中' : '分析中...'}</div>
          <div class="empty-desc">${this.diagnosisRecord ? '诊断任务正在后台执行' : 'Agent 正在采集数据并分析实例运行状态'}</div>
          ${events.length > 0 ? html`
            <div class="trace-list">
              ${events.map((e: any) => html`
                <div class="trace-item ${e.status}">
                  <span class="trace-dot ${e.status === 'ok' ? 'ok' : e.status === 'error' ? 'error' : 'running'}"></span>
                  <span>${e.status === 'ok' ? '✅' : e.status === 'error' ? '❌' : '🔄'}</span>
                  <span><strong>${e.name}</strong></span>
                  <span style="color:var(--muted);font-size:12px;">${e.detail || ''}</span>
                </div>
              `)}
            </div>
          ` : html`
            <div class="trace-list">
              <div class="trace-item">
                <span class="trace-dot running"></span>
                <span>等待 Agent 开始工作...</span>
              </div>
            </div>
          `}
        </div>
      `;
    }

    if (this.error) {
      return html`
        <div class="empty-state">
          <div class="empty-title" style="color:var(--danger);">诊断失败</div>
          <div class="empty-desc">${this.error}</div>
        </div>
      `;
    }

    if (this.diagnosis) {
      const hasResult = typeof this.diagnosis === 'string'
        ? !!this.diagnosis
        : !!(this.diagnosis?.result || this.diagnosis?.result === 0);
      return html`
        <ai-analysis-result
          .result=${typeof this.diagnosis === 'string' ? this.diagnosis : (this.diagnosis?.result || null)}
          analysisType="fault_diagnosis"
          triggerType="manual"
          status="completed"
          .errorMessage=${null}
          title="AI 诊断结果"
        ></ai-analysis-result>
        ${hasResult ? html`
          <div class="continue-section">
            <p>对诊断结果有疑问？可以到 Chat 中进一步分析</p>
            <button class="btn-ghost" @click=${this._continueInChat}>
              在 Chat 中继续分析 →
            </button>
          </div>
        ` : ''}
      `;
    }

    return html`
      <div class="empty-state">
        <div style="font-size:48px;margin-bottom:var(--space-lg);color:var(--muted);">${icons['zap']}</div>
        <div class="empty-title">开始诊断</div>
        <div class="empty-desc">点击下方按钮对实例进行 AI 智能诊断</div>
        <button class="btn-primary" @click=${this._requestDiagnosis}>运行诊断</button>
      </div>
    `;
  }

  private _renderFooter() {
    if (!this.loading) {
      return html`
        <div slot="footer">
          <button class="btn-primary" style="background:transparent;color:var(--muted);border:1px solid var(--border);" @click=${this._close}>关闭</button>
        </div>
      `;
    }
    return nothing;
  }
}

if (!customElements.get("instance-diagnosis-modal")) {
  customElements.define("instance-diagnosis-modal", InstanceDiagnosisModal);
}
