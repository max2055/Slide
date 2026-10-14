import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { investigationApi, investigationErrorText, type InvestigationList } from '../controllers/investigation-api.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import './app-card.ts';
import './app-empty-state.ts';

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
  static styles = [sharedBtnStyles,css`:host {display:block;min-width:0;margin-bottom:var(--space-md);} a {color:var(--accent);overflow-wrap:anywhere;} p {margin:var(--space-sm) 0;}`];
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
      if (generation === this.generation) this.items = list.items;
    } catch (error) { if (generation === this.generation) this.error = investigationErrorText(error); }
    finally { if (generation === this.generation) this.loading = false; }
  }
  render() {
    return html`<app-card><span slot="header">资源调查</span>
      ${this.loading ? html`<p role="status">正在加载调查…</p>` : this.error ? html`<p role="alert">${this.error}</p>` : this.items.length
        ? this.items.map(row => html`<p><a href=${`/investigations?investigation=${row.id}`}>${row.title}</a></p>`)
        : html`<app-empty-state title="暂无可访问的调查" description="从资源告警发起调查后，可在这里继续查看。"></app-empty-state>`}
      <a href=${`/investigations?resource=${this.resourceType}:${this.resourceId}`}>查看此资源的全部调查</a>
      ${this.error ? html`<button class="btn" @click=${this.load}>重新加载调查</button>` : nothing}
    </app-card>`;
  }
}
