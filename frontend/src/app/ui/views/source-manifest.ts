import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { sourceError, readSourceResponse, renderSourceError, type SourceError } from './source-errors.js';
import { tabKeydown, workspaceStyles, fmt, badge, table, pairs } from './workspace-ui.js';
import { authFetch } from '../../../api/index.js';
import { permissionMatches } from '../settings-navigation.js';

interface Manifest {
  releaseId: string; commitSha: string; treeDigest: string; files: Array<{ path: string; digest: string; bytes: number }>; signature: string;
  completeness?: 'complete' | 'partial'; skippedFiles?: Array<{ path: string; reason: string }>;
  warnings?: Array<{ path: string; reason: string }>;
  verification?: { status: 'repository-unbound' | 'deployment-verified'; reason?: string };
  repository?: { origin: string; ref: string };
}
const reasons: Record<string, string> = {
  SOURCE_SENSITIVE_CONTENT: '含疑似敏感信息', SOURCE_FILE_TOO_LARGE: '超过快照容量上限',
  SOURCE_LARGE_FILE: '较大文件，已保留，可按片段读取', SOURCE_BINARY_FILE: '非文本内容',
  SOURCE_CONFIG_UNSCANNABLE: '配置文件无法解析，已保留原文', SOURCE_PATH_INVALID: '不在可读源码范围', SOURCE_SYMLINK_SKIPPED: '符号链接',
  SOURCE_DEPLOYMENT_UNKNOWN: '未提供完整部署版本信息', SOURCE_COMMIT_MISMATCH: '仓库提交与部署提交不同',
  SOURCE_TREE_MISMATCH: '源码范围或内容与部署记录不同', SOURCE_SNAPSHOT_PARTIAL: '部分文件已跳过',
};
@customElement('source-manifest')
export class SourceManifestView extends LitElement {
  @property({ type: Number }) revision = 0;
  @state() private manifest: Manifest | null = null;
  @state() private error: SourceError | null = null;
  @state() private loading = true;
  private requestVersion = 0;
  @state() private detailsView = false;
  @state() private kind: 'files' | 'skipped' | 'warnings' = 'files';
  @state() private query = '';
  @state() private reason = '';
  @state() private page = 0;
  @state() private pageSize = 10;
  @state() private dialog: 'metadata' | 'item' | '' = '';
  @state() private selectedItem: { path: string; digest?: string; bytes?: number; reason?: string } | null = null;
  private summaryScroll = 0;
  private popState = () => this.readUrl();
  private readonly onExpired = () => { this.invalidate(); this.loading = false; this.error = sourceError('SOURCE_SESSION_REQUIRED'); };
  private readonly onPermissions = (event: Event) => {
    const codes = (event as CustomEvent<{ permissions?: string[] }>).detail?.permissions;
    if (permissionMatches(new Set(Array.isArray(codes) ? codes : []), 'config:view')) void this.load();
    else { this.invalidate(); this.loading = false; this.error = sourceError('SOURCE_READ_FORBIDDEN'); }
  };
  static styles = [sharedFieldStyles, sharedBtnStyles, workspaceStyles];
  override connectedCallback() {
    super.connectedCallback(); this.readUrl(); window.addEventListener('popstate', this.popState);
    window.addEventListener('slide-session-expired', this.onExpired);
    window.addEventListener('slide-permissions-loaded', this.onPermissions);
    if (this.hasUpdated) void this.load();
  }
  private readUrl() {
    const params = new URL(location.href).searchParams;
    this.detailsView = params.get('sourceView') === 'details';
    const kind = params.get('sourceKind'); this.kind = kind === 'skipped' || kind === 'warnings' ? kind : 'files';
    this.query = params.get('sourceQuery') ?? ''; this.reason = params.get('sourceReason') ?? '';
    const size = Number(params.get('sourceSize')); this.pageSize = [10,25,50].includes(size) ? size : 10;
    const page = Number(params.get('sourcePage')); this.page = Number.isSafeInteger(page) && page >= 0 ? page : 0;
    this.dialog = ''; this.selectedItem = null;
    this.dispatchEvent(new CustomEvent('source-view-change', { bubbles: true, composed: true }));
  }
  private saveUrl(push = false) {
    const url = new URL(location.href);
    if (this.detailsView) url.searchParams.set('sourceView', 'details'); else url.searchParams.delete('sourceView');
    for (const [name,value] of Object.entries({ sourceKind:this.kind, sourceQuery:this.query, sourceReason:this.reason, sourcePage:String(this.page), sourceSize:String(this.pageSize) })) {
      if (value) url.searchParams.set(name,value); else url.searchParams.delete(name);
    }
    history[push ? 'pushState' : 'replaceState'](history.state, '', url);
    this.dispatchEvent(new CustomEvent('source-view-change', { bubbles: true, composed: true }));
  }
  private async browse(kind = this.kind) {
    this.summaryScroll = this.scrollParent()?.scrollTop ?? 0;
    if (kind !== this.kind) { this.kind = kind; this.query = ''; this.reason = ''; this.page = 0; }
    this.detailsView = true; this.saveUrl(true); await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>('h1')?.focus();
  }
  private scrollParent(): Element | null {
    let element: Element | null = this;
    while (element) {
      if (getComputedStyle(element).overflowY.match(/auto|scroll/) && element.scrollHeight > element.clientHeight) return element;
      const root: Node = element.getRootNode();
      element = element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return document.scrollingElement;
  }
  private async back() {
    this.detailsView = false; this.saveUrl(true); await this.updateComplete;
    this.renderRoot.querySelector<HTMLButtonElement>('[data-browse]')?.focus();
    const parent = this.scrollParent(); if (parent) parent.scrollTop = this.summaryScroll;
  }
  private invalidate() {
    const restoreFocus = !!this.dialog;
    this.requestVersion++; this.manifest = null; this.dialog = ''; this.selectedItem = null;
    if (restoreFocus) void this.restoreInvalidatedFocus(this.requestVersion);
  }
  private async restoreInvalidatedFocus(version: number) {
    await this.updateComplete;
    await (this.renderRoot.querySelector('app-dialog') as LitElement | null)?.updateComplete;
    // The original trigger was removed with its snapshot; keep keyboard users
    // at the current manifest rather than returning focus to a detached row.
    if (this.isConnected && version === this.requestVersion && !this.dialog) {
      this.tabIndex = -1; this.focus();
    }
  }
  protected override willUpdate(changed: Map<string, unknown>) { if (changed.has('revision')) void this.load(); }
  override disconnectedCallback() {
    this.invalidate(); window.removeEventListener('popstate', this.popState);
    window.removeEventListener('slide-session-expired', this.onExpired);
    window.removeEventListener('slide-permissions-loaded', this.onPermissions);
    super.disconnectedCallback();
  }
  private async load() {
    this.invalidate();
    const version = this.requestVersion; this.loading = true; this.error = null;
    try {
      const body = await readSourceResponse(await authFetch('/api/platform/source/manifest'));
      if (version === this.requestVersion && this.isConnected) this.manifest = body;
    } catch (error) { if (version === this.requestVersion) this.error = sourceError(error instanceof TypeError ? 'SOURCE_NETWORK_ERROR' : error); }
    finally { if (version === this.requestVersion) this.loading = false; }
  }
  private entries() {
    const m = this.manifest;
    return this.kind === 'files' ? m?.files ?? [] : this.kind === 'skipped' ? m?.skippedFiles ?? [] : m?.warnings ?? [];
  }
  private renderDetails() {
    const all = this.entries();
    const filtered = all.filter(item => item.path.toLowerCase().includes(this.query.toLowerCase()) && (!this.reason || ('reason' in item && item.reason === this.reason)));
    const pages = Math.ceil(filtered.length / this.pageSize);
    const page = Math.min(this.page, Math.max(0, pages - 1));
    return html`<button class="btn-ghost detail-back" @click=${this.back}>← 返回源码仓库</button>
      <div class="page-header"><div><h1 tabindex="-1">源码快照明细</h1><p class="muted small">${this.manifest?.releaseId} · ${this.manifest?.repository?.ref} · ${this.manifest?.commitSha?.slice(0,8)}</p></div><button class="btn" @click=${() => { this.dialog = 'metadata'; }}>版本元数据</button></div>
      <div class="tabs" role="tablist" @keydown=${tabKeydown} aria-label="快照条目类型">${(['files','skipped','warnings'] as const).map((kind,index) => html`<button class="tab" role="tab" id=${`source-tab-${kind}`} aria-controls="source-panel" tabindex=${this.kind === kind ? 0 : -1} aria-selected=${this.kind === kind} @click=${() => { this.kind = kind; this.query = ''; this.reason = ''; this.page = 0; this.saveUrl(); }}>${['文件','已跳过','提示'][index]}<span>${fmt((kind === 'files' ? this.manifest?.files : kind === 'skipped' ? this.manifest?.skippedFiles : this.manifest?.warnings)?.length ?? 0)}</span></button>`)}</div>
      <div id="source-panel" role="tabpanel" aria-labelledby=${`source-tab-${this.kind}`}><div class="toolbar"><app-form-field label="路径搜索"><input type="search" aria-label="搜索文件路径" placeholder="搜索目录或文件名…" .value=${this.query} @input=${(event: Event) => { this.query = (event.target as HTMLInputElement).value; this.page = 0; this.saveUrl(); }}></app-form-field>
      ${this.kind !== 'files' ? html`<app-form-field class="filter" label="原因筛选"><select aria-label="筛选原因" .value=${this.reason} @change=${(event: Event) => { this.reason = (event.target as HTMLSelectElement).value; this.page = 0; this.saveUrl(); }}><option value="" .selected=${!this.reason}>全部原因</option>${[...new Set(all.flatMap(item => 'reason' in item ? [item.reason] : []))].map(reason => html`<option value=${reason} .selected=${this.reason === reason}>${reasons[reason] ?? reason}</option>`)}</select></app-form-field>` : nothing}
      <button class="btn" @click=${() => { this.query = ''; this.reason = ''; this.page = 0; this.saveUrl(); }}>重置</button></div>
      <p class="caption">${this.kind === 'files' ? '文件内容未在此页面展开，仅展示快照清单。' : this.kind === 'skipped' ? '以下条目未纳入快照；不会显示被跳过的文件内容。' : '以下文件已保留，可查看具体读取提示。'}</p>
      <app-card .compact=${true}>${table([{key:'path',label:'文件路径',width:'61%'},{key:'info',label:this.kind === 'files' ? '大小' : '原因',width:'28%'},{key:'action',label:'详情',width:'11%'}], filtered.slice(page * this.pageSize, (page + 1) * this.pageSize).map(item => ({ path:html`<span class="mono">${item.path}</span>`, info:'reason' in item ? reasons[item.reason] ?? item.reason : `${fmt(item.bytes)} B`, action:html`<button class="link" @click=${() => { this.selectedItem = item; this.dialog = 'item'; }}>查看</button>` })), all.length ? '没有匹配的条目' : '暂无条目')}
      <div class="paging"><span>共 ${fmt(filtered.length)} 项 / 全部 ${fmt(all.length)} 项</span><div class="row"><label>每页 <select aria-label="每页文件数" .value=${String(this.pageSize)} @change=${(event: Event) => { this.pageSize = Number((event.target as HTMLSelectElement).value); this.page = 0; this.saveUrl(); }}>${[10,25,50].map(size => html`<option value=${size} .selected=${this.pageSize === size}>${size}</option>`)}</select></label><button class="btn-ghost" ?disabled=${page === 0} @click=${() => { this.page = page - 1; this.saveUrl(); }}>上一页</button><span>${pages ? page + 1 : 0} / ${pages}</span><button class="btn-ghost" ?disabled=${page + 1 >= pages} @click=${() => { this.page = page + 1; this.saveUrl(); }}>下一页</button></div></div></app-card></div>`;
  }
  override render() {
    const m = this.manifest;
    return html`${this.loading ? html`<div class="loading-line" role="status" aria-label="加载源码清单"></div>` : nothing}${renderSourceError(this.error)}${this.error?.recovery === 'retry' ? html`<button class="btn" .disabled=${this.loading} @click=${this.load}>重试加载快照</button>` : nothing}
      ${m ? this.detailsView ? this.renderDetails() : html`
        <div class="notice ${m.verification?.status === 'deployment-verified' ? 'neutral' : ''}" role="status"><div><strong>${m.verification?.status === 'deployment-verified' ? '已验证部署一致性' : '未验证部署一致性'}</strong>${m.verification?.reason ? reasons[m.verification.reason] ?? '未知验证状态' : ''}。此快照可用于理解实现，不能证明当前服务的运行行为。</div></div>
        <app-card><span slot="header">仓库源码快照</span><div class="snapshot"><div><div class="snapshot-title"><h2>${m.repository?.ref ?? '仓库源码'}</h2>${badge(m.completeness === 'partial' ? '部分同步' : '同步完成', m.completeness === 'partial' ? 'warn' : 'ok')}</div><p class="caption">${m.commitSha?.slice(0,8)} · ${m.releaseId}</p></div><button data-browse class="btn-primary" @click=${() => this.browse()}>浏览快照 →</button></div>
        <div class="snapshot-counts">${[[m.files.length,'已纳入文件'],[m.skippedFiles?.length ?? 0,'已跳过'],[m.warnings?.length ?? 0,'保留提示']].map(([count,label]) => html`<div><span class="number">${fmt(Number(count))}</span><span class="caption">${label}</span></div>`)}</div>
        <div class="details-line"><span class="caption">列表按页浏览；跳过项与提示分开展示。</span><button class="link small" @click=${() => { this.dialog = 'metadata'; }}>查看版本元数据</button></div></app-card>
        <div class="section-head"><h2>同步结果</h2></div><app-card .compact=${true}>${table([{key:'type',label:'分类',width:'22%'},{key:'meaning',label:'处理结果',width:'55%'},{key:'action',label:'操作',width:'23%'}],[{type:html`${badge('已跳过','warn')} ${fmt(m.skippedFiles?.length ?? 0)}`,meaning:'未纳入快照，可按跳过原因筛选。',action:html`<button class="link" @click=${() => this.browse('skipped')}>查看跳过项 →</button>`},{type:html`${badge('提示','info')} ${fmt(m.warnings?.length ?? 0)}`,meaning:'文件已保留，读取时需留意提示。',action:html`<button class="link" @click=${() => this.browse('warnings')}>查看提示 →</button>`}])}</app-card>` : nothing}
      <app-dialog .open=${!!m && !!this.dialog} size="xl" title=${this.dialog === 'metadata' ? '源码快照 · 版本元数据' : '快照条目详情'} @app-dialog-close=${() => { this.dialog = ''; this.selectedItem = null; }}>
        ${this.dialog === 'metadata' && m ? html`${pairs([['快照',m.releaseId],['分支或引用',m.repository?.ref ?? '未知'],['完整性',m.completeness === 'partial' ? '部分同步' : '同步完成'],['部署一致性',m.verification?.status === 'deployment-verified' ? '已验证' : '未验证']])}<dl class="metadata"><dt>Commit</dt><dd>${m.commitSha}</dd><dt>Tree digest</dt><dd>${m.treeDigest}</dd><dt>签名</dt><dd>${m.signature}</dd><dt>仓库来源</dt><dd>${m.repository?.origin ?? '未知'}</dd><dt>部署验证提示</dt><dd>${m.verification?.reason ?? '无'}</dd></dl>` : this.selectedItem ? html`<p class="mono">${this.selectedItem.path}</p>${pairs([['处理结果',this.kind === 'skipped' ? '未纳入快照' : '文件已保留'],['原因',this.selectedItem.reason ? reasons[this.selectedItem.reason] ?? this.selectedItem.reason : '已纳入快照']])}${this.kind !== 'skipped' ? html`${pairs([['大小',this.selectedItem.bytes !== undefined ? `${fmt(this.selectedItem.bytes)} B` : '清单未提供']])}<dl class="metadata"><dt>文件摘要</dt><dd>${this.selectedItem.digest ?? m?.files.find(file => file.path === this.selectedItem?.path)?.digest ?? '清单未提供'}</dd></dl>` : nothing}` : nothing}
        <div slot="footer"><button class="btn" @click=${() => { this.dialog = ''; this.selectedItem = null; }}>关闭</button></div>
      </app-dialog>`;
  }
}
