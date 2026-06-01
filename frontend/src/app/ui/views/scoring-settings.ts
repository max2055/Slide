/**
 * Scoring Settings — instance health score dimension weights
 */
import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";

interface ScoringWeights { availability: number; performance: number; capacity: number; security: number; }

const DIMS: { key: keyof ScoringWeights; label: string; desc: string }[] = [
  { key: "availability", label: "可用性", desc: "实例在线时长与连接成功率" },
  { key: "performance", label: "性能", desc: "查询延迟、吞吐量与资源利用率" },
  { key: "capacity", label: "容量", desc: "磁盘使用率与连接数占比" },
  { key: "security", label: "安全性", desc: "安全配置与合规检查" },
];

@customElement("scoring-settings-page")
export class ScoringSettingsPage extends LitElement {
  @state() private weights: ScoringWeights | null = null;
  @state() private loading = true;
  @state() private saving = false;
  @state() private error: string | null = null;
  @state() private ok: string | null = null;
  static styles = [sharedBtnStyles, css`

    :host { display: block; max-width: 640px; }
    .page-header { margin-bottom: 24px; }
    .page-header h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; color: var(--text-strong); }
    .page-header p { font-size: 13px; color: var(--muted); margin: 0; }

    .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    .card-body { padding: 24px; }
    .card-footer { padding: 14px 24px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px; background: var(--bg-accent); }

    .dim-row { display: flex; align-items: center; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--border); }
    .dim-row:last-of-type { border-bottom: none; }
    .dim-info { width: 110px; flex-shrink: 0; }
    .dim-label { font-size: 14px; font-weight: 500; color: var(--text-strong); display: block; }
    .dim-desc { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .dim-slider { flex: 1; }
    .dim-slider input[type="range"] { width: 100%; accent-color: var(--accent); }
    .dim-value { width: 48px; text-align: right; font-size: 16px; font-weight: 700; color: var(--accent); flex-shrink: 0; }

    .total-bar { display: flex; align-items: center; justify-content: space-between; padding: 14px 0 0; margin-top: 8px; border-top: 1px solid var(--border); }
    .total-label { font-size: 13px; font-weight: 600; color: var(--text); }
    .total-value { font-size: 18px; font-weight: 700; }
    .total-value.ok { color: var(--ok); }
    .total-value.warn { color: var(--warn); }
    .total-value.err { color: var(--destructive); }

    .toast { font-size: 12px; padding: 10px 14px; border-radius: var(--radius-sm); margin-bottom: 12px; }
    .toast-ok { background: var(--ok-subtle); color: var(--ok); }
    .toast-err { background: var(--danger-subtle); color: var(--destructive); }

    .loading { padding: 48px; text-align: center; color: var(--muted); }
  `];

  override connectedCallback() { super.connectedCallback(); this._load(); }

  private async _load() {
    this.loading = true; this.error = null;
    try {
      const res = await authFetch("/api/scoring/config");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `加载失败 (${res.status})`);
      this.weights = await res.json();
    } catch (e: any) { this.error = e.message; }
    finally { this.loading = false; }
  }

  private async _save() {
    if (!this.weights) return;
    this.saving = true; this.error = null; this.ok = null;
    try {
      const res = await authFetch("/api/scoring/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.weights) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `保存失败 (${res.status})`);
      this.ok = "权重配置已保存";
      setTimeout(() => this.ok = null, 3000);
    } catch (e: any) { this.error = e.message; }
    finally { this.saving = false; }
  }

  _total() { return this.weights ? this.weights.availability + this.weights.performance + this.weights.capacity + this.weights.security : 0; }
  _valid() { return Math.abs(this._total() - 1) < 0.01; }

  override render() {
    if (this.loading) return html`<div class="loading">加载中...</div>`;
    if (this.error && !this.weights) return html`<div class="loading" style="color:var(--destructive)">${this.error}</div>`;
    if (!this.weights) return html`<div class="loading" style="color:var(--destructive)">无法加载配置</div>`;

    const total = this._total();
    return html`
      ${this.ok ? html`<div class="toast toast-ok">${this.ok}</div>` : ""}
      ${this.error ? html`<div class="toast toast-err">${this.error}</div>` : ""}

      <div class="page-header">
        <h1>评分权重</h1>
        <p>调整各维度在实例健康评分中的占比，总和需为 100%</p>
      </div>

      <div class="card">
        <div class="card-body">
          ${DIMS.map(d => html`
            <div class="dim-row">
              <div class="dim-info"><span class="dim-label">${d.label}</span><span class="dim-desc">${d.desc}</span></div>
              <div class="dim-slider"><input type="range" min="0" max="1" step="0.05" .value=${String(this.weights![d.key])} @input=${(e: Event) => { if (this.weights) this.weights = { ...this.weights, [d.key]: Math.min(1, Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0)) }; }}></div>
              <div class="dim-value">${Math.round(this.weights![d.key] * 100)}%</div>
            </div>
          `)}
          <div class="total-bar">
            <span class="total-label">权重总和</span>
            <span class="total-value ${this._valid() ? 'ok' : Math.abs(total - 1) < 0.06 ? 'warn' : 'err'}">${total.toFixed(2)}${this._valid() ? ' ✓' : ''}</span>
          </div>
        </div>
        <div class="card-footer">
          <button class="btn btn-primary" @click=${this._save} ?disabled=${this.saving || !this._valid()}>${this.saving ? '保存中...' : '保存配置'}</button>
        </div>
      </div>
    `;
  }
}
declare global { interface HTMLElementTagNameMap { "scoring-settings-page": ScoringSettingsPage; } }
