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
  private generation = 0;
  static styles = [sharedBtnStyles, css`
    :host { display:block; min-width:0; }
    .events { display:grid; gap:var(--space-md); }
    .actions { display:flex; gap:var(--space-sm); flex-wrap:wrap; }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; color:var(--text); }
    .muted { color:var(--muted); }
  `];
  override connectedCallback() { super.connectedCallback(); void this.load(); }
  override disconnectedCallback() { this.generation++; super.disconnectedCallback(); }
  private async request<T>(path: string): Promise<T> {
    const response = await authFetch(`/api/platform/system-events${path}`, { cache: 'no-store' });
    if (!response.ok) throw new Error([401, 403, 404].includes(response.status) ? '无访问权限或登录已失效。' : '事件暂不可用，请刷新重试。');
    return response.json();
  }
  private async load(id?: string) {
    const generation = ++this.generation;
    this.loading = true; this.error = ''; this.detail = null;
    try {
      if (id) {
        const detail = await this.request<SystemEventDetail>(`/${encodeURIComponent(id)}`);
        if (generation === this.generation) this.detail = detail;
      } else {
        const page = await this.request<SystemEventsPage>('');
        if (generation === this.generation) { this.items = page.items; this.truncated = page.truncated; }
      }
    } catch (error) {
      if (generation === this.generation) { this.items = []; this.truncated = false; this.error = error instanceof Error ? error.message : '事件暂不可用。'; }
    } finally { if (generation === this.generation) this.loading = false; }
  }
  override render() {
    return html`<div class="actions"><h2>平台异常</h2><button class="btn" ?disabled=${this.loading} @click=${() => void this.load()}>刷新异常</button></div>
      <p class="muted">持久错误事实与调查结果分别保留；执行完成不表示故障已恢复。</p>
      ${this.loading ? html`<p role="status">正在读取异常…</p>` : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${!this.loading && !this.error && !this.items.length ? html`<app-empty-state title="暂无持久异常" description="异常采集默认关闭；无事件不表示平台没有故障。"></app-empty-state>` : nothing}
      ${this.truncated ? html`<p>仅显示最近100条异常。</p>` : nothing}
      <div class="events">${this.items.map(event => html`<app-card data-event-id=${event.eventId}>
        <span slot="header">${event.summary}</span><p>${event.component} · ${event.occurredAt}</p>
        <app-badge>${event.disposition === 'suppressed' ? '未派生调查' : '已关联调查'}</app-badge>
        <div class="actions"><button class="btn" ?disabled=${this.loading} @click=${() => void this.load(event.eventId)}>查看原始事实</button>
        ${event.investigationId ? html`<a class="btn" href=${`/investigations?investigation=${encodeURIComponent(event.investigationId)}`}>打开调查</a>` : nothing}</div>
      </app-card>`)}</div>
      ${this.detail ? html`<app-card><span slot="header">原始错误事实</span><pre>${JSON.stringify(this.detail.fact, null, 2)}</pre></app-card>` : nothing}`;
  }
}
