import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { sharedFieldStyles } from '../../styles/shared-field-styles.ts';
import { icons } from '../../../icons.js';
import {
  eventDisplayTitle, eventReadDenied, eventStatusLabels, linkedInvestigationLabels, readEventId, readEventInvestigations, readQueue,
  type QueueEvent, type LinkedInvestigation,
} from '../controllers/event-investigation-api.ts';
import { displayTime } from '../views/diagnosis-presentation.ts';
import { restoreWorkbenchPosition } from '../workbench-position.ts';
import './event-investigation-record.ts';
import './app-badge.ts';

const PAGE_SIZE = 15;
const filters = [
  {id:'all',label:'全部'},
  {id:'followup',label:'待跟进'},
  {id:'running',label:'调查中'},
  {id:'completed',label:'已完成'},
] as const;
type Filter = typeof filters[number]['id'];

@customElement('workbench-event-queue')
export class WorkbenchEventQueue extends LitElement {
  @state() private items: QueueEvent[] = [];
  @state() private investigations = new Map<number, LinkedInvestigation | null>();
  @state() private loading = false;
  @state() private error = '';
  @state() private associationsError = '';
  @state() private selection = 0;
  @state() private filter: Filter = 'all';
  @state() private query = '';
  @state() private page = 0;
  @state() private more = false;
  private request?: AbortController;
  private queryTimer?: ReturnType<typeof setTimeout>;
  private appliedQuery = '';
  private invalidated = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;

  static styles = [sharedBtnStyles, sharedFieldStyles, css`
    :host { display:block; min-width:0; }
    .workspace { display:grid; grid-template-columns:minmax(240px,.34fr) minmax(0,1fr); background:var(--card);
      border:1px solid var(--border); border-radius:var(--radius-md); box-shadow:var(--shadow-sm); overflow:hidden; }
    .queue { min-width:0; border-right:1px solid var(--border); }
    .header { padding:var(--space-md); }
    .heading { display:flex; justify-content:space-between; align-items:center; gap:var(--space-sm); flex-wrap:wrap; }
    h2 { font-size:var(--text-lg); color:var(--text-strong); margin:0; }
    .count { color:var(--muted); font-size:var(--text-sm); }
    .search { position:relative; display:block; margin-top:var(--space-sm); }
    .search svg { position:absolute; color:var(--muted); top:var(--space-md); left:var(--space-sm); width:15px; height:15px; pointer-events:none; }
    .search input { width:100%; padding-left:calc(var(--space-xl) + var(--space-xs)); }
    .filters { display:flex; align-items:center; flex-wrap:wrap; gap:var(--space-xs); margin-top:var(--space-sm); }
    .filters button { padding:var(--space-xs) var(--space-sm); font:inherit; font-size:var(--text-sm); color:var(--muted);
      border:1px solid transparent; border-radius:var(--radius-sm); background:transparent; cursor:pointer; }
    .filters button[aria-pressed=true] { color:var(--accent-text); background:var(--accent-subtle); font-weight:600; }
    .filters button:hover { border-color:var(--border); }
    .rows { border-top:1px solid var(--border); max-height:500px; overflow:auto; }
    .row { display:block; width:100%; padding:var(--space-sm) var(--space-md); text-align:left; background:var(--card); color:var(--text); cursor:pointer; font:inherit;
      border:0; border-left:3px solid transparent; border-bottom:1px solid var(--border); }
    .row:hover { background:var(--bg); }
    .row[aria-pressed=true] { border-left-color:var(--accent); background:var(--accent-subtle); }
    .row:focus-visible { outline:2px solid var(--ring); outline-offset:-3px; }
    .meta { display:flex; align-items:baseline; justify-content:space-between; gap:var(--space-xs); color:var(--muted); font-size:var(--text-sm); }
    .title { display:block; margin-block:var(--space-xs); color:var(--text-strong); font-weight:600; overflow-wrap:anywhere; }
    .status { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-xs); }
    .resource { color:var(--muted); font-size:var(--text-sm); overflow-wrap:anywhere; }
    .footer { display:flex; align-items:center; gap:var(--space-xs); flex-wrap:wrap; padding:var(--space-sm); }
    .message { margin:0; padding:var(--space-lg); color:var(--muted); }
    .message a { color:var(--accent-text); }
    .message[role=alert] { color:var(--danger); }
    .record { min-width:0; }
    @media(max-width:880px) {
      .workspace { grid-template-columns:minmax(0,1fr); }
      .queue { border-right:0; border-bottom:1px solid var(--border); }
      .rows { max-height:275px; }
    }
  `];

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded',this.invalidate);
    window.addEventListener('slide-session-expired',this.invalidate);
  }
  override disconnectedCallback() {
    this.clearRequests();
    window.removeEventListener('slide-permissions-loaded',this.invalidate);
    window.removeEventListener('slide-session-expired',this.invalidate);
    super.disconnectedCallback();
  }
  protected firstUpdated() {
    const params = new URLSearchParams(location.search);
    const event = readEventId(params.get('eventId'));
    if (event) {
      this.selection = event;
      this.query = this.appliedQuery = `#${event}`;
    }
    void this.load();
  }
  private clearRequests() {
    this.request?.abort();
    clearTimeout(this.queryTimer);
    clearTimeout(this.refreshTimer);
  }
  private invalidate = () => {
    this.clearRequests();
    this.invalidated = true;
    this.items = [];
    this.investigations = new Map();
    this.selection = 0;
    this.loading = false;
    this.error = '访问权限已变更。';
  };
  private async load() {
    this.clearRequests();
    if (this.invalidated) return;
    const abort = this.request = new AbortController();
    this.items = [];
    this.investigations = new Map();
    this.more = false;
    this.loading = true;
    this.error = '';
    this.associationsError = '';
    try {
      const {items,more} = await readQueue(this.page,PAGE_SIZE,this.appliedQuery,abort.signal);
      if (abort.signal.aborted) return;
      const ids = items.map(event => readEventId(event.id));
      try {
        const inspections = await readEventInvestigations(ids,abort.signal);
        if (abort.signal.aborted) return;
        this.investigations = inspections;
        this.items = items.filter(event => inspections.has(readEventId(event.id)));
        if (more) this.more = true;
        if ([...inspections.values()].some(item => item?.state === 'running'))
          this.refreshTimer = setTimeout(() => void this.updateAssociations(),5000);
      } catch (error) {
        if (abort.signal.aborted) return;
        if (eventReadDenied(error)) { this.invalidate(); return; }
        this.associationsError = '调查状态暂不可用，可继续查看事件。';
        this.items = items;
        this.more = more;
      }
      this.reconcileSelection();
    } catch { if (!abort.signal.aborted) this.error = '事件队列暂时无法读取。'; }
    finally {
      if (!abort.signal.aborted) {
        this.loading = false;
        await this.updateComplete;
        if (!abort.signal.aborted && this.selection) void restoreWorkbenchPosition(this.renderRoot);
      }
    }
  }
  private async updateAssociations() {
    const abort = this.request;
    if (!abort || abort.signal.aborted) return;
    try {
      const map = await readEventInvestigations(this.items.map(event => readEventId(event.id)),abort.signal);
      if (abort.signal.aborted) return;
      this.items = this.items.filter(event => map.has(readEventId(event.id)));
      this.investigations = map;
      this.reconcileSelection();
      if ([...map.values()].some(item => item?.state === 'running'))
        this.refreshTimer = setTimeout(() => void this.updateAssociations(),5000);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (eventReadDenied(error)) { this.invalidate(); return; }
      this.investigations = new Map();
      this.associationsError = '调查状态暂不可用，可继续查看事件。';
      this.reconcileSelection();
    }
  }
  private visible() {
    if (this.filter === 'all') return this.items;
    return this.items.filter(event => {
      const state = this.investigations.get(readEventId(event.id))?.state;
      if (this.filter === 'running' || this.filter === 'completed') return state === this.filter;
      if (state === 'running') return false;
      return state === 'failed' || state === 'insufficient' || event.status === 'open' || event.status === 'handled';
    });
  }
  private reconcileSelection() {
    const items = this.visible();
    if (!items.some(event => readEventId(event.id) === this.selection))
      this.selection = readEventId(items[0]?.id ?? null);
  }
  private applyQuery() {
    const query = this.query.trim();
    if (query === this.appliedQuery && !this.error) return;
    this.appliedQuery = query;
    this.page = 0;
    void this.load();
  }
  private select(id: number) { this.selection = id; }
  private onRowKeys(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const row = event.currentTarget as HTMLButtonElement;
    const next = (event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLButtonElement | null;
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
  }
  private selectionUrl() {
    const query = new URLSearchParams({workspaceTab:'home',eventId:String(this.selection)});
    return '/workbench?' + query;
  }
  private row(event: QueueEvent) {
    const id = readEventId(event.id);
    const link = this.investigations.get(id);
    const label = link ? linkedInvestigationLabels[link.state] : eventStatusLabels[event.status] ?? '状态待确认';
    const variant = link?.state === 'failed' ? 'danger' : link?.state === 'insufficient' ? 'warn' : link?.state === 'running' ? 'info'
      : link?.state === 'completed' ? 'ok' : 'muted';
    return html`<button class="row" type="button" data-workbench-key=${`source-event-${id}`} aria-pressed=${String(this.selection === id)}
      @click=${() => this.select(id)} @keydown=${this.onRowKeys}>
      <span class="meta"><span>#${id}</span><time>${displayTime(event.created_at)}</time></span>
      <span class="title">${eventDisplayTitle(event)}</span>
      <span class="status"><app-badge variant=${variant}>${label}</app-badge>
        ${event.instance_name ? html`<span class="resource">${event.instance_name}</span>` : nothing}</span>
    </button>`;
  }
  render() {
    const rows = this.visible();
    const selected = rows.find(event => readEventId(event.id) === this.selection);
    return html`<div class="workspace">
      <section class="queue" aria-label="事件队列">
        <div class="header"><div class="heading"><h2>事件队列</h2><span class="count" aria-live="polite">${!this.loading && !this.error ? `本页 ${rows.length} 条` : ''}</span></div>
          <form class="search" @submit=${(e:SubmitEvent) => {e.preventDefault(); this.applyQuery();}}>
            ${icons.search}<input type="search" maxlength="100" aria-label="搜索事件" placeholder="搜索名称或事件编号" .value=${this.query}
              @input=${(e:Event) => {
                this.query = (e.target as HTMLInputElement).value;
                clearTimeout(this.queryTimer);
                this.queryTimer = setTimeout(() => this.applyQuery(),250);
              }}>
          </form>
          <div class="filters" aria-label="本页事件筛选">
          ${filters.map(item => html`<button type="button" aria-pressed=${String(this.filter === item.id)} @click=${() => {
            this.filter = item.id; this.reconcileSelection();
          }}>${item.label}</button>`)}</div>
        </div>
        <div class="rows">
          ${this.loading ? html`<p class="message" role="status">正在读取事件…</p>` : this.error ? html`<p class="message" role="alert">${this.error}</p>`
              : rows.length ? rows.map(event => this.row(event)) : html`<p class="message">本页没有匹配的可见事件。</p>`}
        </div>
        ${this.associationsError ? html`<p class="message" role="status">${this.associationsError}</p>` : nothing}
        <div class="footer">
          ${this.page ? html`<button class="btn btn-sm" type="button" ?disabled=${this.loading} @click=${() => {this.page--;void this.load();}}>上一页</button>` : nothing}
          ${this.more ? html`<button class="btn btn-sm" type="button" ?disabled=${this.loading} @click=${() => {this.page++;void this.load();}}>下一页</button>` : nothing}
          <button class="btn btn-sm btn-refresh" type="button" ?disabled=${this.loading || this.invalidated} @click=${() => void this.load()}>刷新</button>
        </div>
      </section>
      <section class="record" aria-label="所选事件">
      ${selected ? keyed(this.selection, html`<event-investigation-record .event=${selected}
        .link=${this.investigations.get(this.selection)} .source=${this.selectionUrl()} .allowStart=${true}></event-investigation-record>`)
        : html`<p class="message">${this.loading ? '正在准备调查详情…' : '选择一个事件，查看调查结论、处理建议与证据。'}</p>`}
      </section>
    </div>`;
  }
}
