import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.ts';
import type { SystemEventSummary, SystemEventDetail, SystemEventsPage } from '../../../api/generated/public-api.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import '../components/app-card.ts';
import '../components/app-empty-state.ts';
import '../components/app-badge.ts';

@customElement('system-events-page')
export class SystemEventsPageElement extends LitElement {
  @state() private items: SystemEventSummary[] = [];
  @state() private detail: SystemEventDetail | null = null;
  @state() private loading = true;
  @state() private error = '';
  @state() private truncated = false;
  @state() private listLoaded = false;
  @state() private collectionActive: boolean | null = null;
  @state() private collectionLoading = true;
  private generation = 0;
  private collectionRequest = 0;
  static styles = [sharedBtnStyles, css`
    :host { display:block; min-width:0; }
    .events { display:grid; gap:var(--space-md); }
    .actions { display:flex; gap:var(--space-sm); flex-wrap:wrap; }
    .event-title { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; color:var(--text); }
  `];
  private invalidate = () => {
    this.generation++;
    this.collectionRequest++;
    this.items = [];
    this.detail = null;
    this.loading = false;
    this.error = '权限或会话已变化，请刷新核对。';
    this.listLoaded = false;
    this.truncated = false;
    this.collectionActive = null;
    this.collectionLoading = false;
  };
  override connectedCallback() { super.connectedCallback(); window.addEventListener('slide-session-expired', this.invalidate); window.addEventListener('slide-permissions-loaded', this.invalidate); void this.load(); }

  override disconnectedCallback() { this.invalidate(); window.removeEventListener('slide-session-expired', this.invalidate); window.removeEventListener('slide-permissions-loaded', this.invalidate); super.disconnectedCallback(); }
  private async request<T>(path: string): Promise<T> {
    const response = await authFetch(`/api/platform/system-events${path}`, { cache: 'no-store' });
    if (!response.ok) throw new Error([401, 403, 404].includes(response.status) ? '无访问权限或登录已失效。' : '事件暂不可用，请刷新重试。');
    return response.json();
  }
  private async readCollectionState(): Promise<boolean | null> {
    try {
      const response = await authFetch('/api/platform/observations', { cache: 'no-store' });
      if (!response.ok) return null;
      const value = (await response.json())?.system?.collection?.effective;
      return typeof value === 'boolean' ? value : null;
    } catch {
      return null;
    }
  }
  private async loadCollectionState() {
    const request = ++this.collectionRequest;
    this.collectionActive = null;
    this.collectionLoading = true;
    const active = await this.readCollectionState();
    if (request !== this.collectionRequest) return;
    this.collectionActive = active;
    this.collectionLoading = false;
  }
  private async load(id?: string) {
    const generation = ++this.generation;
    this.loading = true; this.error = ''; this.detail = null;
    if (!id) {
      this.items = [];
      this.listLoaded = false;
      this.truncated = false;
      void this.loadCollectionState();
    }
    try {
      if (id) {
        const detail = await this.request<SystemEventDetail>(`/${encodeURIComponent(id)}`);
        if (generation === this.generation) this.detail = detail;
      } else {
        const page = await this.request<SystemEventsPage>('');
        if (generation === this.generation) {
          if (!Array.isArray(page?.items) || typeof page.truncated !== 'boolean') throw new Error('异常记录暂不可读，请刷新重试。');
          this.items = page.items;
          this.truncated = page.truncated;
          this.listLoaded = true;
          const selected = new URL(location.href).searchParams.get('event');
          if (selected && page.items.some(e => e.eventId === selected)) void this.load(selected);
        }
      }
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error && !(error instanceof SyntaxError)
        ? error.message : '异常记录暂不可读，请刷新重试。';
    } finally { if (generation === this.generation) this.loading = false; }
  }
  private async openDraft(eventId: string) {
    const g = ++this.generation; this.loading = true; this.error = '';
    try {
      const response = await authFetch(`/api/platform/system-events/${encodeURIComponent(eventId)}/investigation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error([401,403,404].includes(response.status) ? '原异常或已有调查无访问权限，请联系管理员授权。' : '调查保存回执未确认，请从同一异常重试。');
      const data = await response.json();
      if (g === this.generation) location.assign(`/workbench?investigation=${encodeURIComponent(data.id)}`);
    } catch (e) { if (g === this.generation) this.error = e instanceof Error ? e.message : '调查入口暂不可用。'; }
    finally { if (g === this.generation) this.loading = false; }
  }
  override render() {
    return html`<div class="actions"><h2>平台异常</h2><button aria-busy=${String(this.loading)} class="btn btn-refresh" ?disabled=${this.loading} @click=${() => void this.load()}>刷新异常</button></div>
      ${this.collectionActive === true ? html`<p>异常采集 <app-badge variant="ok">已启用</app-badge></p>`
        : this.collectionActive === false ? html`<p>异常采集 <app-badge variant="muted">已关闭</app-badge> · 仍可查看历史记录</p>`
        : this.collectionLoading ? html`<p>正在读取异常采集状态…</p>` : html`<p>异常采集状态暂不可读</p>`}
      ${this.loading ? html`<p role="status">正在读取异常…</p>` : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.listLoaded && !this.items.length ? html`<app-empty-state title="暂无可见的异常记录"></app-empty-state>` : nothing}
      ${this.truncated ? html`<p>仅显示最近100条异常。</p>` : nothing}
      <div class="events">${this.items.map(event => html`<app-card data-event-id=${event.eventId}>
        <span slot="header" class="event-title" title=${event.summary}>${event.summary}</span><p>${event.component} · ${event.occurredAt}</p>
        <app-badge>${event.disposition === 'suppressed' ? '自动调查未派发' : '已关联调查'}</app-badge>
        <div class="actions"><button class="btn" ?disabled=${this.loading} @click=${() => void this.load(event.eventId)}>查看原始事实</button>
        ${event.investigationId ? html`<a class="btn" href=${`/workbench?investigation=${encodeURIComponent(event.investigationId)}`}>打开调查</a>` : html`<button class="btn" ?disabled=${this.loading} @click=${() => void this.openDraft(event.eventId)}>打开只读调查</button>`}</div>
      </app-card>`)}</div>
      ${this.detail ? html`<app-card><span slot="header">原始错误事实</span><pre>${JSON.stringify(this.detail.fact, null, 2)}</pre></app-card>` : nothing}`;
  }
}
