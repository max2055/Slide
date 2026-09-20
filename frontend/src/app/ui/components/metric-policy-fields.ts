import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import './app-form-field.js';
export type Toggle = 'inherit' | 'enable' | 'disable';
export type NumberOverride = { mode: 'inherit' } | { mode: 'set'; value: number };
export const numericFields = { interval_ms: '采集间隔（秒）', timeout_ms: '超时（秒）', stale_after_ms: '过期时间（秒）',
  max_counter_gap_ms: '累计计数最大间隔（秒）', max_rows: '行数上限', max_concurrency: '并发上限', max_series_per_resource: '序列上限' };
export type NumberKey = keyof typeof numericFields;
export type Overrides = { enabled?: Toggle; metrics?: Record<string, Toggle> } & Partial<Record<NumberKey, NumberOverride>>;
const limits: Record<NumberKey, [number, number, number]> = { interval_ms: [1000, 86400000, 60000], timeout_ms: [250, 30000, 5000],
  stale_after_ms: [1, 86400000, 120000], max_counter_gap_ms: [1, 86400000, 300000], max_rows: [1, 100, 100], max_concurrency: [1, 16, 1], max_series_per_resource: [1, 10000, 100] };

@customElement('metric-policy-fields')
export class MetricPolicyFields extends LitElement {
  @property({ attribute: false }) overrides: Overrides = {};
  @property({ attribute: false }) values: Record<string, number | boolean> = {};
  @property({ attribute: false }) sources: Record<string, { layer: string; id: string }> = {};
  @property({ type: Boolean }) disabled = true;
  static componentStyles = css`
    :host { display:block; min-width:0; } .fields { display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));gap:var(--space-md); }
    input,select { box-sizing:border-box;width:100%;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-sm); }
  `;
  private change(patch: Partial<Overrides>) { this.dispatchEvent(new CustomEvent('policy-change', { detail: { ...this.overrides, ...patch }, bubbles: true, composed: true })); }
  render() { return html`<style>${MetricPolicyFields.componentStyles.cssText}</style><div class="fields">
    <app-form-field label="采集开关"><select aria-label="采集开关" .value=${this.overrides.enabled ?? 'inherit'} .disabled=${this.disabled} @change=${(e: Event) => this.change({ enabled: (e.target as HTMLSelectElement).value as Toggle })}>
      <option value="inherit">继承</option><option value="enable">启用</option><option value="disable">停用</option></select></app-form-field>
    ${this.renderFields(true)}</div><details><summary>高级参数</summary><div class="fields">${this.renderFields(false)}</div></details>`; }
  private renderFields(basic: boolean) { return Object.entries(numericFields).filter(([key]) => (key === 'interval_ms') === basic).map(([name, label]) => { const key = name as NumberKey, override = this.overrides[key], [min, max, fallback] = limits[key], source = this.sources[key], divisor = key.endsWith('_ms') ? 1000 : 1;
      return html`<app-form-field label=${label} hint=${source ? `生效值 ${Number(this.values[key]) / divisor} · ${{ platform: '平台默认', package: '采集包推荐', group: '继承策略组', resource: '本资源覆盖' }[source.layer] ?? '继承'} ` : `${min / divisor}–${max / divisor}`}>
        <select aria-label=${`${label}覆盖方式`} .value=${override?.mode ?? 'inherit'} .disabled=${this.disabled} @change=${(e: Event) => this.change({ [key]: (e.target as HTMLSelectElement).value === 'inherit' ? { mode: 'inherit' } : { mode: 'set', value: Number(this.values[key] ?? fallback) } })}>
          <option value="inherit">继承</option><option value="set">覆盖</option></select>
        ${override?.mode === 'set' ? html`<input type="number" min=${min / divisor} max=${max / divisor} step=${1 / divisor} aria-label=${label} .value=${String(override.value / divisor)} .disabled=${this.disabled} @input=${(e: Event) => this.change({ [key]: { mode: 'set', value: Math.round(Number((e.target as HTMLInputElement).value) * divisor) } })}>` : nothing}
      </app-form-field>`;
    }); }
}
