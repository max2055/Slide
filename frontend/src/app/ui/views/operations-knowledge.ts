import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { OperationsApiError, OperationsResource, watchCase, authorizedJson, operationsApi, operationsErrorText, operationLabels, resourceLabel, validRecord, currentUserId, type CasePage, type CaseRecord, type CaseCandidate } from '../controllers/operations-api.ts';
import type { InvestigationList, InvestigationRecord } from '../controllers/investigation-api.ts';
import { workspaceResourceKey, type WorkspaceInventory } from '../controllers/investigations.ts';
import { hasSlidePermission } from '../app-settings.ts';
import { operationsStyles } from './operations-styles.ts';
import '../components/app-card.ts';
import '../components/app-badge.ts';
import '../components/app-empty-state.ts';
import '../components/app-form-field.ts';
import '../components/app-dialog.ts';

const freshCandidate = (): CaseCandidate => ({ investigationId: '', resultVersion: 0,
  content: { title: '', symptoms: '', faultType: '', confirmedCause: '', actions: '', actualEffect: '', counterexamples: '' },
  applicability: { conditions: '', productVersion: '', resourceVersion: '' }, validUntil: '', humanConfirmed: true });

type CandidateSource = Pick<CaseCandidate, 'investigationId' | 'resultVersion'> & { investigation?: InvestigationRecord; title?: string };
type PreparedCase = { candidate: Omit<CaseCandidate, 'humanConfirmed'>; redactionPolicyVersion: string };
const sourceKey = (id: string, version: number) => `${id}:${version}`;
const validVersion = (version: number) => Number.isSafeInteger(version) && version > 0;
const sourceDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' });

@customElement('operations-knowledge')
export class OperationsKnowledge extends LitElement {
  static styles = [operationsStyles, css`
    .source-filters { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto; gap:var(--space-sm); align-items:end; }
    .source-list { list-style:none; padding:0; margin:0; }
    .source-row { display:flex; justify-content:space-between; align-items:start; gap:var(--space-md); }
    .source-row p, .source-choice p { margin:0; }
    .source-row button { flex-shrink:0; }
    .source-choice { display:grid; gap:var(--space-xs); }
    .source-actions { display:flex; flex-wrap:wrap; gap:var(--space-sm); }
  `];
  @property({ attribute: false }) permissions: Set<string> | null = null;
  @state() private bindingConfirmed=false;
  @state() private bindingNote='';
  private stopWatch:(()=>void)|null=null;
  private destination=new OperationsResource<{id:string;version:number;latestResult:{id:string;version:number}|null}>(this,()=>{this.bindingConfirmed=false;this.bindingNote='';},authorizedJson);
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
  @state() private source: CandidateSource | null = null;
  @state() private sourceQuery = '';
  @state() private appliedSourceQuery = '';
  @state() private sourceResource = '';
  @state() private sourceNotice = '';
  @state() private preparing = false;
  @state() private preparedPolicy = '';
  private candidateGeneration = 0;
  private readonly unavailableSources = new Set<string>();
  private readonly sourcePages = new OperationsResource<InvestigationList>(this, undefined, authorizedJson);
  private readonly inventory = new OperationsResource<WorkspaceInventory>(this, undefined, authorizedJson);
  private pages = new OperationsResource<CasePage>(this, () => this.clearDrafts());
  private record = new OperationsResource<CaseRecord>(this, () => this.clearDrafts());
  private clearPreparation() {
    ++this.candidateGeneration;
    this.preparing = false;
    this.preparedPolicy = '';
    this.candidate = freshCandidate();
    this.humanConfirmed = false;
    this.formError = '';
  }
  private closeCandidate() {
    this.clearPreparation();
    this.formOpen = false;
    this.source = null;
    this.sourceQuery = '';
    this.appliedSourceQuery = '';
    this.sourceResource = '';
    this.sourceNotice = '';
    this.unavailableSources.clear();
    this.sourcePages.reset();
    this.inventory.reset();
  }
  private clearDrafts() { this.note = ''; this.closeCandidate(); }
  private can(code: string) { return hasSlidePermission(this.permissions, `operations:cases:${code}`); }
  private pop = () => { this.stopWatch?.();this.stopWatch=null; const id = new URL(location.href).searchParams.get('case') ?? ''; this.selected = id; this.record.reset(); if (id) void this.open(id, false); else { void this.search(); this.openLinkedCandidate(); } };
  connectedCallback() { super.connectedCallback(); window.addEventListener('popstate', this.pop); }
  disconnectedCallback() { this.stopWatch?.();this.stopWatch=null; window.removeEventListener('popstate', this.pop); super.disconnectedCallback(); }
  protected firstUpdated() {
    const p = new URL(location.href).searchParams;
    this.query = p.get('query')?.slice(0,200) ?? '';
    const id = p.get('case'); if (id) void this.open(id, false); else { void this.search(); this.openLinkedCandidate(); }
  }
  private async search(cursor?: string) {
    const query = new URLSearchParams({ state: this.filter, query: this.query, limit: '20' });
    if (this.resourceType) query.set('resourceType', this.resourceType);
    if (cursor) query.set('cursor', cursor);
    await this.pages.load(`/knowledge?${query}`);
  }
  private async open(id: string, push = true) {
    this.stopWatch?.();this.stopWatch=null;this.destination.reset();this.bindingConfirmed=false;this.bindingNote='';
    this.clearDrafts(); this.selected = id;
    if (push) { const u = new URL(location.href); u.searchParams.set('case', id); history.pushState({}, '', u); }
    const value=await this.record.load(`/knowledge/${encodeURIComponent(id)}`);
    if(value&&!value.tombstone&&this.selected===id) this.stopWatch=watchCase(id,record=>{
      if(this.selected!==id||this.record.accessInvalidated)return;
      if(!record){this.stopWatch?.();this.stopWatch=null;this.record.invalidate('案例订阅失效、来源撤回或授权变化，正文已清除；请只读核验。');this.pages.reset();this.destination.reset();}
      else {this.record.data=record;this.requestUpdate();}
    });
  }
  private back() {
    this.stopWatch?.();this.stopWatch=null;this.selected = ''; this.record.reset(); this.clearDrafts();
    const u = new URL(location.href); u.searchParams.delete('case'); history.pushState({}, '', u); void this.search();
  }
  private openLinkedCandidate() {
    const p = new URL(location.href).searchParams;
    const investigationId = p.get('sourceInvestigation'), version = p.get('resultVersion');
    if (!investigationId || !version || !this.can('manage') || this.record.locked || this.pages.accessInvalidated) return;
    const resultVersion = Number(version);
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(investigationId)
      && /^[1-9]\d*$/.test(version) && validVersion(resultVersion)) {
      this.startCandidate(false, { investigationId, resultVersion });
    } else {
      this.startCandidate();
      this.sourceNotice = '链接中的调查或结果版本无效，请重新选择来源。';
    }
  }
  private startCandidate(edit = false, source?: CandidateSource) {
    if (!this.can('manage') || this.record.locked) return;
    const r = this.record.data;
    this.closeCandidate();
    this.editing = edit;
    this.candidate = edit && r?.content && r.source && r.applicability ? {
      content: { ...r.content }, applicability: { ...r.applicability }, investigationId: r.source.investigationId,
      resultVersion: r.source.resultVersion, validUntil: r.validUntil, humanConfirmed: true,
    } : this.candidate;
    this.formOpen = true;
    if (edit) return;
    if (source) {
      this.source = source;
      void this.prepareCandidate();
    } else this.chooseAnotherSource();
  }
  private availableSources(page: InvestigationList | null) {
    return (page?.items ?? []).filter(row => {
      const version = row.latestOutcome?.resultVersion ?? 0;
      return row.lifecycle === 'closed' && !row.activeRequestId && row.resources.length > 0
        && validVersion(version) && !this.unavailableSources.has(sourceKey(row.id, version));
    });
  }
  private async loadSources(cursor?: string) {
    const query = new URLSearchParams({ state: 'closed', limit: '20' });
    if (!cursor) this.appliedSourceQuery = this.sourceQuery.trim();
    if (this.appliedSourceQuery) query.set('query', this.appliedSourceQuery);
    if (this.sourceResource) query.set('resource', this.sourceResource);
    // A page can contain only investigations without a result. Continue until
    // there is a selectable row or the authorized list is exhausted.
    do {
      if (cursor) query.set('cursor', cursor);
      const page = await this.sourcePages.load(`/api/investigations?${query}`);
      if (!page || page !== this.sourcePages.data || this.source || !this.formOpen || this.availableSources(page).length) return;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  private loadSourceInventory() {
    return this.inventory.load('/api/resources');
  }
  private chooseAnotherSource(notice = '') {
    this.clearPreparation();
    this.source = null;
    this.sourceNotice = notice;
    if (!this.inventory.data && !this.inventory.loading) void this.loadSourceInventory();
    void this.loadSources();
    void this.focusCandidate('#source-query');
  }
  private async focusCandidate(selector: string) {
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>(selector)?.focus();
  }
  private selectSource(row: InvestigationRecord) {
    const resultVersion = row.latestOutcome?.resultVersion ?? 0;
    if (!validVersion(resultVersion) || !this.availableSources(this.sourcePages.data).includes(row)) return;
    this.clearPreparation();
    this.sourceNotice = '';
    this.source = { investigationId: row.id, resultVersion, investigation: row };
    void this.focusCandidate('#prepare-case');
  }
  private async prepareCandidate() {
    const source = this.source;
    if (!source?.investigationId || !validVersion(source.resultVersion) || !this.formOpen
      || this.editing || this.preparing || this.record.locked || !this.can('manage')) return;
    this.clearPreparation();
    const generation = this.candidateGeneration;
    this.preparing = true;
    const query = new URLSearchParams({ investigationId: source.investigationId, resultVersion: String(source.resultVersion) });
    try {
      const { candidate, redactionPolicyVersion } = await operationsApi<PreparedCase>(`/knowledge/prepare?${query}`);
      if (generation !== this.candidateGeneration) return;
      if (candidate.investigationId !== source.investigationId || candidate.resultVersion !== source.resultVersion) {
        this.formError = '返回的来源与选择不一致，请重试读取。';
        return;
      }
      if (!source.investigation) this.source = { ...source, title: candidate.content.title };
      this.candidate = { ...candidate, humanConfirmed: true };
      this.preparedPolicy = redactionPolicyVersion;
    } catch (error) {
      if (generation !== this.candidateGeneration) return;
      if (error instanceof OperationsApiError && ([403, 404, 409, 410].includes(error.status)
        || error.code === 'OPERATIONS_PRECONDITION_FAILED' || error.code === 'OPERATIONS_INPUT_INVALID')) {
        this.unavailableSources.add(sourceKey(source.investigationId, source.resultVersion));
        this.inventory.reset();
        this.sourceResource = '';
        this.chooseAnotherSource('该来源或结果版本已不可引用，请重新选择。');
      } else {
        this.formError = `读取脱敏草稿失败。${operationsErrorText(error)}`;
      }
    } finally {
      if (generation === this.candidateGeneration) this.preparing = false;
    }
  }
  private get canSaveCandidate() {
    return this.formOpen && this.can('manage') && (this.editing || Boolean(this.preparedPolicy))
      && this.humanConfirmed && !this.record.locked && !this.preparing;
  }
  private async saveCandidate(e: Event) {
    e.preventDefault(); if (!this.canSaveCandidate) return;
    const c = this.candidate;
    if (!Number.isSafeInteger(c.resultVersion) || c.resultVersion < 1 || !Number.isFinite(Date.parse(c.validUntil))) { this.formError = '请填写有效结果版本与到期时间。'; return; }
    const body = { ...c, validUntil: new Date(c.validUntil).toISOString() };
    const r = this.record.data;
    const binding = await this.record.write<{ id: string }>(this.editing && r ? `/knowledge/${encodeURIComponent(r.id)}` : '/knowledge',
      this.editing && r ? { expectedRevision: r.revision, candidate: body } : body, this.editing ? 'PUT' : 'POST');
    if (binding) { this.formOpen = false; await this.open(binding.id); }
  }
  private async bindCase() {
    const r=this.record.data,inv=this.destination.data;
    if(!r||!inv?.latestResult||!this.bindingConfirmed)return;
    const value=await this.record.write(`/knowledge/${encodeURIComponent(r.id)}/bind`,{investigationId:inv.id,resultVersion:inv.latestResult.version,expectedVersion:inv.version,version:r.version,contentHash:r.contentHash,applicabilityConfirmed:true});
    if(value){this.bindingConfirmed=false;this.bindingNote='已绑定为历史参考；当前事实与执行权限保持独立。';this.requestUpdate();}
  }
  private bindView(r:CaseRecord) {
    const id=new URL(location.href).searchParams.get('sourceInvestigation');
    return html`<p>选择当前调查并核对适用条件，绑定只保留历史参考。</p>${id?html`<button class="btn" ?disabled=${this.destination.locked||this.record.locked} @click=${()=>this.destination.load(`/api/investigations/${encodeURIComponent(id)}`)}>核对目标调查与当前结果</button>`:html`<p class="muted">请从目标调查的“查找可信案例”入口进入。</p>`}
      ${this.destination.error?html`<p role="alert">${this.destination.error}</p>`:nothing}${this.destination.data?.latestResult?html`<p>目标调查 ${this.destination.data.id} · 当前结果 v${this.destination.data.latestResult.version}</p><label class="check"><input aria-label="确认案例适用条件" type="checkbox" .checked=${this.bindingConfirmed} @change=${(e:Event)=>this.bindingConfirmed=(e.target as HTMLInputElement).checked}>我已核对适用条件与反面证据</label><button class="btn-primary" ?disabled=${!this.bindingConfirmed||this.record.locked} @click=${this.bindCase}>绑定当前案例版本为参考</button>`:nothing}
      ${this.bindingNote?html`<p role="status">${this.bindingNote}</p>`:nothing}`;
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
          : html`<app-empty-state title="没有匹配的案例" description=${!this.query && !this.resourceType && this.filter === 'published'
            ? '当前没有可访问的已发布案例。' : '可缩短搜索词或调整状态与资源类型。'}>
            ${!this.query && !this.resourceType && this.filter === 'published' && this.can('manage') ? html`
              <button slot="actions" class="btn" ?disabled=${this.record.locked} @click=${() => this.startCandidate()}>选择来源调查</button>` : nothing}
          </app-empty-state>`}
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
        <section><h2>引用的原始记录</h2>${r.source ? html`<a href=${`/workbench?investigation=${encodeURIComponent(r.source.investigationId)}`}>查看来源调查 · 结果版本 ${r.source.resultVersion}</a><p class="muted">${r.source.evidence.length} 条来源证据，打开原记录时重新检查权限。</p>
          ${r.source.evidence.map(e=>html`<div class="row"><p>原观测 ${e.observedFrom??'未知'} — ${e.observedTo??'未知'} · 采集 ${e.collectedAt??'未知'}</p>
          <p class="notice warn">来源完整性：${e.quality?.partial===false?'非部分结果':e.quality?.partial===true?'部分结果':'部分标记未知'} · ${e.quality?.truncated===false?'未截断':e.quality?.truncated===true?'已截断':'截断标记未知'} · ${e.quality?.hasMore===true?'仍有后续数据':e.quality?.hasMore===false?'无后续页':'后续页未知'}</p>
          <p>分页窗口：offset ${e.page?.offset??'未知'} · limit ${e.page?.limit??'未知'} · 下一窗口 ${e.page?.nextOffset??'未知'}</p></div>`) }` : nothing}</section>`}
      </app-card><aside class="stack"><app-card><span slot="header">版本与审核</span><dl><dt>当前状态</dt><dd><app-badge variant=${usable ? 'ok' : 'warn'}>${operationLabels[r.state]}</app-badge></dd><dt>内容版本</dt><dd>v${r.version} · 修订 ${r.revision}</dd><dt>作者</dt><dd>#${r.author.id}</dd><dt>有效期</dt><dd>${new Date(r.validUntil).toLocaleString('zh-CN')}</dd></dl>
        <details><summary>不可变引用与技术详情</summary><pre>${JSON.stringify({id:r.id,version:r.version,contentHash:r.contentHash,reason:r.reason},null,2)}</pre></details>
        ${usable ? this.bindView(r) : html`<p class="notice warn">当前版本不能作为可信案例引用。</p>`}
        ${!r.tombstone && this.can('manage') && author ? html`<button class="btn" ?disabled=${this.record.locked} @click=${() => this.startCandidate(true)}>编辑为新版本</button>${r.state === 'draft' ? html`<button class="btn-primary" ?disabled=${this.record.locked || !validRecord(r)} @click=${() => void this.transition('submit')}>提交独立审核</button>` : nothing}` : nothing}
      </app-card>
      ${!r.tombstone && (this.can('review') && r.state === 'pending_review' || this.can('manage')) ? html`<app-card><span slot="header">人工审核与治理</span><label>审核或撤回依据<textarea aria-label="审核或撤回依据" maxlength="2000" rows="3" ?disabled=${this.record.locked} .value=${this.note} @input=${(e: Event) => this.note = (e.target as HTMLTextAreaElement).value}></textarea></label>
        ${this.can('review') && r.state === 'pending_review' ? html`<p class="muted">作者不能自审；服务端核验当前身份、版本和内容摘要。</p><button class="btn-primary" ?disabled=${this.record.locked || author || !this.note.trim() || !validRecord(r)} @click=${() => void this.transition('approved')}>审核发布当前版本</button><button class="btn" ?disabled=${this.record.locked || author || !this.note.trim()} @click=${() => void this.transition('rejected')}>驳回修改</button>` : nothing}
        ${this.can('manage') && r.state !== 'withdrawn' ? html`<button class="btn" ?disabled=${this.record.locked || !this.note.trim()} @click=${() => void this.transition('withdraw')}>撤回案例</button>` : nothing}
        ${this.formError ? html`<p role="alert">${this.formError}</p>` : nothing}</app-card>` : nothing}
      </aside></div>`;
  }
  private sourceObject(ref: CaseRecord['resources'][number]) {
    return this.inventory.data?.items.find(item => workspaceResourceKey(item.resource) === workspaceResourceKey(ref))?.label
      ?? resourceLabel(ref);
  }
  private sourceObjects(row: InvestigationRecord) {
    return row.resources.map(ref => this.sourceObject(ref)).join('、');
  }
  private sourceOptions() {
    const p = this.sourcePages;
    const rows = this.availableSources(p.data);
    const inventory = this.inventory;
    return html`<section class="stack" aria-labelledby="case-source-heading">
      <div>
        <h2 id="case-source-heading">选择来源调查与结果</h2>
        <p class="muted">请选择已关闭调查的结果版本。生成草稿前会重新核对来源权限和证据。</p>
      </div>
      ${this.sourceNotice ? html`<p role="alert">${this.sourceNotice}</p>` : nothing}
      <form class="source-filters" @submit=${(e: Event) => { e.preventDefault(); void this.loadSources(); }}>
        <label>调查标题<input id="source-query" maxlength="200" placeholder="搜索调查标题" .value=${this.sourceQuery}
          @input=${(e: Event) => this.sourceQuery = (e.target as HTMLInputElement).value}></label>
        <label>调查对象<select .value=${this.sourceResource} ?disabled=${inventory.loading || !inventory.data}
          @change=${(e: Event) => { this.sourceResource = (e.target as HTMLSelectElement).value; void this.loadSources(); }}>
          <option value="">全部对象</option>
          ${(inventory.data?.items ?? []).map(item => html`<option value=${workspaceResourceKey(item.resource)}>${item.label} · ${resourceLabel(item.resource)}</option>`)}
        </select></label>
        <button class="btn" type="submit" ?disabled=${p.accessInvalidated}>查找调查</button>
      </form>
      ${inventory.error || inventory.data?.dataQuality === 'partial' ? html`
        <div role="status" class="muted">调查对象名称${inventory.error ? '读取失败' : '列表不完整'}，仍可按调查标题查找。
          <button class="btn btn-refresh" type="button" ?disabled=${inventory.loading || inventory.accessInvalidated} @click=${this.loadSourceInventory}>重试读取对象</button>
        </div>` : nothing}
      ${p.loading ? html`<p role="status">正在读取来源调查…</p>` : nothing}
      ${p.error ? html`<div role="alert"><p>读取来源调查失败。${p.error}</p>
        <button class="btn btn-refresh" type="button" ?disabled=${p.accessInvalidated} @click=${() => this.loadSources()}>重试读取调查</button>
      </div>` : nothing}
      ${rows.length ? html`<ul class="source-list">${rows.map(row => {
        const version = row.latestOutcome!.resultVersion, objects = this.sourceObjects(row);
        return html`<li class="row source-row">
          <div><strong>${row.title}</strong><p>${objects}</p>
            <p class="muted">创建于 ${sourceDate.format(new Date(row.createdAt))} · ${row.id}</p></div>
          <button class="btn" type="button" aria-label=${`选择结果 V${version} · ${row.title} · ${objects} · ${row.id}`}
            @click=${() => this.selectSource(row)}>选择结果 V${version}</button>
        </li>`;
      })}</ul>` : p.data && !p.data.nextCursor ? html`<app-empty-state
        title=${this.appliedSourceQuery || this.sourceResource ? '没有匹配的调查' : '暂无可用的来源调查'}
        description=${this.appliedSourceQuery || this.sourceResource
          ? '可缩短搜索词或切换调查对象。' : '来源需要是当前可访问、已关闭且有调查结果的记录。'}></app-empty-state>` : nothing}
      ${rows.length && p.data?.nextCursor ? html`<div><button class="btn" type="button"
        @click=${() => void this.loadSources(p.data?.nextCursor ?? undefined)}>下一页调查</button></div>` : nothing}
    </section>`;
  }
  private selectedSource() {
    const source = this.source!;
    return html`<section class="source-choice" aria-labelledby="case-source-heading">
      <h2 id="case-source-heading">已选来源 · 结果 V${source.resultVersion}</h2>
      ${source.investigation ? html`<p><strong>${source.investigation.title}</strong></p>
        <p>${this.sourceObjects(source.investigation)}</p>` : source.title ? html`<p><strong>${source.title}</strong></p>` : nothing}
      <p class="muted">调查 ${source.investigationId}</p>
      <div class="source-actions">
        ${!this.preparedPolicy ? html`<button id="prepare-case" class="btn-primary" type="button"
          ?disabled=${this.preparing || this.record.locked}
          @click=${this.prepareCandidate}>读取来源生成脱敏草稿</button>` : nothing}
        <button class="btn" type="button" ?disabled=${this.record.writing} @click=${() => this.chooseAnotherSource()}>重新选择来源</button>
      </div>
      ${this.preparing ? html`<p role="status">正在读取结果 V${source.resultVersion}，生成脱敏草稿…</p>` : nothing}
      ${!this.preparedPolicy && this.formError ? html`<p role="alert">${this.formError}</p>` : nothing}
    </section>`;
  }
  private candidateEditor() {
    const c = this.candidate;
    const field = (name: string, value: string, change: (v: string) => void, max = 4000) => html`<label>${name}<textarea aria-label=${name} required maxlength=${max} rows="2" .value=${value} ?disabled=${this.record.locked} @input=${(e: Event) => change((e.target as HTMLTextAreaElement).value)}></textarea></label>`;
    return html`<form id="case-candidate" class="form" @submit=${this.saveCandidate}>
        ${this.editing ? html`<p class="muted">来源调查 ${c.investigationId} · 结果 V${c.resultVersion}</p>`
          : html`<p role="status" class="muted">已生成脱敏草稿 · ${this.preparedPolicy}</p>`}
        <p>请人工核实来源、处理效果和脱敏内容。保存草稿后仍需独立审核。</p>
        ${Object.entries({title:'案例标题',symptoms:'问题现象',faultType:'故障类型',confirmedCause:'已确认原因',actions:'实际处理',actualEffect:'实际效果',counterexamples:'反面证据与不适用条件'}).map(([key,label]) => field(label,c.content[key as keyof typeof c.content],v => this.candidate = {...this.candidate,content:{...this.candidate.content,[key]:v}}, key === 'title' ? 200 : key === 'faultType' ? 100 : 4000))}
        ${Object.entries({conditions:'适用条件',productVersion:'产品版本',resourceVersion:'资源版本'}).map(([key,label]) => field(label,c.applicability[key as keyof typeof c.applicability],v => this.candidate = {...this.candidate,applicability:{...this.candidate.applicability,[key]:v}},key === 'conditions' ? 4000 : 128))}
        <label>有效期至<input aria-label="有效期至" type="datetime-local" step="0.001" required .value=${c.validUntil ? localDate(c.validUntil) : ''} ?disabled=${this.record.locked} @input=${(e: Event) => this.candidate = {...c,validUntil:(e.target as HTMLInputElement).value}}></label>
        <label class="check"><input type="checkbox" required .checked=${this.humanConfirmed} ?disabled=${this.record.locked} @change=${(e: Event) => this.humanConfirmed = (e.target as HTMLInputElement).checked}>我已人工确认来源结果、处理效果与脱敏内容</label>
        ${this.formError ? html`<p role="alert">${this.formError}</p>` : nothing}${this.status(this.record)}
      </form>`;
  }
  private candidateForm() {
    const showEditor = this.editing || Boolean(this.preparedPolicy);
    return html`<app-dialog .open=${this.formOpen} size="lg" title=${this.editing ? '编辑为新案例版本' : '从调查整理案例'}
      .closable=${!this.record.writing} @app-dialog-close=${this.closeCandidate}>
      ${this.formOpen ? html`<div class="stack">
        ${!this.editing ? this.source ? this.selectedSource() : this.sourceOptions() : nothing}
        ${showEditor ? this.candidateEditor() : nothing}
      </div>
      <div slot="footer">
        <button class="btn" ?disabled=${this.record.writing} @click=${this.closeCandidate}>取消</button>
        ${showEditor ? html`<button class="btn-primary" ?disabled=${!this.canSaveCandidate}
          @click=${() => this.renderRoot.querySelector<HTMLFormElement>('#case-candidate')?.requestSubmit()}>保存案例草稿</button>` : nothing}
      </div>` : nothing}
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
