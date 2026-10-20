import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { OperationsResource, operationLabels, validRecord, currentUserId, type CasePage, type CaseRecord, type CaseCandidate } from '../controllers/operations-api.ts';
import { hasSlidePermission } from '../app-settings.ts';
import { operationsStyles } from './operations-styles.ts';
import '../components/app-card.ts';
import '../components/app-badge.ts';
import '../components/app-empty-state.ts';
import '../components/app-form-field.ts';
import '../components/app-dialog.ts';

const freshCandidate = (): CaseCandidate => ({ investigationId: '', resultVersion: 1,
  content: { title: '', symptoms: '', faultType: '', confirmedCause: '', actions: '', actualEffect: '', counterexamples: '' },
  applicability: { conditions: '', productVersion: '', resourceVersion: '' }, validUntil: '', humanConfirmed: true });

@customElement('operations-knowledge')
export class OperationsKnowledge extends LitElement {
  static styles = operationsStyles;
  @property({ attribute: false }) permissions: Set<string> | null = null;
  @state() private query = '';
  @state() private filter = 'published';
  @state() private resourceType = '';
  @state() private selected = '';
  @state() private note = '';
  @state() private formOpen = false;
  @state() private editing = false;
  @state() private candidate = freshCandidate();
  @state() private humanConfirmed = false;
  @state() private formError = '';
  private pages = new OperationsResource<CasePage>(this, () => this.clearDrafts());
  private record = new OperationsResource<CaseRecord>(this, () => this.clearDrafts());
  private clearDrafts() { this.note = ''; this.formOpen = false; this.candidate = freshCandidate(); this.humanConfirmed = false; this.formError = ''; }
  private can(code: string) { return hasSlidePermission(this.permissions, `operations:cases:${code}`); }
  private pop = () => { const id = new URL(location.href).searchParams.get('case') ?? ''; this.selected = id; this.record.reset(); this.clearDrafts(); if (id) void this.open(id, false); else void this.search(); };
  connectedCallback() { super.connectedCallback(); window.addEventListener('popstate', this.pop); }
  disconnectedCallback() { window.removeEventListener('popstate', this.pop); super.disconnectedCallback(); }
  protected firstUpdated() {
    const p = new URL(location.href).searchParams;
    this.query = p.get('query')?.slice(0,200) ?? '';
    const id = p.get('case'); if (id) void this.open(id, false); else void this.search();
  }
  private async search(cursor?: string) {
    const query = new URLSearchParams({ state: this.filter, query: this.query, limit: '20' });
    if (this.resourceType) query.set('resourceType', this.resourceType);
    if (cursor) query.set('cursor', cursor);
    await this.pages.load(`/knowledge?${query}`);
  }
  private async open(id: string, push = true) {
    this.clearDrafts(); this.selected = id;
    if (push) { const u = new URL(location.href); u.searchParams.set('case', id); history.pushState({}, '', u); }
    await this.record.load(`/knowledge/${encodeURIComponent(id)}`);
  }
  private back() {
    this.selected = ''; this.record.reset(); this.clearDrafts();
    const u = new URL(location.href); u.searchParams.delete('case'); history.pushState({}, '', u); void this.search();
  }
  private startCandidate(edit = false) {
    const r = this.record.data, p = new URL(location.href).searchParams;
    this.editing = edit; this.formError = ''; this.humanConfirmed = false;
    this.candidate = edit && r?.content && r.source && r.applicability ? {
      content: { ...r.content }, applicability: { ...r.applicability }, investigationId: r.source.investigationId,
      resultVersion: r.source.resultVersion, validUntil: r.validUntil, humanConfirmed: true,
    } : { ...freshCandidate(), investigationId: p.get('sourceInvestigation') ?? '', resultVersion: Number(p.get('resultVersion')) || 1 };
    this.formOpen = true;
  }
  private async saveCandidate(e: Event) {
    e.preventDefault(); if (!this.humanConfirmed || this.record.locked) return;
    const c = this.candidate;
    if (!Number.isSafeInteger(c.resultVersion) || c.resultVersion < 1 || !Number.isFinite(Date.parse(c.validUntil))) { this.formError = '请填写有效结果版本与到期时间。'; return; }
    const body = { ...c, validUntil: new Date(c.validUntil).toISOString() };
    const r = this.record.data;
    const binding = await this.record.write<{ id: string }>(this.editing && r ? `/knowledge/${encodeURIComponent(r.id)}` : '/knowledge',
      this.editing && r ? { expectedRevision: r.revision, candidate: body } : body, this.editing ? 'PUT' : 'POST');
    if (binding) { this.formOpen = false; await this.open(binding.id); }
  }
  private async transition(action: 'submit' | 'approved' | 'rejected' | 'withdraw') {
    const r = this.record.data; if (!r || this.record.locked) return;
    if (action !== 'submit' && !this.note.trim()) { this.formError = '请填写审核或撤回依据。'; return; }
    const path = action === 'approved' || action === 'rejected' ? 'review' : action;
    const body = action === 'submit' ? { expectedRevision: r.revision } : action === 'withdraw'
      ? { expectedRevision: r.revision, reason: this.note.trim() }
      : { expectedRevision: r.revision, version: r.version, contentHash: r.contentHash, decision: action, note: this.note.trim() };
    const result = await this.record.write(`/knowledge/${encodeURIComponent(r.id)}/${path}`, body);
    if (result) { this.note = ''; this.formError = ''; await this.open(r.id, false); }
  }
  private status(resource: OperationsResource<unknown>) {
    return html`${resource.error ? html`<p role="alert">${resource.error}</p>` : nothing}
      ${resource.mutationUnknown ? html`<p class="notice warn" role="status">提交结果未知。请只读刷新核对原版本；当前页面不会重发此操作。</p>` : nothing}
      ${resource.loading ? html`<div class="skeleton" role="status" aria-label="正在读取案例">正在读取案例…</div>` : nothing}`;
  }
  private list() {
    const p = this.pages;
    return html`<div class="layout"><section>
      <form class="toolbar" @submit=${(e: Event) => { e.preventDefault(); void this.search(); }}>
        <label>案例状态<select aria-label="案例状态" .value=${this.filter} @change=${(e: Event) => { this.filter = (e.target as HTMLSelectElement).value; void this.search(); }}>
          ${['published','pending_review','draft','expired','withdrawn'].map(v => html`<option value=${v}>${operationLabels[v]}</option>`)}</select></label>
        <label>搜索案例<input aria-label="搜索案例" maxlength="200" placeholder="搜索症状、方法或适用条件" .value=${this.query} @input=${(e: Event) => this.query = (e.target as HTMLInputElement).value}></label>
        <label>资源类型<select aria-label="资源类型" .value=${this.resourceType} @change=${(e: Event) => { this.resourceType = (e.target as HTMLSelectElement).value; void this.search(); }}><option value="">全部资源</option><option value="instance">数据库实例</option><option value="server">服务器</option><option value="network_device">网络设备</option></select></label>
        <button class="btn" ?disabled=${p.loading || p.accessInvalidated}>搜索</button>
        <button class="btn-ghost" type="button" ?disabled=${p.accessInvalidated} @click=${() => { this.query = ''; this.resourceType = ''; this.filter = 'published'; void this.search(); }}>清除筛选</button>
      </form>${this.status(p)}
      ${!p.loading && p.data ? html`<app-card><span slot="header">当前可访问案例 · ${p.data.authorizedCounts.total}</span>
        ${p.data.items.length ? p.data.items.map(r => html`<div class="row"><div class="row-head"><button class="btn-ghost" @click=${() => void this.open(r.id)}>${r.content?.title ?? '历史案例元数据'}</button><app-badge variant=${r.state === 'published' && !r.tombstone ? 'ok' : 'warn'}>${operationLabels[r.state]}</app-badge></div>
          <p>${r.content?.symptoms ?? '正文已不可引用，保留审核与版本轨迹。'}</p><div class="meta"><span>版本 ${r.version}</span><span>作者 #${r.author.id}</span><span>有效期至 ${new Date(r.validUntil).toLocaleString('zh-CN')}</span></div></div>`)
          : html`<app-empty-state title="没有匹配的案例" description="可缩短搜索词或调整状态与资源类型。"></app-empty-state>`}
        </app-card><div class="toolbar"><span class="muted">当前页 ${p.data.items.length} 条 · 仅统计当前授权范围</span>${p.data.nextCursor ? html`<button class="btn" @click=${() => void this.search(p.data!.nextCursor!)}>下一页</button>` : nothing}</div>` : nothing}
      ${p.error ? html`<button class="btn btn-refresh" ?disabled=${p.accessInvalidated} @click=${() => void this.search()}>重试读取案例</button>` : nothing}
    </section><aside class="stack"><app-card><span slot="header">经验有依据，复用有条件</span><p>仅已发布且有效的案例可作为参考。引用前仍需核对当前资源、版本与证据。</p><p class="muted">历史经验属于参考材料，不是本次故障的事实证据，也不授予执行许可。</p></app-card></aside></div>`;
  }
  private detail(r: CaseRecord) {
    const usable = !r.tombstone && r.state === 'published' && validRecord(r);
    const author = currentUserId() === r.author.id;
    return html`<div class="toolbar"><button class="btn-ghost" @click=${this.back}>返回案例列表</button><button class="btn btn-refresh" ?disabled=${this.record.loading || this.record.writing || this.record.accessInvalidated} @click=${() => void this.open(r.id, false)}>刷新案例</button></div>
      <div class="layout"><app-card class="article"><span slot="header">${r.content?.title ?? '历史案例'}</span>
        ${r.tombstone ? html`<app-empty-state title="正文不可引用" description="来源不可访问、已过期或已撤回；仅保留版本元数据。"></app-empty-state>` : html`
        <section><h2>适用范围</h2><p>${r.applicability?.conditions}</p><p class="muted">产品 ${r.applicability?.productVersion} · 资源 ${r.applicability?.resourceVersion}</p></section>
        <section><h2>问题与已确认事实</h2><p>${r.content?.symptoms}</p><p>${r.content?.confirmedCause}</p><p class="notice">案例记录历史结论；当前问题仍需独立核验证据。</p></section>
        <section><h2>处理与验证</h2><p>${r.content?.actions}</p><p>${r.content?.actualEffect}</p></section>
        <section><h2>不适用与反面证据</h2><p>${r.content?.counterexamples}</p></section>
        <section><h2>引用的原始记录</h2>${r.source ? html`<a href=${`/investigations?investigation=${encodeURIComponent(r.source.investigationId)}`}>查看来源调查 · 结果版本 ${r.source.resultVersion}</a><p class="muted">${r.source.evidence.length} 条来源证据，打开原记录时重新检查权限。</p>` : nothing}</section>`}
      </app-card><aside class="stack"><app-card><span slot="header">版本与审核</span><dl><dt>当前状态</dt><dd><app-badge variant=${usable ? 'ok' : 'warn'}>${operationLabels[r.state]}</app-badge></dd><dt>内容版本</dt><dd>v${r.version} · 修订 ${r.revision}</dd><dt>作者</dt><dd>#${r.author.id}</dd><dt>有效期</dt><dd>${new Date(r.validUntil).toLocaleString('zh-CN')}</dd></dl>
        <details><summary>不可变引用与技术详情</summary><pre>${JSON.stringify({id:r.id,version:r.version,contentHash:r.contentHash,reason:r.reason},null,2)}</pre></details>
        ${usable ? html`<p>复用前请在调查中核对适用条件；当前服务尚未提供人工选择案例的绑定入口。</p>` : html`<p class="notice warn">当前版本不能作为可信案例引用。</p>`}
        ${!r.tombstone && this.can('manage') && author ? html`<button class="btn" ?disabled=${this.record.locked} @click=${() => this.startCandidate(true)}>编辑为新版本</button>${r.state === 'draft' ? html`<button class="btn-primary" ?disabled=${this.record.locked || !validRecord(r)} @click=${() => void this.transition('submit')}>提交独立审核</button>` : nothing}` : nothing}
      </app-card>
      ${!r.tombstone && (this.can('review') && r.state === 'pending_review' || this.can('manage')) ? html`<app-card><span slot="header">人工审核与治理</span><label>审核或撤回依据<textarea aria-label="审核或撤回依据" maxlength="2000" rows="3" ?disabled=${this.record.locked} .value=${this.note} @input=${(e: Event) => this.note = (e.target as HTMLTextAreaElement).value}></textarea></label>
        ${this.can('review') && r.state === 'pending_review' ? html`<p class="muted">作者不能自审；服务端核验当前身份、版本和内容摘要。</p><button class="btn-primary" ?disabled=${this.record.locked || author || !this.note.trim() || !validRecord(r)} @click=${() => void this.transition('approved')}>审核发布当前版本</button><button class="btn" ?disabled=${this.record.locked || author || !this.note.trim()} @click=${() => void this.transition('rejected')}>驳回修改</button>` : nothing}
        ${this.can('manage') && r.state !== 'withdrawn' ? html`<button class="btn" ?disabled=${this.record.locked || !this.note.trim()} @click=${() => void this.transition('withdraw')}>撤回案例</button>` : nothing}
        ${this.formError ? html`<p role="alert">${this.formError}</p>` : nothing}</app-card>` : nothing}
      </aside></div>`;
  }
  private candidateForm() {
    const c = this.candidate;
    const field = (name: string, value: string, change: (v: string) => void, max = 4000) => html`<label>${name}<textarea aria-label=${name} required maxlength=${max} rows="2" .value=${value} ?disabled=${this.record.locked} @input=${(e: Event) => change((e.target as HTMLTextAreaElement).value)}></textarea></label>`;
    return html`<app-dialog .open=${this.formOpen} title=${this.editing ? '编辑为新案例版本' : '从调查整理案例'} @app-dialog-close=${() => this.formOpen = false}>
      <form id="case-candidate" class="form" @submit=${this.saveCandidate}><p>请人工核实来源与处理效果；保存草稿不会自动发布。</p>
        <label>来源调查 ID<input aria-label="来源调查 ID" required maxlength="128" .value=${c.investigationId} ?disabled=${this.editing || this.record.locked} @input=${(e: Event) => this.candidate = {...c, investigationId:(e.target as HTMLInputElement).value}}></label>
        <label>来源结果版本<input aria-label="来源结果版本" type="number" min="1" required .value=${String(c.resultVersion)} ?disabled=${this.editing || this.record.locked} @input=${(e: Event) => this.candidate = {...c, resultVersion:Number((e.target as HTMLInputElement).value)}}></label>
        ${Object.entries({title:'案例标题',symptoms:'问题现象',faultType:'故障类型',confirmedCause:'已确认原因',actions:'实际处理',actualEffect:'实际效果',counterexamples:'反面证据与不适用条件'}).map(([key,label]) => field(label,c.content[key as keyof typeof c.content],v => this.candidate = {...this.candidate,content:{...this.candidate.content,[key]:v}}, key === 'title' ? 200 : key === 'faultType' ? 100 : 4000))}
        ${Object.entries({conditions:'适用条件',productVersion:'产品版本',resourceVersion:'资源版本'}).map(([key,label]) => field(label,c.applicability[key as keyof typeof c.applicability],v => this.candidate = {...this.candidate,applicability:{...this.candidate.applicability,[key]:v}},key === 'conditions' ? 4000 : 128))}
        <label>有效期至<input aria-label="有效期至" type="datetime-local" step="0.001" required .value=${c.validUntil ? localDate(c.validUntil) : ''} ?disabled=${this.record.locked} @input=${(e: Event) => this.candidate = {...c,validUntil:(e.target as HTMLInputElement).value}}></label>
        <label class="check"><input type="checkbox" required .checked=${this.humanConfirmed} ?disabled=${this.record.locked} @change=${(e: Event) => this.humanConfirmed = (e.target as HTMLInputElement).checked}>我已人工确认来源结果、处理效果与脱敏内容</label>
        ${this.formError ? html`<p role="alert">${this.formError}</p>` : nothing}${this.status(this.record)}
      </form><div slot="footer"><button class="btn" @click=${() => this.formOpen = false}>取消</button><button class="btn-primary" ?disabled=${this.record.locked || !this.humanConfirmed} @click=${() => this.renderRoot.querySelector<HTMLFormElement>('#case-candidate')?.requestSubmit()}>保存案例草稿</button></div>
    </app-dialog>`;
  }
  render() {
    return html`<div class="heading"><div><h1>可信运维知识</h1><p class="muted">经过审核的处理经验，带着适用条件和证据一起复用。</p></div>${this.can('manage') ? html`<button class="btn-primary" ?disabled=${this.record.locked || this.pages.accessInvalidated} @click=${() => this.startCandidate()}>从调查整理案例</button>` : nothing}</div>
      ${this.selected ? html`${this.status(this.record)}${this.record.data ? this.detail(this.record.data) : html`<button class="btn-ghost" @click=${this.back}>返回案例列表</button><button class="btn btn-refresh" ?disabled=${this.record.loading || this.record.accessInvalidated} @click=${() => void this.open(this.selected,false)}>重试读取案例</button>`}` : this.list()}
      ${this.candidateForm()}`;
  }
}
function localDate(value: string) {
  const date = new Date(value); return Number.isFinite(+date) ? new Date(+date - date.getTimezoneOffset()*60000).toISOString().slice(0,23) : value;
}
