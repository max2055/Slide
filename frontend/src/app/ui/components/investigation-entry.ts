import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { investigationApi, investigationErrorText, InvestigationApiError } from '../controllers/investigation-api.ts';
import { readInvestigationEntry, type InvestigationEntryContext } from '../controllers/investigation-entry.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import './app-card.ts';
import './app-empty-state.ts';

interface EntryFacts { context: InvestigationEntryContext; facts: any[]; modelInvoked: false; }
/** No create-on-mount. Every read is authorized by the server; stale responses are discarded. */
@customElement('investigation-entry')
export class InvestigationEntry extends LitElement {
  @property() investigationId = '';
  @property({ attribute: false }) context: InvestigationEntryContext | null = null;
  @state() private value: EntryFacts | null = null;
  @state() private error = '';
  @state() private loading = false;
  @state() private saving = false;
  @state() private unknown = false;
  @state() private denied = false;
  private epoch = 0;
  private pendingKey = '';
  private pendingContext: InvestigationEntryContext | null = null;
  createRenderRoot() { return this; }
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-session-expired', this.erase);
    window.addEventListener('slide-permissions-loaded', this.erase);
    window.addEventListener('focus', this.focusRead);
    document.addEventListener('visibilitychange', this.visibilityRead);
  }
  disconnectedCallback() {
    this.erase(); window.removeEventListener('slide-session-expired', this.erase);
    window.removeEventListener('slide-permissions-loaded', this.erase);
    window.removeEventListener('focus', this.focusRead);
    document.removeEventListener('visibilitychange', this.visibilityRead); super.disconnectedCallback();
  }
  private focusRead = () => { if (!this.denied && !this.saving) void this.load(); };
  private visibilityRead = () => { if (document.visibilityState === 'visible') this.focusRead(); };
  private erase = () => { this.epoch++; this.value = null; this.context = null; this.pendingContext = null; this.pendingKey = ''; this.unknown = false; this.loading = false; this.saving = false; this.denied = true; this.error = '权限已变化，请返回来源重新确认。'; };
  protected updated(changed: Map<string, unknown>) {
    if (changed.has('context') || changed.has('investigationId')) {
      if (this.denied) return;
      if (changed.has('context') && JSON.stringify(this.context) !== JSON.stringify(this.pendingContext)) {
        this.pendingKey = ''; this.pendingContext = null; this.unknown = false;
      }
      void this.load();
    }
  }
  private fail(e: unknown) {
    this.value = null; this.error = investigationErrorText(e);
    if (e instanceof InvestigationApiError && [401, 403, 404].includes(e.status)) {
      this.denied = true; this.context = null; this.pendingContext = null; this.pendingKey = ''; this.unknown = false;
      this.dispatchEvent(new CustomEvent('investigation-entry-denied', { bubbles: true, composed: true }));
    }
  }
  private async load() {
    if (this.denied) return;
    const epoch = ++this.epoch; this.value = null; this.loading = true; this.error = '';
    try {
      const value = this.investigationId
        ? await investigationApi<EntryFacts>(`/${encodeURIComponent(this.investigationId)}/context-facts`)
        : await investigationApi<EntryFacts>('/entry-facts', { method: 'POST', body: JSON.stringify(this.context ?? readInvestigationEntry(location.search)) });
      if (epoch === this.epoch) this.value = value;
    } catch (e) { if (epoch === this.epoch) this.fail(e); }
    finally { if (epoch === this.epoch) this.loading = false; }
  }
  private async storageKey(context: InvestigationEntryContext) {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const bytes = new TextEncoder().encode(JSON.stringify([user.id ?? null, context]));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return `slide-investigation-entry:${[...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')}`;
  }
  private async save() {
    if (this.saving || this.denied || !this.value && !this.unknown) return;
    const context = this.pendingContext ?? this.value!.context;
    const epoch = this.epoch; this.saving = true; this.error = '';
    if (!this.pendingKey) {
      this.pendingContext = structuredClone(context);
      try {
        const storageKey = await this.storageKey(context);
        if (epoch !== this.epoch) return;
        this.pendingKey = sessionStorage.getItem(storageKey) || crypto.randomUUID();
        // Write before send; storage failure must never allow an unrecoverable submission.
        sessionStorage.setItem(storageKey, this.pendingKey);
      } catch { this.error = '无法保存重试标识，请允许会话存储后重试。'; this.pendingKey = ''; this.saving = false; return; }
    }
    try {
      const result = await investigationApi<{ id: string }>('/drafts', { method: 'POST',
        headers: { 'Idempotency-Key': this.pendingKey }, body: JSON.stringify(context) });
      if (epoch !== this.epoch) return;
      this.unknown = false;
      // Keep key for refresh/back/retry of this exact context, even if URL update fails.
      const url = new URL(location.href); url.searchParams.delete('entry'); url.searchParams.set('investigation', result.id);
      history.replaceState({}, '', url);
      this.investigationId = result.id;
      this.dispatchEvent(new CustomEvent('investigation-draft-created', { bubbles: true, composed: true, detail: result }));
    } catch (e) {
      if (epoch === this.epoch) {
        this.unknown = !(e instanceof InvestigationApiError) || e.status >= 500;
        this.fail(e);
        if (this.unknown && !this.denied) this.error = '保存结果未知。请核对原请求；保留原范围与重试标识。';
      }
    } finally { if (epoch === this.epoch) this.saving = false; }
  }
  render() {
    const c = this.value?.context;
    const returnTo = c?.returnTo;
    // Server-validated destinations only. Unvalidated link input is never rendered as href.
    return html`<style>${sharedBtnStyles.cssText}
      investigation-entry { display:block; min-width:0; margin-bottom:var(--space-lg); }
      investigation-entry .entry-actions { display:flex; flex-wrap:wrap; gap:var(--space-sm); margin:var(--space-md) 0; }
      investigation-entry p { overflow-wrap:anywhere; line-height:1.6; }
      investigation-entry table { width:100%; border-collapse:collapse; font-size:var(--text-sm); }
      investigation-entry td, investigation-entry th { text-align:left; padding:var(--space-sm); border-bottom:1px solid var(--border); overflow-wrap:anywhere; }
      investigation-entry .entry-table { overflow:auto; max-height:360px; }
    </style><app-card><span slot="header">${this.investigationId ? '调查来源与授权事实' : '只读调查草案'}</span>
      <p>本页仅核对授权事实，尚未进行模型分析。缺少模型不影响查看；审批、执行与恢复验证尚未开始。</p>
      ${this.loading ? html`<p role="status">正在读取原窗口内的事实…</p>` : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${c ? html`<dl><dt>资源范围</dt><dd>${c.resourceRefs.map(r => `${r.type}:${r.id}（${r.role === 'primary' ? '主资源' : '关联资源'}）`).join('、')}</dd>
        <dt>绝对观察窗口</dt><dd>${c.from} → ${c.to}</dd>
        <dt>来源事件</dt><dd>${c.sourceEventIds.join('、') || '资源 / 指标历史入口'}</dd>
        ${c.metric ? html`<dt>指标身份</dt><dd>${c.metric.id} · ${c.metric.semantic_version} · ${JSON.stringify(c.dimensions ?? {})}</dd>` : nothing}</dl>
        ${this.value!.facts.map(f => html`<section aria-label="授权事实"><h3>${f.resource.type}:${f.resource.id}</h3>
          ${f.observations ? html`<p>正式观测共 ${f.total} 条，本页 ${f.observations.length} 条${f.has_more ? '，其余未展示（未扩大查询范围）' : ''}。</p>
            ${this.rows(f.observations)}` : html`${f.metrics.map((m: any) => html`<h4>${m.definition.id} · ${m.definition.semantic_version}</h4><p>当前覆盖状态：${m.state}。历史质量以观测记录为准。</p>${m.series.map((s: any) => html`<p>维度：${JSON.stringify(s.dimensions)}</p>${this.rows(s.buckets)}`)}`)}
            ${!f.metrics.some((m: any) => m.series.some((s: any) => s.buckets.some((b: any) => b.sources?.length))) ? html`<app-empty-state title="窗口内暂无正式观测" description="保留原范围；可返回来源补采集，不推断资源健康或恢复。"></app-empty-state>` : nothing}`}
        </section>`)}
      ` : nothing}
      <div class="entry-actions">
        ${!this.denied ? html`<button class="btn btn-refresh" ?disabled=${this.loading || this.saving} @click=${this.load}>重试读取</button>` : nothing}
        ${!this.investigationId && !this.denied ? html`<button class="btn-primary" ?disabled=${this.saving || !this.value && !this.unknown} @click=${this.save}>${this.saving ? '正在保存…' : this.unknown ? '核对原保存请求' : '保存调查草案'}</button>` : nothing}
        ${returnTo ? html`<a class="btn" href=${returnTo}>返回来源</a>` : nothing}
      </div>
    </app-card>`;
  }
  private rows(rows: any[]) {
    if (!rows.length) return html`<app-empty-state title="窗口内暂无正式观测" description="保留查询范围与证据缺口。"></app-empty-state>`;
    return html`<div class="entry-table" tabindex="0" aria-label="观测表，可滚动"><table><thead><tr><th>时间</th><th>值</th><th>单位</th><th>质量 / 来源</th></tr></thead><tbody>${rows.map(r => html`<tr><td>${r.observed_at ?? r.window?.from ?? r.from ?? r.start}</td><td>${r.value && 'value' in r.value ? r.value.value : '未知'}</td><td>${r.unit ?? ''}</td><td>${JSON.stringify(r.quality ?? r.status ?? 'unknown')} · ${(r.sources ?? []).map((s: any) => s.id).join('、') || '无来源'}</td></tr>`)}</tbody></table></div>`;
  }
}
