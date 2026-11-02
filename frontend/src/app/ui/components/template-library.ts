import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { TemplateLibrary, TemplateCapabilities, TemplateEditor, TemplateAuthoringResult } from '../../../api/generated/public-api.js';
import { metricRequest, MetricRequestError } from './metric-api.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { sharedFieldStyles } from '../../styles/shared-field-styles.js';
import './app-card.js';
import './app-dialog.js';
import './app-form-field.js';
import './app-empty-state.js';
import './app-data-table.js';

const labels: Record<string, string> = { instance: '数据库', server: '服务器', network_device: '网络设备' };
const messages: Record<string, string> = {
  TEMPLATE_NAME_EMPTY: '名称不能为空', TEMPLATE_INVALID_PERIOD: '周期必须为 1～86400 秒的整数',
  TEMPLATE_METRIC_DUPLICATE: '同一指标不能重复添加', TEMPLATE_REVISION_CONFLICT: '模板已被其他操作更新，请刷新后核对',
  TEMPLATE_DRAFT_CONFLICT: '草稿已被其他操作更新，请刷新后核对', TEMPLATE_FORBIDDEN: '没有编辑权限；内置模板请先复制',
  TEMPLATE_EMPTY: '至少选择一个已注册监控项', TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE: '语义变化与原监控项不兼容，请新增监控项以保留历史边界',
};

@customElement('template-library')
export class NativeTemplateLibrary extends LitElement {
  @state() private library: TemplateLibrary | null = null;
  @state() private capabilities: TemplateCapabilities | null = null;
  @state() private editor: TemplateEditor | null = null;
  @state() private search = '';
  @state() private type = '';
  @state() private origin = '';
  @state() private name = '';
  @state() private copyName = '';
  @state() private candidate = '';
  @state() private metricSearch = '';
  @state() private period = 60;
  @state() private version = 0;
  @state() private busy = false;
  @state() private error = '';
  @state() private notice = '';
  @state() private dirty = false;
  @state() private retry: (() => Promise<void>) | null = null;
  @state() private itemNames: Record<string, string> = {};
  private get unsaved() {
    return this.dirty || !!this.editor && (this.name !== this.editor.template.name
      || this.editor.draft.aggregate.items.some(ref => {
        const item = this.editor!.items.find(item => item.item_id === ref.item_id && item.version === ref.version);
        return item && (this.itemNames[item.item_id] ?? item.display_name) !== item.display_name;
      }));
  }
  private openerId = '';
  private generation = 0;
  private readonly revoked = () => {
    this.generation++; this.editor = null; this.library = null; this.capabilities = null; this.retry = null; this.itemNames = {}; this.name = ''; this.dirty = false; this.notice = ''; this.candidate = '';
    this.error = '登录或权限已变更，请刷新模板库'; this.busy = false;
  };
  static styles = [sharedBtnStyles, sharedFieldStyles, css`
    :host{display:block;color:var(--text)}
    .toolbar,.actions{display:flex;align-items:end;gap:var(--space-md);flex-wrap:wrap;margin-block:var(--space-md)}
    app-form-field{flex:1;min-width:10rem} h2,h3{color:var(--text-strong)}
    .metadata{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-md)}
    .item{border-bottom:1px solid var(--border);padding-block:var(--space-md)}
    small{display:block;color:var(--muted);overflow-wrap:anywhere} pre{white-space:pre-wrap;overflow-wrap:anywhere}
    input,select{box-sizing:border-box;max-width:100%;width:100%;min-height:var(--control-height);padding:var(--space-sm);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);background-color:var(--bg)}
    .actions>input,.actions>select{flex:1;min-width:12rem;width:auto}
    :focus-visible{outline:2px solid var(--accent);outline-offset:2px} a{color:var(--accent)}
    input:disabled,select:disabled{opacity:.65} .error{color:var(--danger,var(--text))}
    .scroll{overflow:auto;max-height:26rem} .notice{padding:var(--space-md);background:var(--bg-hover);border-radius:var(--radius-sm)}
  `];
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.revoked);
    window.addEventListener('slide-session-expired', this.revoked);
    void this.load();
  }
  override disconnectedCallback() {
    this.generation++;
    window.removeEventListener('slide-permissions-loaded', this.revoked);
    window.removeEventListener('slide-session-expired', this.revoked);
    super.disconnectedCallback();
  }
  private failure(error: unknown) {
    const text = error instanceof MetricRequestError ? error.code ?? error.message : error instanceof Error ? error.message : String(error);
    this.error = Object.entries(messages).find(([code]) => text.includes(code))?.[1] ?? `操作未完成：${text}`;
  }
  private readFailure(error: unknown) {
    if (error instanceof MetricRequestError && [401, 403].includes(error.status)) this.revoked();
    else this.failure(error);
  }
  private async load() {
    const generation = ++this.generation; this.error = ''; this.busy = true;
    try {
      const [library, capabilities] = await Promise.all([
        metricRequest<TemplateLibrary>('templates/library'), metricRequest<TemplateCapabilities>('templates/capabilities'),
      ]);
      if (generation !== this.generation) return;
      this.library = library; this.capabilities = capabilities;
      if (this.editor) this.editor = { ...this.editor, can_manage: library.can_manage };
    } catch (error) { if (generation === this.generation) this.readFailure(error); }
    finally { if (generation === this.generation) this.busy = false; }
  }
  private async open(id: string) {
    const generation = ++this.generation; this.busy = true; this.error = ''; this.notice = '';
    try {
      const editor = await metricRequest<TemplateEditor>(`templates/${encodeURIComponent(id)}/editor`);
      if (generation !== this.generation) return;
      this.editor = editor; this.name = editor.template.name; this.copyName = `${editor.template.name} 副本`.slice(0,128);
      this.period = Number(editor.draft.aggregate.parameters.defaults.interval_ms ?? 60000) / 1000;
      this.version = 0; this.itemNames = {}; this.dirty = false; this.candidate = '';
    } catch (error) { if (generation === this.generation) this.readFailure(error); }
    finally { if (generation === this.generation) this.busy = false; }
  }
  private async mutate(action: string, body: Record<string, unknown>, done: (result: TemplateAuthoringResult) => Promise<void> | void) {
    if (!this.editor) return;
    const path = `templates/${encodeURIComponent(this.editor.template.template_id)}/${action}`;
    const intent = { ...body, operation_key: crypto.randomUUID() };
    const generation = this.generation;
    const run = async () => {
      this.busy = true; this.error = '';
      try {
        const result = await metricRequest<TemplateAuthoringResult>(path, intent);
        if (generation !== this.generation) return;
        this.retry = null; await done(result);
      } catch (error) { if (generation === this.generation) { if (error instanceof MetricRequestError && error.status === 401) this.revoked();
        else if (error instanceof MetricRequestError && error.status === 403 && (action === 'copy' || !this.editor?.builtin)) {
          this.generation++; this.busy = false; this.retry = null;
          if (this.editor) this.editor = { ...this.editor, can_manage: false };
          if (this.library) this.library = { ...this.library, can_manage: false };
          this.error = '编辑权限已被拒绝；可重新读取草稿恢复权限状态（放弃未保存修改）';
        } else { this.failure(error); this.retry = error instanceof MetricRequestError && error.status < 500 ? null : run; } } }
      finally { if (generation === this.generation) this.busy = false; }
    };
    await run();
  }
  private copy() {
    if (!this.copyName.trim()) { this.error = '名称不能为空'; return; }
    return this.mutate('copy', { name: this.copyName }, async result => {
      await this.open(result.template!.template_id); await this.load(); this.notice = '已复制为自定义草稿，尚未发布';
    });
  }
  private add() {
    const candidate = this.capabilities?.candidates[Number(this.candidate)];
    if (!this.editor || this.candidate === '' || !candidate) return;
    const selected = this.editor.draft.aggregate.items.map(ref => this.editor!.items.find(item => item.item_id === ref.item_id && item.version === ref.version));
    if (selected.some(item => item?.canonical_metric.id === candidate.metric.id && item.canonical_metric.semantic_version === candidate.metric.semantic_version)) {
      this.error = '同一指标不能重复添加'; return;
    }
    return this.mutate('item', { package: candidate.package, metric: candidate.metric }, result => {
      const editor = this.editor!; const refs = [...editor.draft.aggregate.items, { item_id: result.item!.item_id, version: result.item!.version }].sort((a,b) => a.item_id.localeCompare(b.item_id));
      if (!editor.draft.aggregate.items.length) this.period = candidate.default_interval_ms / 1000;
      this.editor = { ...editor, items: [...editor.items, result.item!], draft: { ...editor.draft, aggregate: { ...editor.draft.aggregate, items: refs } } };
      this.dirty = true; this.notice = '已带入标识、单位、类型、维度、周期建议和采集映射；请保存草稿';
    });
  }
  private save() {
    if (!this.editor) return;
    if (!Number.isInteger(this.period) || this.period < 1 || this.period > 86400) { this.error = messages.TEMPLATE_INVALID_PERIOD; return; }
    const aggregate = structuredClone(this.editor.draft.aggregate);
    aggregate.parameters.schema.interval_ms = { type: 'integer', min: 1000, max: 86400000 };
    aggregate.parameters.defaults.interval_ms = this.period * 1000;
    return this.mutate('draft', { expected_draft_revision: this.editor.draft.revision, aggregate }, result => {
      this.editor = { ...this.editor!, draft: result.draft! }; this.dirty = false; this.notice = '草稿已保存，已发布版本保持不变';
    });
  }
  private renameItem(item: TemplateEditor['items'][number], name: string) {
    if (!name.trim()) { this.error = '名称不能为空'; return; }
    const release = item.collector_ref.package_release, at = release.lastIndexOf('@'), hash = release.lastIndexOf('#');
    return this.mutate('item', { item_id: item.item_id, display_name: name, metric: item.canonical_metric,
      package: { id: release.slice(0,at), version: release.slice(at+1,hash), digest: release.slice(hash+1) } }, result => {
      const editor = this.editor!;
      this.editor = { ...editor, items: [...editor.items.filter(i => i.item_id !== item.item_id), result.item!],
        draft: { ...editor.draft, aggregate: { ...editor.draft.aggregate, items: editor.draft.aggregate.items.map(ref => ref.item_id === item.item_id ? { item_id: ref.item_id, version: result.item!.version } : ref) } } };
      const { [item.item_id]: _saved, ...pending } = this.itemNames; this.itemNames = pending;
      this.dirty = true; this.notice = '显示名已更新，稳定身份保留；请保存草稿';
    });
  }
  private async close() {
    if (this.busy || this.retry) return;
    if (this.unsaved) { this.notice = '有未保存的草稿，请先保存或点击“放弃未保存修改”'; return; }
    this.editor = null;
    await this.updateComplete;
    await (this.renderRoot.querySelector('app-dialog') as LitElement | null)?.updateComplete;
    const opener = Array.from(this.renderRoot.querySelectorAll<HTMLButtonElement>('button[data-template-id]'))
      .find(button => button.dataset.templateId === this.openerId);
    (opener ?? this.renderRoot.querySelector<HTMLButtonElement>('.btn-refresh'))?.focus();
  }
  override render() {
    const rows = this.library?.templates.filter(row => (!this.type || row.resource_types.includes(this.type as any))
      && (!this.origin || (this.origin === 'builtin') === row.builtin)
      && `${row.template.name} ${row.template.template_id}`.toLowerCase().includes(this.search.toLowerCase())) ?? [];
    return html`<app-card><h2 slot="header">原生监控模板</h2>
      <p>从已注册能力建设模板，保存草稿后发布不可变版本。资源绑定在资源采集配置中完成。</p>
      <p>注册实现不代表目标已验证可采集；目标系统版本、权限与采集结果需在资源绑定时核验。</p>
      <div class="toolbar">
        <app-form-field label="搜索模板"><input aria-label="搜索模板" type="search" .value=${this.search} @input=${(e: Event) => this.search = (e.target as HTMLInputElement).value}></app-form-field>
        <app-form-field label="资源类型"><select aria-label="资源类型" @change=${(e: Event) => this.type = (e.target as HTMLSelectElement).value}><option value="">全部类型</option>${Object.entries(labels).map(([value,label]) => html`<option value=${value}>${label}</option>`)}</select></app-form-field>
        <app-form-field label="模板来源"><select aria-label="模板来源" @change=${(e: Event) => this.origin = (e.target as HTMLSelectElement).value}><option value="">全部来源</option><option value="builtin">内置</option><option value="custom">自定义</option></select></app-form-field>
        <button class="btn btn-refresh" ?disabled=${this.busy || !!this.retry} @click=${this.load}>刷新模板库</button>
      </div>
      ${this.error && !this.editor ? html`<p role="alert">${this.error}</p>` : nothing}
      ${!this.library ? html`<p role="status">${this.busy ? '正在读取模板' : '模板尚未加载'}</p>` : html`
      <app-data-table .columns=${[{ key:'name',label:'模板' },{ key:'type',label:'类型' },{ key:'state',label:'版本与状态' },{ key:'action',label:'操作' }]}
        .rows=${rows.map(row => ({ name: html`<strong>${row.template.name}</strong><small>${row.builtin ? '内置' : '自定义'} · ${row.item_count} 个监控项</small>`,
          type: row.resource_types.map(type => labels[type]).join(' / '), state: row.template.current_published_version ? `已发布 v${row.template.current_published_version}` : '草稿，尚未发布',
          action: html`<button class="btn btn-sm btn-ghost" data-template-id=${row.template.template_id} @click=${() => { this.openerId = row.template.template_id; void this.open(row.template.template_id); }}>查看与编辑</button>` }))}></app-data-table>
      ${!rows.length ? html`<app-empty-state title="没有匹配的原生模板" description="调整筛选；内置模板需由管理员完成已批准的定版模板初始化。"></app-empty-state>` : nothing}`}
      </app-card>
      <app-dialog .open=${!!this.editor} title="原生模板详情" size="wide" .closable=${!this.busy && !this.retry} @app-dialog-close=${(event: Event) => { event.preventDefault(); this.close(); }}>${this.renderEditor()}</app-dialog>`;
  }
  private renderEditor() {
    const editor = this.editor; if (!editor) return nothing;
    const canEdit = editor.can_manage && !editor.builtin && !this.version;
    const editable = canEdit && !this.busy && !this.retry;
    const snapshot = this.version ? editor.versions.find(v => v.version === this.version) : null;
    const items = this.version ? snapshot?.items ?? [] : editor.draft.aggregate.items.map(ref => editor.items.find(item => item.item_id === ref.item_id && item.version === ref.version)!).filter(Boolean);
    const aggregate = this.version ? snapshot?.aggregate : editor.draft.aggregate;
    const selected = this.candidate === '' ? null : this.capabilities?.candidates[Number(this.candidate)];
    return html`<h2>${editor.template.name}</h2><small>${editor.template.template_id} · ${editor.builtin ? '内置模板，请先复制' : '自定义模板'} · 草稿 revision ${editor.draft.revision}</small>
      ${this.error ? html`<p class="error" role="alert" tabindex="-1">${this.error}</p>` : nothing}
      ${this.error && !this.retry ? html`<button class="btn" ?disabled=${this.busy} @click=${() => this.open(editor.template.template_id)}>重新读取草稿（放弃未保存修改）</button>` : nothing}
      ${this.notice ? html`<p class="notice" role="status">${this.notice}</p>` : nothing}
      ${this.retry ? html`<p>操作结果需核对。重试使用相同幂等标识，不会重复创建或发布。</p><button class="btn" ?disabled=${this.busy} @click=${this.retry}>重试同一操作</button>` : nothing}
      <div class="actions"><app-form-field label="副本名称"><input aria-label="副本名称" maxlength="128" .value=${this.copyName} ?disabled=${this.busy || !!this.retry} @input=${(e: Event) => this.copyName = (e.target as HTMLInputElement).value}></app-form-field><button class="btn-primary" ?disabled=${!editor.can_manage || this.busy || this.unsaved || !!this.retry} @click=${this.copy}>复制为自定义模板</button></div>
      <div class="actions"><app-form-field label="模板名称"><input aria-label="模板名称" .value=${this.name} maxlength="128" ?disabled=${!editable} @input=${(e: Event) => this.name = (e.target as HTMLInputElement).value}></app-form-field>
      <button class="btn" ?disabled=${!editable} @click=${() => this.name.trim() ? this.mutate('name', { name:this.name,expected_revision:editor.template.revision }, result => { this.editor = { ...editor, template:result.template! }; this.notice = '名称已保存，稳定标识保持不变'; }) : this.error = '名称不能为空'}>保存名称</button>
      <app-form-field label="查看版本"><select aria-label="查看版本" .value=${String(this.version)} ?disabled=${this.busy || this.unsaved || !!this.retry} @change=${(e: Event) => this.version = Number((e.target as HTMLSelectElement).value)}><option value="0">当前草稿</option>${editor.versions.map(v => html`<option value=${v.version}>不可变版本 v${v.version}</option>`)}</select></app-form-field></div>
      ${snapshot ? html`<p>发布于 ${snapshot.published_at}</p><small>${snapshot.content_hash}</small>` : nothing}
      <h3>监控项（${items.length}）</h3><div class="scroll">${items.map(item => html`<section class="item"><strong>${item.display_name}</strong>
      <small>${item.item_id} v${item.version} · ${item.canonical_metric.id}@${item.canonical_metric.semantic_version} · ${item.unit}</small>
      <details><summary>采集映射与稳定身份</summary><pre>${JSON.stringify({ dimensions:item.dimensions,collector:item.collector_ref },null,2)}</pre></details>
      ${canEdit ? html`<div class="actions"><input aria-label=${`监控项名称 ${item.item_id}`} ?disabled=${!editable} .value=${this.itemNames[item.item_id] ?? item.display_name} @input=${(e: Event) => this.itemNames = { ...this.itemNames, [item.item_id]: (e.target as HTMLInputElement).value }}><button class="btn btn-sm" ?disabled=${!editable} @click=${(e: Event) => this.renameItem(item, ((e.currentTarget as HTMLElement).previousElementSibling as HTMLInputElement).value)}>保存监控项名称</button>
      <button class="btn btn-sm" ?disabled=${!editable} @click=${() => { this.editor = { ...editor,draft:{ ...editor.draft,aggregate:{ ...editor.draft.aggregate,items:editor.draft.aggregate.items.filter(ref => ref.item_id !== item.item_id),triggers:editor.draft.aggregate.triggers.filter(ref => ref.scope !== `item:${item.item_id}`) } } }; this.dirty = true; }}>从草稿移除</button></div>` : nothing}</section>`)}</div>
      ${canEdit ? html`<h3>从已注册能力添加</h3><div class="actions"><input aria-label="搜索已注册指标" ?disabled=${!editable} placeholder="按名称或指标标识筛选" .value=${this.metricSearch} @input=${(e: Event) => this.metricSearch = (e.target as HTMLInputElement).value}>
      <select aria-label="已注册指标" ?disabled=${!editable} .value=${this.candidate} @change=${(e: Event) => this.candidate = (e.target as HTMLSelectElement).value}><option value="">请选择可采集指标</option>${this.capabilities?.candidates.map((c,index) => `${c.display_name_default} ${c.metric.id}`.toLowerCase().includes(this.metricSearch.toLowerCase()) ? html`<option value=${index}>${labels[c.resource_type]} · ${c.display_name_default} · ${c.package.id} ${c.package.version}</option>` : nothing)}</select><button class="btn" ?disabled=${!editable || this.candidate === ''} @click=${this.add}>添加监控项</button></div>
      ${selected ? html`<div class="metadata"><p>单位：${selected.unit}<br>值类型：${selected.value_type}<br>建议周期：${selected.default_interval_ms / 1000} 秒</p><p>维度：${selected.dimensions.map(d => d.name).join(', ') || '无'}<br>方法：${selected.method}</p><p>${selected.raw_field} → ${selected.metric.id}<br>${selected.input_unit} → ${selected.output_unit}<br>转换：${selected.steps.join(' → ') || '直接映射'}</p></div>` : nothing}` : nothing}
      <details><summary>未实现指标：不可加入可发布配置</summary>${this.capabilities?.unavailable.map(c => html`<p>${c.id}：${c.reason}（${c.code}）</p>`)}</details>
      <h3>参数</h3><app-form-field label="采集周期（秒）"><input aria-label="采集周期（秒）" type="number" min="1" max="86400" step="1" .value=${String(this.version ? Number(aggregate?.parameters.defaults.interval_ms ?? 60000)/1000 : this.period)} ?disabled=${!editable} @input=${(e: Event) => { this.period = Number((e.target as HTMLInputElement).value); this.dirty = true; }}></app-form-field>
      <details><summary>参数定义与默认值</summary><pre>${JSON.stringify(aggregate?.parameters,null,2)}</pre></details>
      <h3>触发器</h3><p>${aggregate?.triggers.length ?? 0} 个固定版本引用；触发器配置在资源模板配置中管理。</p><pre>${JSON.stringify(aggregate?.triggers ?? [],null,2)}</pre>
      <h3>发现</h3><p>模板发现执行尚未实现；不执行自动发现，不作为成功采集证据。</p>
      <h3>图形</h3><p>模板专属图形尚未实现；资源最新值与历史图表从关联资源进入。</p>
      <h3>关联资源</h3><p>版本发布不会自动绑定或替换资源。进入资源后可查看绑定版本、采集与历史。</p><div class="actions"><a href="/instances-db">数据库资源</a><a href="/servers">服务器资源</a><a href="/network-devices">网络设备资源</a></div>
      <div class="actions"><button class="btn-primary" ?disabled=${!editable} @click=${this.save}>保存草稿</button>
      <button class="btn-primary" ?disabled=${!editable || this.unsaved || !items.length} @click=${() => this.mutate('publish', { expected_draft_revision:editor.draft.revision,expected_revision:editor.template.revision }, async result => { await this.open(editor.template.template_id); await this.load(); this.notice = `已发布不可变版本 v${result.published!.version}`; })}>发布不可变版本</button>
      ${this.unsaved ? html`<button class="btn" ?disabled=${this.busy || !!this.retry} @click=${() => this.open(editor.template.template_id)}>放弃未保存修改</button>` : nothing}<button class="btn" ?disabled=${this.busy || !!this.retry} @click=${this.close}>关闭详情</button></div>`;
  }
}
