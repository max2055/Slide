import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
/**
 * Scoring Settings — instance health score dimension weights
 */
import { LitElement, html, css, nothing } from "lit";
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";
import "../components/app-card.js";

interface ScoringWeights { availability: number; performance: number; capacity: number; security: number; }

const DIMS: { key: keyof ScoringWeights; label: string; desc: string }[] = [
  { key: "availability", label: "可用性", desc: "实例在线时长与连接成功率" },
  { key: "performance", label: "性能", desc: "查询延迟、吞吐量与资源利用率" },
  { key: "capacity", label: "容量", desc: "磁盘使用率与连接数占比" },
  { key: "security", label: "安全性", desc: "安全配置与合规检查" },
];

function isWeights(value: unknown): value is ScoringWeights {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && DIMS.every(({ key }) => {
      const weight = (value as ScoringWeights)[key];
      return typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 && weight <= 1;
    });
}

// Retain stored fractional weights; remove only floating point display noise.
const percent = (ratio: number) => `${Number((ratio * 100).toFixed(10))}%`;

@customElement("scoring-settings-page")
export class ScoringSettingsPage extends LitElement {
  @state() private weights: ScoringWeights | null = null;
  @state() private loading = true;
  @state() private saving = false;
  @state() private error: string | null = null;
  @state() private ok: string | null = null;
  static styles = [sharedFieldStyles, sharedBtnStyles, css`

    :host { display: block; max-width: 800px; }
    .page-header { margin-bottom: 24px; }
    .page-header h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; color: var(--text-strong); }
    .page-header p { font-size: 13px; color: var(--muted); margin: 0; }

    .dim-row { display: flex; align-items: center; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--border); }
    .dim-row:last-of-type { border-bottom: none; }
    .dim-info { width: 110px; flex-shrink: 0; }
    .dim-label { font-size: 14px; font-weight: 500; color: var(--text-strong); display: block; }
    .dim-desc { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .dim-slider { flex: 1; }
    .dim-slider input[type="range"] { width: 100%; accent-color: var(--accent); }
    .dim-value { min-width: 48px; text-align: right; font-size: 16px; font-weight: 700; color: var(--accent-text); flex-shrink: 0; }

    .total-bar { display: flex; align-items: center; justify-content: space-between; padding: 14px 0 0; margin-top: 8px; border-top: 1px solid var(--border); }
    .total-label { font-size: 13px; font-weight: 600; color: var(--text); }
    .total-value { font-size: 18px; font-weight: 700; }
    .total-value.ok { color: var(--ok); }
    .total-value.warn { color: var(--warn); }
    .total-value.err { color: var(--danger); }
    .total-feedback { font-size: 12px; color: var(--danger); margin: 0; }
    .total-feedback:not(:empty) { margin-top: var(--space-sm); }

    .toast { font-size: 12px; padding: 10px 14px; border-radius: var(--radius-sm); margin-bottom: 12px; }
    .toast-ok { background: var(--ok-subtle); color: var(--ok); }
    .toast-err { background: var(--danger-subtle); color: var(--danger); }

    .loading { padding: 48px; text-align: center; color: var(--muted); }
  `];

  override connectedCallback() { super.connectedCallback(); this._load(); }

  private async _load() {
    this.loading = true; this.error = null; this.weights = null; this.ok = null;
    try {
      const res = await authFetch("/api/scoring/config");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `加载失败 (${res.status})`);
      const value: unknown = await res.json();
      if (value == null) throw new Error('无法加载配置');
      if (!isWeights(value)) throw new Error('评分权重配置不完整或无效，请刷新后重试');
      this.weights = Object.fromEntries(DIMS.map(({ key }) => [key, value[key]])) as unknown as ScoringWeights;
    } catch (e: any) { this.error = e.message; }
    finally { this.loading = false; }
  }

  private async _save() {
    if (this.saving || !this._valid()) return;
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
  _valid() { return isWeights(this.weights) && Math.abs(this._total() - 1) < Number.EPSILON * 8; }

  override render() {
    if (this.loading) return html`<div class="loading" role="status">加载中...</div>`;
    if (this.error && !this.weights) return html`<div class="loading" role="alert" style="color:var(--danger)">${this.error}</div>`;
    if (!this.weights) return html`<div class="loading" style="color:var(--danger)">无法加载配置</div>`;

    const total = this._total();
    const valid = this._valid();
    const feedback = valid ? '' : total < 1
      ? `权重总和不足 100%，请增加 ${percent(1 - total)}`
      : `权重总和超过 100%，请减少 ${percent(total - 1)}`;
    return html`
      ${this.ok ? html`<div class="toast toast-ok" role="status">${this.ok}</div>` : ""}
      ${this.error ? html`<div class="toast toast-err" role="alert">${this.error}</div>` : ""}

      <div class="page-header">
        <h1>评分权重</h1>
        <p>调整各维度在实例健康评分中的占比，总和需为 100%</p>
      </div>

      <app-card variant="default">
        ${DIMS.map(d => html`
          <div class="dim-row">
            <div class="dim-info"><label class="dim-label" for=${`scoring-${d.key}`}>${d.label}</label><span class="dim-desc" id=${`scoring-${d.key}-description`}>${d.desc}</span></div>
            <div class="dim-slider"><input id=${`scoring-${d.key}`} aria-describedby=${`scoring-${d.key}-description${valid ? '' : ' scoring-total-feedback'}`} aria-invalid=${valid ? nothing : 'true'} aria-valuetext=${percent(this.weights![d.key])} ?disabled=${this.saving} type="range" min="0" max="1" step="0.05" .value=${String(this.weights![d.key])} @input=${(e: Event) => { if (this.weights) { this.weights = { ...this.weights, [d.key]: Math.min(1, Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0)) }; this.ok = null; } }}></div>
            <div class="dim-value">${percent(this.weights![d.key])}</div>
          </div>
        `)}
        <div class="total-bar">
          <span class="total-label">权重总和</span>
          <span class="total-value ${valid ? 'ok' : Math.abs(total - 1) < 0.06 ? 'warn' : 'err'}">${percent(total)}${valid ? ' ✓' : ''}</span>
        </div>
        <p id="scoring-total-feedback" class="total-feedback" role="status">${feedback}</p>
        <div slot="footer">
          <button class="btn btn-primary" aria-describedby=${valid ? nothing : 'scoring-total-feedback'} @click=${this._save} ?disabled=${this.saving || !valid}>${this.saving ? '保存中...' : '保存配置'}</button>
        </div>
      </app-card>
    `;
  }
}
declare global { interface HTMLElementTagNameMap { "scoring-settings-page": ScoringSettingsPage; } }
