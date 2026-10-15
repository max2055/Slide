import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { investigationApi, investigationErrorText, type InvestigationList } from '../controllers/investigation-api.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';

export type ResourceType = 'instance' | 'server' | 'network_device';
export function resourceDetailUrl(type: ResourceType, id: number) {
  return type === 'instance' ? `/?tab=instance-detail&id=${id}` : type === 'server'
    ? `/?tab=server-detail&id=${id}` : `/?tab=network-device-detail&networkDeviceId=${id}`;
}
@customElement('resource-investigation-links')
export class ResourceInvestigationLinks extends LitElement {
  @property() resourceType: ResourceType = 'instance';
  @property({ type: Number }) resourceId = 0;
  @state() private items: InvestigationList['items'] = [];
  @state() private loading = false;
  @state() private error = '';
  private generation = 0;
  private invalidate = () => { ++this.generation; this.items = []; this.error = '权限已变更，请重新加载。'; this.loading = false; };
  static styles = [sharedBtnStyles, css`
    :host { display:block; min-width:0; margin-bottom:var(--space-md); color:var(--muted); font-size:var(--text-sm); }
    .related-line { display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--space-sm) var(--space-md); }
    a { color:var(--accent-text); overflow-wrap:anywhere; }
    details { min-width:0; max-width:100%; } .latest { max-width:28ch; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    summary { cursor:pointer; color:var(--text); }
    ul { margin:var(--space-sm) 0 0; padding-left:var(--space-lg); }
    li { margin-block:var(--space-xs); }
    [role=alert] { color:var(--danger); }
    .btn { white-space:normal; }
  `];
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.invalidate);
    window.addEventListener('slide-session-expired', this.invalidate);
  }
  disconnectedCallback() {
    this.invalidate();
    window.removeEventListener('slide-permissions-loaded', this.invalidate);
    window.removeEventListener('slide-session-expired', this.invalidate);
    super.disconnectedCallback();
  }
  protected updated(changed: Map<string, unknown>) {
    if (changed.has('resourceId') || changed.has('resourceType')) void this.load();
  }
  private async load() {
    const generation = ++this.generation;
    this.items = []; this.error = ''; this.loading = true;
    try {
      if (!['instance','server','network_device'].includes(this.resourceType) || !Number.isSafeInteger(this.resourceId) || this.resourceId <= 0) return;
      const list = await investigationApi<InvestigationList>(`?resource=${this.resourceType}:${this.resourceId}&limit=5`);
      if (!Array.isArray(list?.items)) throw new Error('INVESTIGATION_RESPONSE_INVALID');
      if (generation === this.generation) this.items = list.items;
    } catch (error) { if (generation === this.generation) this.error = investigationErrorText(error); }
    finally { if (generation === this.generation) this.loading = false; }
  }
  render() {
    return html`<div class="related-line" role="region" aria-label="资源调查">
      ${this.loading ? html`<span role="status">正在加载调查…</span>` : this.error ? html`<span role="alert">${this.error}</span>` : this.items.length
        ? html`<span>关联调查 · 最近 ${this.items.length} 项</span><a class="latest" title=${this.items[0].title} href=${`/investigations?investigation=${encodeURIComponent(this.items[0].id)}`}>${this.items[0].title}</a>${this.items.length > 1 ? html`<details><summary>更多调查</summary><ul>${this.items.slice(1).map(row => html`<li><a href=${`/investigations?investigation=${encodeURIComponent(row.id)}`}>${row.title}</a></li>`)}</ul></details>` : nothing}`
        : html`<span>暂无可访问的调查</span>`}
      <a href=${`/investigations?resource=${this.resourceType}:${this.resourceId}`}>查看此资源的全部调查</a>
      ${this.error ? html`<button class="btn" @click=${this.load}>重新加载调查</button>` : nothing}
    </div>`;
  }
}
