import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { metricError, readCollectionStatus, type CollectionStatus } from './metric-api.js';
import { renderCollectionStatus, collectionFactsStyles } from './metric-collection-status.js';
import './app-card.js';
import './app-dialog.js';
import './metric-configuration.js';
import type { MetricConfiguration } from './metric-configuration.js';

@customElement('resource-collection-section')
export class ResourceCollectionSection extends LitElement {
  @property() resourceType = 'instance';
  @property({ type: Number }) resourceId = 0;
  @property({ type: Boolean }) connectionPending = false;
  @state() private status: CollectionStatus | null = null;
  @state() private error = '';
  @state() private loading = false;
  @state() private editing = false;
  private generation = 0;
  private readonly accessChanged = () => {
    this.generation++; this.status = null; this.loading = false; this.editing = false;
    this.error = '权限或登录状态已变更，请重新打开资源后读取采集状态';
  };
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.accessChanged);
    window.addEventListener('slide-session-expired', this.accessChanged);
  }
  openEditor() { if (this.resourceId && !this.connectionPending) this.editing = true; }
  confirmDiscard(action: () => void) {
    const editor = this.renderRoot.querySelector<MetricConfiguration>('metric-configuration');
    if (editor) editor.confirmDiscard(action); else action();
  }
  override willUpdate(changes: Map<string, unknown>) {
    if (changes.has('resourceType') || changes.has('resourceId')) { this.status = null; void this.load(); }
  }
  override disconnectedCallback() {
    this.generation++;
    window.removeEventListener('slide-permissions-loaded', this.accessChanged);
    window.removeEventListener('slide-session-expired', this.accessChanged);
    super.disconnectedCallback();
  }
  private async load() {
    const generation = ++this.generation;
    this.error = ''; this.loading = false;
    if (!this.resourceId) return;
    this.loading = true;
    try {
      const status = await readCollectionStatus(this.resourceType, this.resourceId);
      if (generation === this.generation) this.status = status;
    } catch (e) { if (generation === this.generation) { this.status = null; this.error = metricError(e); } }
    finally { if (generation === this.generation) this.loading = false; }
  }
  private close() {
    const editor = this.renderRoot.querySelector<MetricConfiguration>('metric-configuration');
    const action = () => { this.editing = false; void this.load(); };
    if (editor) editor.confirmDiscard(action); else action();
  }
  render() {
    return html`<style>${sharedBtnStyles}${collectionFactsStyles}
      :host{display:block;min-width:0;} .actions{display:flex;flex-wrap:wrap;gap:var(--space-sm);margin-block:var(--space-md);}
      p{overflow-wrap:anywhere;} .skeleton{min-height:6rem;background:var(--bg-hover);}
    </style><app-card><h2 slot="header">监控与采集</h2>
      ${!this.resourceId ? html`<p>先保存连接信息，再在此配置兼容模板、检查并试采。保存连接不会代替采集发布。</p>`
        : this.loading ? html`<div class="skeleton" role="status" aria-label="正在读取采集状态">正在读取采集状态…</div>`
        : this.error ? html`<p role="alert">${this.error}</p>`
        : this.status ? renderCollectionStatus(this.status) : html`<p>采集状态未知</p>`}
      ${this.connectionPending && this.resourceId ? html`<p role="status">连接信息尚未保存，请先保存后再检查或修改采集配置。</p>` : nothing}
      <div class="actions"><button class="btn btn-refresh" ?disabled=${this.loading || !this.resourceId} @click=${this.load}>刷新采集状态</button>
        <button class="btn" ?disabled=${!this.resourceId || this.connectionPending} @click=${() => { this.editing = true; }}>编辑采集配置</button></div>
    </app-card>
    <app-dialog .open=${this.editing} size="xl" title="编辑采集配置" @app-dialog-close=${(e: Event) => { e.stopPropagation(); e.preventDefault(); this.close(); }}>
      ${this.editing ? html`<metric-configuration .resourceType=${this.resourceType} .resourceId=${this.resourceId}></metric-configuration>` : nothing}
      <div slot="footer"><button class="btn" @click=${this.close}>关闭</button></div>
    </app-dialog>`;
  }
}
