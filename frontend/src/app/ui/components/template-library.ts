import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { TemplateLibrary, TemplateCapabilities, TemplateEditor, TemplateAuthoringResult } from '../../../api/generated/public-api.js';
import { metricError, metricRequest, MetricRequestError } from './metric-api.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { sharedFieldStyles } from '../../styles/shared-field-styles.js';
import { metricDisplayName } from './metric-display.js';
import type { AppDialog } from './app-dialog.js';
import './app-badge.js';
import './app-data-table.js';
import './app-dialog.js';
import './app-empty-state.js';
import './app-form-field.js';
import './template-discovery.js';
import './template-trigger-editor.js';

const resourceLabels: Record<string, string> = { instance: '数据库', server: '服务器', network_device: '网络设备' };
const messages: Record<string, string> = {
  TEMPLATE_TRIGGER_ITEM_REFERENCED: '组合触发器仍引用已移除的监控项。请恢复该监控项，或先修改引用它的触发器。',
  TRIGGER_DEPENDENCY_UNKNOWN: '要移除的监控项仍有触发器被依赖。请取消未保存的移除，先在已发布模板中解除触发器依赖，再移除监控项。',
  TEMPLATE_NAME_EMPTY: '请输入模板名称',
  TEMPLATE_INVALID_PERIOD: '请输入 1 到 86400 之间的整数秒',
  TEMPLATE_METRIC_DUPLICATE: '该指标已在模板中',
  TEMPLATE_REVISION_CONFLICT: '模板刚被其他人修改，请返回列表后重新打开',
  TEMPLATE_DRAFT_CONFLICT: '草稿刚被其他人修改，请返回列表后重新打开',
  TEMPLATE_FORBIDDEN: '没有编辑权限。内置模板可克隆后编辑。',
  TEMPLATE_EMPTY: '请先添加一个监控项',
};
type Section = 'items' | 'triggers' | 'discovery';
type Item = TemplateEditor['items'][number];
type ItemRef = TemplateEditor['draft']['aggregate']['items'][number];
type ItemRetention = NonNullable<ItemRef['retention']>;
type RetentionTier = keyof ItemRetention;
type RetentionField = { mode: 'default' | 'custom' | 'off'; value: string };
const retentionTiers = [
  { key: 'history_ms', label: '历史数据', minimum: 3600000, minimumLabel: '1 小时' },
  { key: 'trends_ms', label: '趋势数据', minimum: 86400000, minimumLabel: '1 天' },
] as const;
const retentionUnits = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 };
const sections: ReadonlyArray<{ id: Section; label: string }> = [
  { id: 'items', label: '监控项' }, { id: 'triggers', label: '触发器' }, { id: 'discovery', label: '自动发现' },
];

function itemLabel(item: Item) {
  return item.display_name === item.canonical_metric.id ? metricDisplayName(item.canonical_metric.id) : item.display_name;
}

function duration(ms: number) {
  for (const [unit, size] of [['天', 86400000], ['小时', 3600000], ['分钟', 60000], ['秒', 1000]] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size} ${unit}`;
  }
  return `${ms / 1000} 秒`;
}

function retentionField(ms: number | undefined): RetentionField {
  if (ms === undefined) return { mode: 'default', value: '' };
  if (ms === 0) return { mode: 'off', value: '' };
  const [unit, size] = Object.entries(retentionUnits).find(([, size]) => ms % size === 0)!;
  return { mode: 'custom', value: `${ms / size}${unit}` };
}

@customElement('template-library')
export class TemplateLibraryPage extends LitElement {
  @state() private library: TemplateLibrary | null = null;
  @state() private capabilities: TemplateCapabilities | null = null;
  @state() private editor: TemplateEditor | null = null;
  @state() private editing = false;
  @state() private section: Section = 'items';
  @state() private search = '';
  @state() private type = '';
  @state() private origin = '';
  @state() private naming: 'create' | 'copy' | null = null;
  @state() private newName = '';
  @state() private name = '';
  @state() private candidate = '';
  @state() private metricSearch = '';
  @state() private adding = false;
  @state() private period = 60;
  @state() private periodChanged = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private notice = '';
  @state() private dirty = false;
  @state() private retry: (() => Promise<void>) | null = null;
  @state() private itemNames: Record<string, string> = {};
  @state() private itemEdit: { item: Item; name: string; interval: string; retention: Record<RetentionTier, RetentionField> } | null = null;
  @state() private itemError = '';
  @state() private discard = false;
  @state() private triggerEditing = false;
  @state() private triggerDirty = false;
  private afterDiscard: (() => void) | null = null;
  private openerId = '';
  private generation = 0;
  private get unsaved() {
    return this.dirty || this.name !== this.editor?.template.name || Object.keys(this.itemNames).length > 0;
  }
  private get published() { return this.editing ? null : this.editor?.current; }
  private get aggregate() { return this.published?.aggregate ?? this.editor?.draft.aggregate; }
  private get items(): Item[] {
    if (this.published) return this.published.items;
    const editor = this.editor;
    if (!editor) return [];
    return editor.draft.aggregate.items.flatMap(ref =>
      editor.items.find(item => item.item_id === ref.item_id && item.version === ref.version) ?? []);
  }

  private readonly revoked = () => {
    this.generation++;
    this.editor = null; this.library = null; this.capabilities = null; this.retry = null;
    this.naming = null; this.itemEdit = null; this.discard = false; this.triggerEditing = false; this.triggerDirty = false; this.newName = ''; this.editing = false;
    this.notice = ''; this.busy = false; this.error = '登录或权限已变更，请刷新模板库';
  };

  static styles = [sharedBtnStyles, sharedFieldStyles, css`
    :host { display: block; color: var(--text); min-width: 0; }
    .page { display: grid; gap: var(--space-lg); }
    .page-head, .panel-head, .actions, .row-actions {
      display: flex; align-items: center; justify-content: space-between; gap: var(--space-md);
    }
    .page-head { flex-wrap: wrap; }
    .actions, .row-actions { justify-content: flex-start; gap: var(--space-sm); }
    .row-actions { white-space: nowrap; }
    h1, h2, p, dl { margin: 0; }
    h1 { color: var(--text-strong); font-size: var(--text-2xl, 1.5rem); font-weight: 650; overflow-wrap: anywhere; }
    h2 { color: var(--text-strong); font-size: var(--text-lg); }
    .trail { justify-self: start; padding-inline: 0; color: var(--accent); }
    .title-meta { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); margin-top: var(--space-xs); }
    .filters { display: grid; align-items: end; grid-template-columns: minmax(15rem, 24rem) minmax(8rem, 10rem) minmax(8rem, 10rem) auto; gap: var(--space-md); }
    .filters button { justify-self: start; }
    app-form-field { min-width: 0; }
    input, select {
      min-height: var(--control-height); box-sizing: border-box; width: 100%; padding: var(--space-sm);
      border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--text);
      font: inherit;
    }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .surface { border: 1px solid var(--border); border-radius: var(--radius-md); overflow: auto; background: var(--bg); }
    .template-name { padding: 0; color: var(--accent); text-align: start; font-weight: 600; white-space: normal; overflow-wrap: anywhere; }
    .table-foot, small { color: var(--muted); font-size: var(--text-sm); }
    small { display: block; overflow-wrap: anywhere; }
    .table-foot { padding: var(--space-sm) var(--space-md); border-top: 1px solid var(--border); }
    .period { max-width: 14rem; }
    .retention-field { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-sm); }
    .tabs { display: flex; gap: var(--space-lg); border-bottom: 1px solid var(--border); }
    .tab { padding: var(--space-sm) var(--space-xs); border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); font: inherit; cursor: pointer; }
    .tab[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
    .panel { display: grid; gap: var(--space-md); }
    .muted { color: var(--muted); }
    .error { color: var(--danger); }
    .picker, .name-field { max-width: 40rem; }
    .picker { display: grid; gap: var(--space-sm); }
    .edit-footer { display: flex; justify-content: end; align-items: center; flex-wrap: wrap; gap: var(--space-sm); padding-block: var(--space-md); border-top: 1px solid var(--border); }
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
    this.error = error instanceof MetricRequestError && error.code && messages[error.code]
      ? messages[error.code] : metricError(error);
  }

  private readFailure(error: unknown) {
    if (error instanceof MetricRequestError && [401, 403].includes(error.status)) this.revoked();
    else this.failure(error);
  }

  private async load() {
    const generation = ++this.generation;
    this.error = ''; this.busy = true;
    try {
      const library = await metricRequest<TemplateLibrary>('templates/library');
      if (generation === this.generation) this.library = library;
    } catch (error) { if (generation === this.generation) this.readFailure(error); }
    finally { if (generation === this.generation) this.busy = false; }
  }

  private async open(id: string, editing = false, section: Section = 'items') {
    const generation = ++this.generation;
    this.busy = true; this.error = ''; this.notice = '';
    try {
      const editor = await metricRequest<TemplateEditor>(`templates/${encodeURIComponent(id)}/editor`);
      if (generation !== this.generation) return;
      this.editor = editor;
      this.editing = editing && editor.can_manage && !editor.builtin;
      this.section = section;
      this.triggerEditing = false; this.triggerDirty = false;
      this.name = editor.template.name;
      this.period = Number(editor.draft.aggregate.parameters.defaults.interval_ms ?? editor.default_interval_ms ?? 60000) / 1000;
      this.itemNames = {}; this.dirty = false; this.periodChanged = false; this.adding = false; this.candidate = ''; this.metricSearch = '';
      await this.updateComplete;
      if (generation === this.generation) this.renderRoot.querySelector<HTMLElement>('h1')?.focus();
    } catch (error) { if (generation === this.generation) this.readFailure(error); }
    finally { if (generation === this.generation) this.busy = false; }
  }

  private async mutate(action: string, body: Record<string, unknown>, done: (result: TemplateAuthoringResult) => Promise<void> | void) {
    const id = this.editor?.template.template_id;
    if (action !== 'create' && !id) return;
    const path = action === 'create' ? 'templates' : `templates/${encodeURIComponent(id!)}/${action}`;
    const intent = { ...body, operation_key: crypto.randomUUID() };
    const generation = this.generation;
    const run = async () => {
      this.busy = true; this.error = '';
      try {
        const result = await metricRequest<TemplateAuthoringResult>(path, intent);
        if (generation !== this.generation) return;
        this.retry = null;
        await done(result);
      } catch (error) {
        if (generation !== this.generation) return;
        if (error instanceof MetricRequestError && error.status === 401) this.revoked();
        else if (error instanceof MetricRequestError && error.status === 403 && (action === 'copy' || !this.editor?.builtin)) {
          this.retry = null;
          if (this.editor) this.editor = { ...this.editor, can_manage: false };
          if (this.library) this.library = { ...this.library, can_manage: false };
          this.error = '编辑权限已变更';
        } else {
          this.failure(error);
          this.retry = error instanceof MetricRequestError && error.status < 500 ? null : run;
        }
      } finally { if (generation === this.generation) this.busy = false; }
    };
    await run();
  }

  private async submitName() {
    const action = this.naming;
    const name = this.newName.trim();
    if (!action || !name || this.retry || this.busy) return;
    await this.mutate(action, { name }, async result => {
      const template = result.template!;
      this.naming = null; this.newName = '';
      if (this.library) this.library = { ...this.library, templates: [...this.library.templates,
        { template, builtin: false, resource_types: [], item_count: 0, trigger_count: 0, discovery_count: 0 }] };
      this.search = ''; this.type = ''; this.origin = '';
      await this.open(template.template_id, true);
      if (!this.editor || this.editor.template.template_id !== template.template_id) {
        this.notice = '草稿已创建，可从列表打开。';
      }
    });
  }

  private async openNaming(action: 'create' | 'copy') {
    this.naming = action;
    this.newName = action === 'copy' ? `${this.editor!.template.name} 副本`.slice(0, 128) : '';
    this.error = '';
    if (action === 'create') this.notice = '';
    await this.updateComplete;
    const dialog = this.renderRoot.querySelector<AppDialog>('#template-naming');
    await dialog?.updateComplete;
    if (dialog?.open) dialog.querySelector('input')?.focus();
  }

  private async showPicker() {
    this.adding = true;
    if (!this.capabilities) {
      const generation = this.generation;
      this.busy = true;
      try {
        const capabilities = await metricRequest<TemplateCapabilities>('templates/capabilities');
        if (generation === this.generation) this.capabilities = capabilities;
      } catch (error) { if (generation === this.generation) this.readFailure(error); }
      finally { if (generation === this.generation) this.busy = false; }
    }
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLInputElement>('#metric-search')?.focus();
  }

  private add() {
    const candidate = this.candidate && this.capabilities?.candidates[Number(this.candidate)];
    if (!this.editor || !candidate) return;
    if (this.items.some(item => item.canonical_metric.id === candidate.metric.id
      && item.canonical_metric.semantic_version === candidate.metric.semantic_version)) {
      this.error = messages.TEMPLATE_METRIC_DUPLICATE; return;
    }
    return this.mutate('item', { package: candidate.package, metric: candidate.metric }, result => {
      const editor = this.editor!;
      const refs = [...editor.draft.aggregate.items, { item_id: result.item!.item_id, version: result.item!.version }]
        .sort((a, b) => a.item_id < b.item_id ? -1 : 1);
      if (!this.items.length && !this.dirty && editor.draft.aggregate.parameters.defaults.interval_ms === undefined) {
        this.period = candidate.default_interval_ms / 1000;
      }
      this.editor = { ...editor, items: [...editor.items, result.item!],
        draft: { ...editor.draft, aggregate: { ...editor.draft.aggregate, items: refs } } };
      this.dirty = true; this.candidate = ''; this.adding = false;
    });
  }

  private removeItem(id: string) {
    const editor = this.editor!;
    const aggregate = editor.draft.aggregate;
    this.editor = { ...editor, draft: { ...editor.draft, aggregate: {
      ...aggregate,
      items: aggregate.items.filter(ref => ref.item_id !== id),
      triggers: aggregate.triggers.filter(ref => ref.scope !== `item:${id}`),
      ...(aggregate.discovery_rules ? { discovery_rules: aggregate.discovery_rules
        .map(rule => ({ ...rule, item_ids: rule.item_ids.filter(item => item !== id) })).filter(rule => rule.item_ids.length) } : {}),
    } } };
    const { [id]: _removed, ...remaining } = this.itemNames;
    this.itemNames = remaining;
    this.dirty = true;
  }

  private async editItem(item: Item, configuration: ItemRef | undefined) {
    this.itemError = '';
    this.itemEdit = { item, name: this.itemNames[item.item_id] ?? itemLabel(item),
      interval: configuration?.interval_ms === undefined ? '' : String(configuration.interval_ms / 1000),
      retention: { history_ms: retentionField(configuration?.retention?.history_ms),
        trends_ms: retentionField(configuration?.retention?.trends_ms) } };
    await this.updateComplete;
    const dialog = this.renderRoot.querySelector<AppDialog>('#monitoring-item-editor');
    await dialog?.updateComplete;
    if (dialog?.open) dialog.querySelector('input')?.focus();
  }

  private updateRetentionField(key: RetentionTier, field: Partial<RetentionField>) {
    const edit = this.itemEdit!;
    this.itemError = '';
    this.itemEdit = { ...edit, retention: { ...edit.retention, [key]: { ...edit.retention[key], ...field } } };
  }

  private saveItem() {
    const editing = this.itemEdit;
    const editor = this.editor;
    if (!editing || !editor) return;
    const displayName = editing.name.trim();
    if (!displayName) { this.itemError = '请输入监控项名称'; return; }
    const interval = editing.interval === '' ? undefined : Number(editing.interval) * 1000;
    if (interval !== undefined && (!Number.isSafeInteger(interval) || interval % 1000 !== 0 || interval < 1000 || interval > 86400000)) {
      this.itemError = messages.TEMPLATE_INVALID_PERIOD;
      return;
    }
    const retention: ItemRetention = {};
    for (const { key, label, minimum, minimumLabel } of retentionTiers) {
      const field = editing.retention[key];
      if (field.mode === 'default') continue;
      if (field.mode === 'off') { retention[key] = 0; continue; }
      const match = /^([1-9]\d*)\s*(ms|d|h|m|s)$/i.exec(field.value.trim());
      const ms = match ? Number(match[1]) * retentionUnits[match[2].toLowerCase() as keyof typeof retentionUnits] : NaN;
      if (!Number.isSafeInteger(ms) || ms < minimum || ms > 3650 * 86400000) {
        this.itemError = `${label}期限须为 ${minimumLabel}到 3650 天，例如 7d 或 24h`;
        return;
      }
      retention[key] = ms;
    }
    const { item_id } = editing.item;
    const names = { ...this.itemNames };
    if (displayName === itemLabel(editing.item)) delete names[item_id];
    else names[item_id] = displayName;
    this.itemNames = names;
    const aggregate = editor.draft.aggregate;
    const items = aggregate.items.map(ref => {
      if (ref.item_id !== item_id) return ref;
      const { interval_ms: previousInterval, retention: previous, ...identity } = ref;
      if (previousInterval === interval && previous?.history_ms === retention.history_ms && previous?.trends_ms === retention.trends_ms) return ref;
      this.dirty = true;
      return { ...identity, ...(interval === undefined ? {} : { interval_ms: interval }),
        ...(Object.keys(retention).length ? { retention } : {}) };
    });
    this.editor = { ...editor, draft: { ...editor.draft, aggregate: { ...aggregate, items } } };
    this.itemEdit = null;
  }

  private renderItemEditor() {
    const edit = this.itemEdit;
    return html`<app-dialog id="monitoring-item-editor" .open=${!!edit} title="编辑监控项" @app-dialog-close=${() => this.itemEdit = null}>
      ${edit ? html`<form class="panel" @submit=${(event: SubmitEvent) => { event.preventDefault(); this.saveItem(); }}>
        <app-form-field label="监控项名称"><input autofocus required aria-label="监控项名称" maxlength="128" .value=${edit.name}
          @input=${(event: Event) => this.itemEdit = { ...this.itemEdit!, name: (event.target as HTMLInputElement).value }}></app-form-field>
        <small>${edit.item.canonical_metric.id} · ${edit.item.unit}</small>
        <app-form-field label="监控项采集周期（秒）">
          <input type="number" min="1" max="86400" step="1" aria-label="监控项采集周期（秒）" placeholder="使用默认周期"
            .value=${edit.interval} @input=${(event: Event) => {
              this.itemError = '';
              this.itemEdit = { ...this.itemEdit!, interval: (event.target as HTMLInputElement).value };
            }}>
          <small>留空时使用默认采集周期。</small>
        </app-form-field>
        ${retentionTiers.map(({ key, label, minimumLabel }) => html`<div class="retention-field">
          <app-form-field label=${label}><select aria-label=${`${label}保存方式`} .value=${edit.retention[key].mode}
            @change=${(event: Event) => this.updateRetentionField(key, { mode: (event.target as HTMLSelectElement).value as RetentionField['mode'] })}>
            <option value="default">平台默认</option><option value="custom">自定义</option><option value="off">不保留</option>
          </select></app-form-field>
          ${edit.retention[key].mode === 'custom' ? html`<app-form-field label=${`${label}期限`}>
            <input required aria-label=${`${label}期限`} .value=${edit.retention[key].value}
              placeholder=${key === 'history_ms' ? '例如 12h 或 7d' : '例如 90d'}
              @input=${(event: Event) => this.updateRetentionField(key, { value: (event.target as HTMLInputElement).value })}>
            <small>最短 ${minimumLabel}，h 为小时，d 为天</small>
          </app-form-field>` : nothing}
        </div>`)}
        ${this.itemError ? html`<p class="error" role="alert">${this.itemError}</p>` : nothing}
        <div class="actions"><button class="btn-primary" type="submit">确定</button>
          <button class="btn" type="button" @click=${() => this.itemEdit = null}>取消</button></div>
      </form>` : nothing}
    </app-dialog>`;
  }

  private retentionLabel(tier: RetentionTier, configured?: number) {
    if (configured === 0) return '不保留';
    if (configured !== undefined) return duration(configured);
    const platform = this.editor?.retention;
    if (!platform || platform.by_value_type.some(row => row[tier] !== platform[tier])) return '平台默认';
    return `平台默认 · ${duration(platform[tier])}`;
  }

  private save(publish: boolean) {
    const editor = this.editor;
    if (!editor || !editor.can_manage || editor.builtin || !this.editing || this.busy || this.retry) return;
    if (!this.name.trim() || Object.values(this.itemNames).some(name => !name.trim())) { this.error = messages.TEMPLATE_NAME_EMPTY; return; }
    if (this.periodChanged && (!Number.isInteger(this.period) || this.period < 1 || this.period > 86400)) { this.error = messages.TEMPLATE_INVALID_PERIOD; return; }
    const aggregate = structuredClone(editor.draft.aggregate);
    if (this.periodChanged) {
      aggregate.parameters.schema.interval_ms ??= { type: 'integer', min: 1000, max: 86400000 };
      aggregate.parameters.defaults.interval_ms = this.period * 1000;
    }
    return this.mutate('save', { name: this.name.trim(), expected_revision: editor.template.revision,
      expected_draft_revision: editor.draft.revision, aggregate, publish,
      item_names: Object.entries(this.itemNames).map(([item_id, display_name]) => ({ item_id, display_name: display_name.trim() })),
    }, async () => {
      // The write is acknowledged. Clear local edits before rereading so a read
      // failure cannot make a saved draft look safe to submit a second time.
      this.editor = null; this.editing = false; this.itemNames = {}; this.dirty = false;
      await this.load();
      if (this.library) await this.open(editor.template.template_id, !publish, this.section);
      if (this.library) this.notice = publish ? '模板已发布' : '草稿已保存';
    });
  }

  private confirmLeave(action: () => void, changed: boolean) {
    if (!changed) { action(); return; }
    this.afterDiscard = action;
    this.discard = true;
  }

  private leave() {
    if (this.busy || this.retry) return;
    this.confirmLeave(() => void this.back(), (this.editing && this.unsaved) || this.triggerDirty);
  }

  private cancelEdit() {
    const id = this.editor?.template.template_id;
    if (!id || this.busy || this.retry) return;
    this.confirmLeave(() => void this.open(id, false, this.section), this.unsaved);
  }

  private enterSection(section: Section, focus = false) {
    if (section === this.section) return;
    this.confirmLeave(() => {
      this.triggerEditing = false; this.triggerDirty = false;
      this.section = section;
      if (focus) void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLButtonElement>(`#template-tab-${section}`)?.focus());
    }, this.triggerDirty);
  }

  private async back() {
    this.discard = false; this.editor = null; this.editing = false; this.error = ''; this.notice = '';
    await this.load();
    await this.updateComplete;
    const opener = [...this.renderRoot.querySelectorAll<HTMLButtonElement>('button[data-template-id]')]
      .find(button => button.dataset.templateId === this.openerId);
    (opener ?? this.renderRoot.querySelector<HTMLElement>('h1'))?.focus();
  }

  private selectSection(event: KeyboardEvent, index: number) {
    const target = event.key === 'ArrowRight' ? (index + 1) % sections.length
      : event.key === 'ArrowLeft' ? (index + sections.length - 1) % sections.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : -1;
    if (target < 0) return;
    event.preventDefault();
    this.enterSection(sections[target].id, true);
  }

  override render() {
    return html`<div class="page">
      ${this.editor ? this.renderDetail() : this.renderList()}
    </div>
    <app-dialog id="template-naming" .open=${!!this.naming} .title=${this.naming === 'copy' ? '克隆模板' : '新建模板'}
      .closable=${!this.busy && !this.retry} @app-dialog-close=${() => { this.naming = null; this.error = ''; }}>
      ${this.naming ? html`<form id="template-name-form" class="panel" @submit=${(event: SubmitEvent) => { event.preventDefault(); void this.submitName(); }}>
        <app-form-field label="模板名称"><input required maxlength="128" aria-label="新模板名称" .value=${this.newName}
          ?disabled=${this.busy || !!this.retry} @input=${(event: Event) => this.newName = (event.target as HTMLInputElement).value}></app-form-field>
        ${this.renderFeedback()}
      </form>
      <div class="actions" slot="footer">
        <button class="btn" type="button" ?disabled=${this.busy || !!this.retry} @click=${() => { this.naming = null; this.error = ''; }}>取消</button>
        <button class="btn-primary" type="submit" form="template-name-form" ?disabled=${this.busy || !!this.retry || !this.newName.trim()} aria-busy=${this.busy}>
          ${this.naming === 'copy' ? '创建副本' : '创建模板'}</button>
      </div>` : nothing}
    </app-dialog>
    <app-dialog .open=${this.discard} title="放弃未保存修改？" @app-dialog-close=${() => this.discard = false}>
      <div class="actions"><button class="btn-primary" @click=${() => this.discard = false}>继续编辑</button>
      <button class="btn" @click=${() => {
        const action = this.afterDiscard;
        this.afterDiscard = null; this.discard = false;
        action?.();
      }}>放弃修改</button></div>
    </app-dialog>
    ${this.renderItemEditor()}`;
  }

  private renderFeedback() {
    return html`${this.error ? html`<p role="alert" class="error">${this.error}</p>` : nothing}
      ${this.notice ? html`<p role="status">${this.notice}</p>` : nothing}
      ${this.retry ? html`<button class="btn" ?disabled=${this.busy} @click=${this.retry}>重试同一操作</button>` : nothing}`;
  }

  private renderList() {
    const library = this.library;
    const keyword = this.search.trim().toLowerCase();
    const rows = library?.templates.filter(row => (!this.type || row.resource_types.some(type => type === this.type))
      && (!this.origin || (this.origin === 'builtin') === row.builtin) && row.template.name.toLowerCase().includes(keyword)) ?? [];
    return html`<header class="page-head"><h1 tabindex="-1">监控模板</h1>
      ${library?.can_manage ? html`<button class="btn-primary" ?disabled=${this.busy || !!this.retry}
        @click=${() => this.openNaming('create')}>新建模板</button>` : nothing}</header>
      <div class="filters">
        <app-form-field label="搜索模板"><input aria-label="搜索模板" type="search" placeholder="输入模板名称" .value=${this.search}
          @input=${(e: Event) => this.search = (e.target as HTMLInputElement).value}></app-form-field>
        <app-form-field label="资源类型"><select aria-label="资源类型" .value=${this.type}
          @change=${(e: Event) => this.type = (e.target as HTMLSelectElement).value}><option value="">全部类型</option>
          ${Object.entries(resourceLabels).map(([value, label]) => html`<option value=${value}>${label}</option>`)}</select></app-form-field>
        <app-form-field label="模板来源"><select aria-label="模板来源" .value=${this.origin}
          @change=${(e: Event) => this.origin = (e.target as HTMLSelectElement).value}><option value="">全部来源</option>
          <option value="builtin">内置</option><option value="custom">自定义</option></select></app-form-field>
        <button class="btn btn-refresh" ?disabled=${this.busy || !!this.retry} @click=${this.load}>刷新模板库</button>
      </div>
      ${!this.naming ? this.renderFeedback() : nothing}
      ${library || this.busy ? html`<div class="surface"><app-data-table .loading=${!library && this.busy} .striped=${false}
        .columns=${[{key:'name',label:'模板名称'}, {key:'type',label:'资源类型'}, {key:'items',label:'监控项'},
          {key:'triggers',label:'触发器'}, {key:'discovery',label:'自动发现'}, {key:'state',label:'状态'}]}
        emptyMessage=${library?.templates.length ? '没有匹配的模板' : '还没有监控模板'}
        .rows=${rows.map(row => {
          const id = row.template.template_id;
          const open = (section: Section) => { this.openerId = id; void this.open(id, false, section); };
          const count = (value: number, section: Section) => value ? html`<button class="btn-ghost btn-sm"
            aria-label=${`${row.template.name} ${sections.find(entry => entry.id === section)!.label}`}
            ?disabled=${this.busy || !!this.retry} @click=${() => open(section)}>${value}</button>` : '0';
          return { name: html`<button class="btn-ghost template-name" data-template-id=${id}
              ?disabled=${this.busy || !!this.retry} @click=${() => open('items')}>${row.template.name}</button>
              <small>${row.builtin ? '内置' : '自定义'}</small>`,
            type: row.resource_types.map(type => resourceLabels[type]).join(' / ') || '待配置',
            items: count(row.item_count, 'items'), triggers: count(row.trigger_count, 'triggers'),
            discovery: count(row.discovery_count, 'discovery'),
            state: row.template.current_published_version ? '已发布' : '草稿' };
        })}></app-data-table>
        ${library ? html`<div class="table-foot">${rows.length === library.templates.length
          ? `共 ${rows.length} 个模板` : `显示 ${rows.length} / ${library.templates.length} 个模板`}</div>` : nothing}</div>` : nothing}`;
  }

  private renderDetail() {
    const editor = this.editor!;
    const aggregate = this.aggregate!;
    const period = Number(aggregate.parameters.defaults.interval_ms ?? editor.default_interval_ms ?? 0);
    const counts = [this.items.length, aggregate.triggers.length, aggregate.discovery_rules?.length ?? 0];
    const blocked = this.busy || !!this.retry || !editor.can_manage;
    return html`<button class="btn-ghost trail" ?disabled=${this.busy || !!this.retry} @click=${this.leave}>‹ 返回监控模板</button>
      <header class="page-head"><div><h1 tabindex="-1">${editor.template.name}</h1>
        <div class="title-meta"><app-badge>${editor.builtin ? '内置' : '自定义'}</app-badge>
          <span class="muted">${this.editing ? '编辑模板' : editor.current ? '已发布' : '草稿'}</span></div></div>
        ${!this.editing && !this.triggerEditing && editor.can_manage ? html`<div class="actions">
          <button class="btn" ?disabled=${blocked} @click=${() => this.openNaming('copy')}>克隆</button>
          ${!editor.builtin ? html`<button class="btn-primary" ?disabled=${blocked}
            @click=${() => this.open(editor.template.template_id, true, this.section)}>编辑</button>` : nothing}</div>` : nothing}
      </header>
      ${!this.naming ? this.renderFeedback() : nothing}
      ${this.editing ? html`<app-form-field class="name-field" label="模板名称"><input aria-label="模板名称" maxlength="128"
        .value=${this.name} ?disabled=${blocked} @input=${(e: Event) => this.name = (e.target as HTMLInputElement).value}></app-form-field>` : nothing}
      ${this.editing ? html`<app-form-field class="period" label="模板默认采集周期（秒）">
        <input aria-label="采集周期（秒）" type="number" min="1" max="86400" step="1"
          .value=${String(this.period)} ?disabled=${blocked} @input=${(e: Event) => { this.period = Number((e.target as HTMLInputElement).value); this.periodChanged = true; this.dirty = true; }}>
      </app-form-field>` : html`<p class="muted">模板默认采集周期 · ${period ? duration(period) : '跟随采集配置'}</p>`}
      <div class="tabs" role="tablist" aria-label="模板内容">${sections.map(({id,label}, index) => html`
        <button class="tab" role="tab" id=${`template-tab-${id}`} aria-controls="template-content" aria-selected=${this.section === id}
          tabindex=${this.section === id ? 0 : -1} @click=${() => this.enterSection(id)} @keydown=${(event: KeyboardEvent) => this.selectSection(event, index)}>${label} ${counts[index]}</button>`)}</div>
      <div id="template-content" class="panel" role="tabpanel" aria-labelledby=${`template-tab-${this.section}`}>
        ${this.section === 'items' ? this.renderItems(blocked)
          : this.section === 'triggers' ? this.renderTriggers(blocked)
          : html`<template-discovery .aggregate=${aggregate} .items=${this.items} .version=${this.published ?? editor.current}
              .resourceTools=${false} .capabilities=${this.capabilities} .editable=${this.editing && !blocked}
              @discovery-change=${(event: CustomEvent) => {
                this.editor = { ...editor, draft: { ...editor.draft, aggregate: { ...editor.draft.aggregate, discovery_rules: event.detail } } };
                this.dirty = true;
              }}></template-discovery>`}
      </div>
      ${this.editing ? html`<footer class="edit-footer">
        <button class="btn" ?disabled=${this.busy || !!this.retry} @click=${this.cancelEdit}>取消</button>
        <button class="btn" ?disabled=${blocked} @click=${() => this.save(false)}>保存草稿</button>
        <button class="btn-primary" ?disabled=${blocked || !this.items.length} @click=${() => this.save(true)}>保存并发布</button>
      </footer>` : nothing}`;
  }

  private renderItems(blocked: boolean) {
    const editing = this.editing;
    const retention = this.editor?.retention;
    const itemPolicies = new Map(this.aggregate?.items.map(ref => [ref.item_id, ref]));
    return html`
      ${editing ? html`<div class="panel-head"><h2>监控项</h2><button class="btn" ?disabled=${blocked}
        @click=${this.showPicker}>添加监控项</button></div>` : nothing}
      ${this.adding && editing ? html`<div class="picker">
        <app-form-field label="搜索指标"><input id="metric-search" type="search" aria-label="搜索指标" .value=${this.metricSearch}
          @input=${(e: Event) => { this.metricSearch = (e.target as HTMLInputElement).value; this.candidate = ''; }}></app-form-field>
        <app-form-field label="指标"><select aria-label="指标" .value=${this.candidate} ?disabled=${blocked}
          @change=${(e: Event) => this.candidate = (e.target as HTMLSelectElement).value}><option value="">选择指标</option>
          ${this.capabilities?.candidates.flatMap((candidate, index) =>
            `${candidate.display_name_default} ${candidate.metric.id}`.toLowerCase().includes(this.metricSearch.trim().toLowerCase())
              ? html`<option value=${index}>${candidate.display_name_default} · ${resourceLabels[candidate.resource_type]} · ${candidate.method.toUpperCase()} · ${candidate.package.id} ${candidate.package.version}</option>` : [])}
        </select></app-form-field>
        <div class="actions"><button class="btn-primary" ?disabled=${blocked || this.candidate === ''} @click=${this.add}>添加</button>
          <button class="btn" ?disabled=${blocked} @click=${() => this.adding = false}>取消添加</button></div>
      </div>` : nothing}
      <div class="surface"><app-data-table .striped=${false}
        .columns=${[{key:'name',label:'名称'}, {key:'metric',label:'指标标识'}, {key:'unit',label:'单位'},
          {key:'interval',label:'采集周期'}, {key:'history',label:'历史数据'}, {key:'trends',label:'趋势数据'},
          ...(editing ? [{key:'actions',label:'操作'}] : [])]}
        emptyMessage="还没有监控项"
        .rows=${this.items.map(item => ({
          name: this.itemNames[item.item_id] ?? itemLabel(item),
          metric: item.canonical_metric.id, unit: item.unit,
          interval: this.intervalLabel(itemPolicies.get(item.item_id)?.interval_ms),
          history: this.retentionLabel('history_ms', itemPolicies.get(item.item_id)?.retention?.history_ms),
          trends: this.retentionLabel('trends_ms', itemPolicies.get(item.item_id)?.retention?.trends_ms),
          actions: editing ? html`<div class="row-actions">
            <button class="btn-ghost btn-sm" aria-label=${`编辑 ${itemLabel(item)}`} ?disabled=${blocked}
              @click=${() => this.editItem(item, itemPolicies.get(item.item_id))}>编辑</button>
            <button class="btn-ghost btn-sm" aria-label=${`移除 ${itemLabel(item)}`}
              ?disabled=${blocked} @click=${() => this.removeItem(item.item_id)}>移除</button></div>` : nothing,
        }))}></app-data-table></div>
      ${retention && retention.mode !== 'apply' ? html`<small>数据清理${retention.mode === 'preview' ? '目前仅预览' : '未启用'}。</small>` : nothing}`;
  }

  private intervalLabel(configured?: number): string {
    if (configured !== undefined) return duration(configured);
    return '使用默认周期';
  }

  private renderTriggers(blocked: boolean) {
    const editor = this.editor!;
    if (!editor.current) return html`<app-empty-state title="还没有触发器"
      description=${this.editing ? '发布模板后即可为监控项设置告警条件。' : ''}></app-empty-state>`;
    const version = editor.current;
    return html`
      ${this.triggerEditing ? html`<div class="panel-head"><h2>编辑触发器</h2>
        <button class="btn" @click=${() => this.confirmLeave(() => {
          this.triggerEditing = false; this.triggerDirty = false;
        }, this.triggerDirty)}>取消</button></div>`
        : !this.editing && !editor.builtin && editor.can_manage ? html`<div class="panel-head"><h2>触发器</h2>
          <button class="btn-primary" ?disabled=${blocked} @click=${() => this.triggerEditing = true}>编辑触发器</button></div>` : nothing}
      <template-trigger-editor .template=${version} .readOnly=${!this.triggerEditing} .disabled=${blocked}
        @trigger-dirty=${(event: CustomEvent<boolean>) => this.triggerDirty = event.detail}
        @trigger-published=${async () => { await this.open(editor.template.template_id, false, 'triggers'); this.notice = '触发器已发布'; }}>
      </template-trigger-editor>
      ${this.editing ? html`<p class="muted">完成模板编辑后，可单独编辑触发器。</p>` : nothing}`;
  }
}
