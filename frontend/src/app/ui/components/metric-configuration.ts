import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { metricError, readTemplateBinding, type TemplateBindingStatus } from './metric-api.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import './legacy-metric-configuration.js';
import './native-template-configuration.js';

/**
 * The resource's configuration entry. The stored binding source decides which
 * editor owns the resource by default: a legacy single-package row keeps its
 * existing editor, a `templates-v1` (or still unbound) resource gets the
 * fixed-version template flow. A legacy resource may enter the native flow
 * explicitly — that is the only way an existing package row is converted, and
 * the conversion happens through the same apply transaction, never here.
 * A failed read is an error, never an assumed "unbound".
 */
@customElement('metric-configuration')
export class MetricConfiguration extends LitElement {
  @property() resourceType = 'instance';
  @property({ type: Number }) resourceId = 0;
  @property({ type: Boolean }) connectionPending = false;
  @state() private mode: 'loading' | 'legacy' | 'native' | 'error' = 'loading';
  @state() private source: TemplateBindingStatus['source'] | null = null;
  @state() private error = '';
  private generation = 0;

  override willUpdate(changes: Map<string, unknown>) {
    if (changes.has('resourceId') || changes.has('resourceType')) void this.load();
  }
  override disconnectedCallback() { this.generation++; super.disconnectedCallback(); }
  private async load() {
    const generation = ++this.generation;
    this.error = '';
    this.source = null;
    if (!Number.isSafeInteger(this.resourceId) || this.resourceId <= 0) { this.mode = 'loading'; return; }
    this.mode = 'loading';
    try {
      const status: TemplateBindingStatus = await readTemplateBinding(this.resourceType, this.resourceId);
      if (generation !== this.generation) return;
      this.source = status.source;
      // `package` is a legacy single-package row; `template` and `unbound` use
      // the fixed-version flow. No source is ever inferred from a failed read.
      this.mode = status.source === 'package' ? 'legacy' : 'native';
    } catch (error) {
      if (generation !== this.generation) return;
      this.mode = 'error';
      this.error = metricError(error);
    }
  }
  /** An explicit, user-initiated switch. It never happens from a read alone. */
  private chooseNative() { this.mode = 'native'; }
  private chooseLegacy() { this.mode = 'legacy'; }
  confirmDiscard(action: () => void) {
    const child = this.renderRoot.querySelector('legacy-metric-configuration, native-template-configuration') as
      (HTMLElement & { confirmDiscard?: (action: () => void) => void }) | null;
    if (child?.confirmDiscard) child.confirmDiscard(action); else action();
  }
  static componentStyles = [sharedBtnStyles];
  render() {
    return html`<style>${MetricConfiguration.componentStyles.map(style => style.cssText).join('')}
      :host{display:block;min-width:0}.notice{overflow-wrap:anywhere}.error{color:var(--danger)}
      .switch{display:flex;flex-wrap:wrap;gap:var(--space-sm);align-items:center;margin-block:var(--space-sm)}
      .switch p{margin:0;color:var(--muted)}</style>
    ${this.mode === 'loading' ? html`<p class="notice" role="status">正在读取采集配置来源…</p>` : nothing}
    ${this.mode === 'error' ? html`<p class="notice error" role="alert">${this.error || '无法读取采集配置，请重新打开资源后重试。'}</p>` : nothing}
    ${this.source === 'package' ? html`<div class="switch">
      ${this.mode === 'legacy'
        ? html`<button class="btn btn-sm" ?disabled=${this.connectionPending} @click=${() => this.chooseNative()}>改用固定版本模板配置</button>
            <p>当前资源使用旧版单包绑定；改用后由原生模板流程重新检查、试采并提交，旧版配置不会自动改写。</p>`
        : html`<button class="btn btn-sm btn-ghost" @click=${() => this.confirmDiscard(() => this.chooseLegacy())}>返回旧版单包配置</button>
            <p>正在以固定版本模板查看此资源；返回不会写入任何变更。</p>`}
    </div>` : nothing}
    ${this.mode === 'legacy' ? html`<legacy-metric-configuration .resourceType=${this.resourceType}
      .resourceId=${this.resourceId} .connectionPending=${this.connectionPending}></legacy-metric-configuration>` : nothing}
    ${this.mode === 'native' ? html`<native-template-configuration .resourceType=${this.resourceType}
      .resourceId=${this.resourceId} .connectionPending=${this.connectionPending}></native-template-configuration>` : nothing}`;
  }
}
