import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { metricError, readTemplateBinding, type TemplateBindingStatus } from './metric-api.js';
import './legacy-metric-configuration.js';
import './native-template-configuration.js';

/**
 * The resource's configuration entry. The stored binding source decides which
 * editor owns the resource: a legacy single-package row keeps its existing
 * editor, a `templates-v1` (or still unbound) resource gets the fixed-version
 * template flow. A failed read is an error, never an assumed "unbound".
 */
@customElement('metric-configuration')
export class MetricConfiguration extends LitElement {
  @property() resourceType = 'instance';
  @property({ type: Number }) resourceId = 0;
  @property({ type: Boolean }) connectionPending = false;
  @state() private mode: 'loading' | 'legacy' | 'native' | 'error' = 'loading';
  @state() private error = '';
  private generation = 0;

  override willUpdate(changes: Map<string, unknown>) {
    if (changes.has('resourceId') || changes.has('resourceType')) void this.load();
  }
  override disconnectedCallback() { this.generation++; super.disconnectedCallback(); }
  private async load() {
    const generation = ++this.generation;
    this.error = '';
    if (!Number.isSafeInteger(this.resourceId) || this.resourceId <= 0) { this.mode = 'loading'; return; }
    this.mode = 'loading';
    try {
      const status: TemplateBindingStatus = await readTemplateBinding(this.resourceType, this.resourceId);
      if (generation !== this.generation) return;
      // `package` is a legacy single-package row; `template` and `unbound` use
      // the fixed-version flow. No source is ever inferred from a failed read.
      this.mode = status.source === 'package' ? 'legacy' : 'native';
    } catch (error) {
      if (generation !== this.generation) return;
      this.mode = 'error';
      this.error = metricError(error);
    }
  }
  confirmDiscard(action: () => void) {
    const child = this.renderRoot.querySelector('legacy-metric-configuration, native-template-configuration') as
      (HTMLElement & { confirmDiscard?: (action: () => void) => void }) | null;
    if (child?.confirmDiscard) child.confirmDiscard(action); else action();
  }
  render() {
    return html`<style>:host{display:block;min-width:0}.notice{overflow-wrap:anywhere}.error{color:var(--danger)}</style>
    ${this.mode === 'loading' ? html`<p class="notice" role="status">正在读取采集配置来源…</p>` : nothing}
    ${this.mode === 'error' ? html`<p class="notice error" role="alert">${this.error || '无法读取采集配置，请重新打开资源后重试。'}</p>` : nothing}
    ${this.mode === 'legacy' ? html`<legacy-metric-configuration .resourceType=${this.resourceType}
      .resourceId=${this.resourceId} .connectionPending=${this.connectionPending}></legacy-metric-configuration>` : nothing}
    ${this.mode === 'native' ? html`<native-template-configuration .resourceType=${this.resourceType}
      .resourceId=${this.resourceId} .connectionPending=${this.connectionPending}></native-template-configuration>` : nothing}`;
  }
}
