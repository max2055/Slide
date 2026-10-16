import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import './app-card.js';
import './app-data-table.js';
import './app-form-field.js';
import './app-empty-state.js';
import './app-dialog.js';
import { metricName, packageName } from './resource-metric-summary.js';
import { renderCollectionStatus, collectionFactsStyles } from './metric-collection-status.js';
import { showToast } from './app-toast-container.js';

import { metricRequest, metricError, MetricRequestError, recommendationOptions, coverageAvailability, readCollectionStatus,
  type Catalog, type Applicability, type Resolved, type Published, type CollectionStatus, type Recommendation, type RecommendationResult, type PolicyGroup } from './metric-api.js';
export { metricRequest, metricError } from './metric-api.js';
export type { Catalog } from './metric-api.js';
import { type Toggle, type Overrides } from './metric-policy-fields.js';
import './metric-policy-fields.js';
export type { Overrides } from './metric-policy-fields.js';
interface Preview { resources: Published[]; affected_resources: number; requests_per_hour_before: number; requests_per_hour_after: number }
interface Trial { applicability?: Applicability[]; lifecycle_evidence?: string; decision: string; error?: string; capabilities: unknown[]; attempts: Array<{ status: string; error?: string }>; samples: unknown[] }
export function trialPassed(trial: Trial | null): boolean { return !!trial && trial.decision === 'attempted' && !trial.error && trial.samples.length > 0 && trial.attempts.length > 0 && trial.attempts.every(a => a.status === 'succeeded'); }
const labels: Record<string,string> = { pending: '等待应用', applied: '已应用', failed: '应用失败', succeeded: '成功', partial: '部分成功', running: '执行中', cancelled: '已取消', supported: '支持', unsupported: '不支持', unknown: '待验证', enabled: '启用', disabled: '停用', package: '采集包', platform: '平台默认', group: '策略组', resource: '本资源覆盖', attempted: '已试采' };
const label = (value: string | undefined) => value ? labels[value] ?? '待确认' : '未知';
@customElement('metric-configuration')
export class MetricConfiguration extends LitElement {
  @property() resourceType = 'instance';
  @property({ type: Number }) resourceId = 0;
  @state() private catalog: Catalog | null = null;
  @state() private published: Published | null = null;
  @state() private effective: Resolved | null = null;
  @state() private overrides: Overrides = {};
  @state() private selected = '';
  @state() private groupId = '';
  @state() private canManage = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private preview: Preview | null = null;
  @state() private trial: Trial | null = null;
  @state() private attempts: Record<string, unknown>[] = [];
  @state() private collection: CollectionStatus | null = null;
  @state() private statusError = '';
  @state() private recommendations: Recommendation[] = [];
  @state() private groups: PolicyGroup[] = [];
  @state() private groupSearch = '';
  @state() private groupError = '';
  private groupSearchTimer?: ReturnType<typeof setTimeout>;
  private groupSearchVersion = 0;
  @state() private polling = false;
  @state() private pollLimitReached = false;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private pollCount = 0;
  private generation = 0;
  private readonly accessChanged = () => {
    clearTimeout(this.groupSearchTimer); this.groupSearchVersion++;
    this.generation++; this.stopPolling(); this.canManage = false; this.busy = false;
    this.catalog = null; this.published = null; this.effective = null; this.collection = null;
    this.preview = null; this.trial = null; this.attempts = []; this.overrides = {}; this.groups = [];
    this.recommendations = []; this.selected = ''; this.groupId = ''; this.dirty = false;
    this.error = '权限或登录状态已变更，请重新打开资源后读取配置';
  };
  private editVersion = 0;
  @state() private loaded = false;
  @state() private dirty = false;
  @state() private discardPending = false;
  private afterDiscard: (() => void) | null = null;
  confirmDiscard(action: () => void) {
    if (!this.dirty) { action(); return; }
    this.afterDiscard = action; this.discardPending = true;
  }
  private readonly navigate = (e: Event) => {
    if (!this.dirty) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const detail = (e as CustomEvent).detail;
    this.confirmDiscard(() => window.dispatchEvent(new CustomEvent('slide-navigate', { detail })));
  };
  private readonly beforeUnload = (e: BeforeUnloadEvent) => { if (this.dirty) { e.preventDefault(); e.returnValue = ''; } };
  override connectedCallback() { super.connectedCallback(); window.addEventListener('beforeunload', this.beforeUnload); window.addEventListener('slide-navigate', this.navigate, true); window.addEventListener('slide-permissions-loaded', this.accessChanged); window.addEventListener('slide-session-expired', this.accessChanged); }
  static componentStyles = [sharedBtnStyles, css`
    :host { display:block; min-width:0; color:var(--text); }
    .actions { display:flex; flex-wrap:wrap; gap:var(--space-sm); margin-block:var(--space-md); }
    .scroll { overflow:auto; max-width:100%; } app-data-table { min-width:36rem; }
    .fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr)); gap:var(--space-md); }
    input,select { box-sizing:border-box; width:100%; color:var(--text); background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-sm); padding:var(--space-sm); }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; }
    p { overflow-wrap:anywhere; } .error { color:var(--danger); }
  `];
  override willUpdate(changes: Map<string, unknown>) {
    if (changes.has('resourceId') || changes.has('resourceType')) void this.load();
  }
  override disconnectedCallback() { this.stopPolling(); clearTimeout(this.groupSearchTimer); this.groupSearchVersion++; this.generation++; window.removeEventListener('beforeunload', this.beforeUnload); window.removeEventListener('slide-navigate', this.navigate, true); window.removeEventListener('slide-permissions-loaded', this.accessChanged); window.removeEventListener('slide-session-expired', this.accessChanged); super.disconnectedCallback(); }
  private searchGroups(value: string) {
    this.groupSearch = value; this.groupError = '';
    clearTimeout(this.groupSearchTimer);
    const version = ++this.groupSearchVersion, generation = this.generation;
    this.groupSearchTimer = setTimeout(async () => {
      try {
        const result = await metricRequest<{ groups: PolicyGroup[] }>(`policy/groups?query=${encodeURIComponent(value.trim())}`);
        if (version !== this.groupSearchVersion || generation !== this.generation) return;
        const selected = this.groups.find(g => g.id === this.groupId);
        this.groups = selected && !result.groups.some(g => g.id === selected.id) ? [selected, ...result.groups] : result.groups;
      } catch (e) {
        if (version === this.groupSearchVersion && generation === this.generation) {
          if (e instanceof MetricRequestError && [401, 403].includes(e.status)) this.accessChanged();
          this.groupError = metricError(e);
        }
      }
    }, 250);
  }
  private root() { return `resources/${this.resourceType}/${this.resourceId}`; }
  private invalidate() { this.editVersion++; this.dirty = true; this.preview = null; this.trial = null; this.error = ''; }
  private async load() {
    this.stopPolling();
    clearTimeout(this.groupSearchTimer); this.groupSearchVersion++; this.groupSearch = ''; this.groupError = '';
    const generation = ++this.generation;
    this.collection = null; this.statusError = ''; this.recommendations = []; this.groups = [];
    this.catalog = null; this.canManage = false; this.published = null; this.effective = null; this.overrides = {}; this.attempts = [];
    this.selected = ''; this.groupId = ''; this.busy = false; this.invalidate(); this.loaded = false; this.dirty = false;
    if (!Number.isSafeInteger(this.resourceId) || this.resourceId <= 0) return;
    this.busy = true;
    try {
      const [catalog, access, published, attempts, recommendations, groups, collection] = await Promise.all([
        metricRequest<Catalog>('config/catalog'), metricRequest<{ can_manage: boolean }>(`config/${this.root()}/access`),
        metricRequest<Published>(`policy/${this.root()}`).catch(e => { if (e instanceof MetricRequestError && e.status === 404 && e.code === 'POLICY_NOT_FOUND') return null; throw e; }),
        metricRequest<Record<string, unknown>[]>(`config/${this.root()}/attempts`),
        metricRequest<RecommendationResult>(`config/${this.root()}/recommendations`),
        metricRequest<{ groups: PolicyGroup[] }>('policy/groups'),
        metricRequest<CollectionStatus>(`config/${this.root()}/status`),
      ]);
      const effective = published ? await metricRequest<{ resolved: Resolved }>(`policy/${this.root()}/effective`) : null;
      if (generation !== this.generation) return;
      this.catalog = catalog; this.canManage = access.can_manage; this.published = published; this.effective = effective?.resolved ?? null;
      this.overrides = structuredClone(published?.binding.overrides ?? {}); this.groupId = published?.binding.group_id ?? '';
      this.recommendations = recommendationOptions(recommendations); this.groups = groups.groups; this.collection = coverageAvailability(collection, recommendations);
      this.selected = published?.binding.package.digest ?? this.recommendations.find(r => r.recommended && r.status === 'supported')?.package.digest ?? '';
      this.attempts = attempts; this.loaded = true;
      if (published && !this.terminal(collection)) this.startPolling();
    } catch (error) { if (generation === this.generation) this.error = metricError(error); }
    finally { if (generation === this.generation) this.busy = false; }
  }
  private terminal(status: CollectionStatus) {
    return status.effective_enabled.enabled === false || status.binding.application === 'failed'
      || ['ready', 'available', 'failed'].includes(status.formal_visibility.state);
  }
  private stopPolling() { clearTimeout(this.pollTimer); this.pollTimer = undefined; this.polling = false; }
  private startPolling() { this.stopPolling(); this.pollCount = 0; this.pollLimitReached = false; this.polling = true; this.schedulePoll(); }
  private schedulePoll() { this.pollTimer = setTimeout(() => void this.refreshStatus(), 2000); }
  private async refreshStatus() {
    const generation = this.generation;
    this.statusError = '';
    try {
      const status = await readCollectionStatus(this.resourceType, this.resourceId);
      if (generation !== this.generation || !this.isConnected) return;
      this.collection = status;
      if (this.terminal(status)) { this.stopPolling(); return; }
      if (++this.pollCount >= 15) { this.pollLimitReached = true; this.stopPolling(); return; }
      if (this.polling) this.schedulePoll();
    } catch (e) { if (generation === this.generation) {
      if (e instanceof MetricRequestError && [401, 403, 404].includes(e.status)) this.accessChanged();
      this.statusError = metricError(e); this.stopPolling();
    } }
  }
  private candidate() {
    const pack = this.catalog?.packages.find(p => p.package.digest === this.selected)?.package;
    if (!pack || this.recommendations.find(r => r.package.digest === pack.digest)?.status !== 'supported') throw new Error('400');
    return { expected_revision: this.published?.binding.revision ?? 0, package: { id: pack.id, version: pack.version, digest: pack.digest },
      group_id: this.groupId || null, overrides: this.overrides };
  }
  private publishReady() {
    return trialPassed(this.trial) || (!!this.trial && !this.trial.error && this.trial.decision === 'disabled'
      && this.preview?.resources[0]?.resolved.settings.enabled === false);
  }
  private async execute(operation: 'preview' | 'trial' | 'publish') {
    if (this.busy || !this.canManage) return;
    if (operation === 'trial' && !this.preview || operation === 'publish' && (!this.preview || !this.publishReady())) return;
    const generation = this.generation, editVersion = this.editVersion;
    this.busy = true; this.error = '';
    try {
      const path = operation === 'publish' ? `config/${this.root()}/activate` : `${operation === 'trial' ? 'config' : 'policy'}/${this.root()}/${operation}`;
      const result = await metricRequest<Preview & Trial>(path, this.candidate());
      if (generation !== this.generation || editVersion !== this.editVersion) return;
      if (operation === 'preview') this.preview = result;
      if (operation === 'trial') this.trial = result;
      if (operation === 'publish') {
        this.dirty = false; this.preview = null; this.trial = null;
        showToast('采集配置已发布，正在确认应用与正式数据状态', 'success');
        await this.load();
      }
    } catch (error) { if (generation === this.generation) { this.invalidate(); this.error = metricError(error); } }
    finally { if (generation === this.generation) this.busy = false; }
  }
  private trialMessage() {
    const trial = this.trial;
    if (!trial) return '';
    if (trial.decision === 'unsupported') return '版本或资源不适用，不能发布。请选择支持当前版本的采集包。';
    if (trial.decision === 'capability_unknown') return '资源版本或能力证据不足，请核对资源信息后重新试采。';
    if (trial.decision === 'disabled' && this.publishReady()) return '已验证停用配置，不执行采集，可以发布';
    const errors = [...new Set([trial.error, ...trial.attempts.map(a => a.error)].filter(Boolean))];
    const messages: Record<string, string> = {
      permission_denied: '目标数据库权限不足，请检查采集账户及采集包所需权限。',
      connection_error: '目标连接失败，请检查实例连接状态、地址和凭据。',
      timeout: '试采超时，请检查目标负载、连接和超时配置后重试；不代表永久不支持。',
      parse_error: '数据格式或字段不符合采集包要求，请核对目标版本和采集包后重试。',
    };
    if (errors.length) return errors.map(error => messages[error!] ?? '实际采集失败，请检查诊断后重试。').join(' ');
    if (trialPassed(trial)) return '试采成功，可以发布';
    if (!trial.samples.length) return '试采未返回样本，不能发布。请检查指标是否启用并重新试采。';
    return '试采未完全成功，请检查原因并重新试采';
  }
  private applicabilityMessage(checks: Applicability[] | undefined) {
    return checks?.filter(c => c.status !== 'supported').map(c => html`<p role="status">
      ${c.attribute === 'db.version' ? c.status === 'unknown' ? '版本待验证' : '版本不适用' : '资源适用性待确认'}：当前${c.attribute === 'db.version' ? '数据库版本' : c.attribute === 'db.engine' ? '数据库类型' : '资源属性'} ${c.value ?? '未知'}；
      支持范围 ${c.supported_values.join(' / ')}。
      ${c.status === 'unknown' ? '请补全或刷新资源信息并重新预检。' : '请选择支持当前版本的采集包；未验证版本需先完成兼容验证，不能修改资源版本绕过检查。'}
    </p>`);
  }
  private toggle(value: Toggle, update: (value: Toggle) => void) {
    return html`<select aria-label="指标覆盖" .value=${value} .disabled=${this.busy || !this.canManage} @change=${(e: Event) => { update((e.target as HTMLSelectElement).value as Toggle); this.invalidate(); }}>
      <option value="inherit">继承</option><option value="enable">启用</option><option value="disable">停用</option></select>`;
  }
  render() {
    const resolved = this.preview?.resources[0]?.resolved ?? this.effective;
    const packages = this.catalog?.packages.filter(p => p.package.resource_type === this.resourceType) ?? [];
    const recommendation = this.recommendations.find(r => r.package.digest === this.selected);
    return html`<style>${sharedFieldStyles}${collectionFactsStyles}${MetricConfiguration.componentStyles.map(style => style.cssText).join("\n")}</style><app-card><h2 slot="header">监控与采集</h2>
      <p>采集包不改变标准指标定义。预检仅验证配置与已有能力证据；目标权限需试采验证。</p>
      ${!this.loaded && !this.error ? html`<p role="status">正在读取采集配置…</p>` : nothing}
      ${this.collection ? renderCollectionStatus(this.collection) : nothing}
      ${this.statusError ? html`<p role="alert">${this.statusError}</p>` : nothing}
      ${this.polling ? html`<p role="status">正在确认：发布 → 应用 → 来源验证 → 正式可见（最多刷新 15 次）</p>` : nothing}
      ${this.pollLimitReached ? html`<p role="status">本次自动刷新已结束，采集尚未确认正式可见。请检查阻塞或稍后重试。</p>` : nothing}
      ${this.statusError || this.pollLimitReached || this.collection?.binding.application === 'failed' ? html`<button class="btn" @click=${() => { this.startPolling(); }}>重试状态检查</button>` : nothing}
      ${this.loaded && !this.published ? html`<p>首次绑定：此资源尚未发布采集策略，可选择采集包后预检与试采。</p>` : nothing}
      ${this.loaded && !this.canManage ? html`<p>只读：未获得此资源的管理权限。</p>` : nothing}
      ${this.error ? html`<p role="alert" class="error">${this.error}</p>` : nothing}
      <div class="fields">
        <app-form-field label="采集包 / 模板版本"><select aria-label="采集包 / 模板版本" .value=${this.selected} .disabled=${this.busy || !this.canManage} @change=${(e: Event) => { this.selected = (e.target as HTMLSelectElement).value; this.invalidate(); }}>
          <option value="">请选择已验证兼容的模板</option>
          ${packages.map(p => { const r = this.recommendations.find(r => r.package.digest === p.package.digest); return html`<option value=${p.package.digest} ?disabled=${r?.status !== 'supported'} .selected=${p.package.digest === this.selected}>${packageName(p.package.id)} · ${p.package.version}${r?.recommended ? ' · 推荐' : ''}${r?.status !== 'supported' ? ` · ${label(r?.status)}` : ''}</option>`; })}
        </select></app-form-field>
        <app-form-field label="搜索策略组" .error=${this.groupError}><input type="search" aria-label="搜索策略组" ?disabled=${!this.loaded} .value=${this.groupSearch} @input=${(e: Event) => this.searchGroups((e.target as HTMLInputElement).value)}></app-form-field>
        <app-form-field label="策略组"><select aria-label="策略组" .value=${this.groupId} ?disabled=${this.busy || !this.canManage} @change=${(e: Event) => { this.groupId = (e.target as HTMLSelectElement).value; this.invalidate(); }}>
          <option value="">不继承策略组</option>${this.groupId && !this.groups.some(g => g.id === this.groupId) ? html`<option value=${this.groupId}>已有策略组（当前不可选择其他不可见组）</option>` : nothing}
          ${this.groups.filter(g => g.id === this.groupId || `${g.label ?? ''} ${g.id}`.toLowerCase().includes(this.groupSearch.trim().toLowerCase())).map(g => html`<option value=${g.id}>${g.label || g.id}</option>`)}</select></app-form-field>
      </div>
      ${recommendation ? html`<p>模板覆盖：${recommendation.metrics.map(metricName).join('、') || '未提供指标覆盖'}。核心列表列可能仅部分覆盖。</p>${this.applicabilityMessage(recommendation.applicability)}` : nothing}
      <details><summary>模板兼容性与覆盖说明</summary>${this.recommendations.map(r => html`<p>${packageName(r.package.id)} · ${r.package.version}：${label(r.status)}</p>${this.applicabilityMessage(r.applicability)}`)}</details>
      <metric-policy-fields .overrides=${this.overrides} .values=${resolved?.settings ?? this.catalog?.packages.find(p => p.package.digest === this.selected)?.recommendations ?? {}} .sources=${resolved?.sources ?? {}} .disabled=${this.busy || !this.canManage} @policy-change=${(e: CustomEvent<Overrides>) => { this.overrides = e.detail; this.invalidate(); }}></metric-policy-fields>
      <p>检查 → 试采 → 发布 → 应用 → 正式可见。试采限制执行时间与读取量，不写入正式指标；发布时服务会复核试采后启用调度。</p><div class="actions"><button class="btn btn-refresh" .disabled=${this.busy} @click=${() => this.confirmDiscard(() => void this.load())}>重新加载</button>
        ${this.canManage ? html`<button class="btn" .disabled=${this.busy || !this.selected} @click=${() => this.execute('preview')}>预检与影响预览</button>
          <button class="btn" .disabled=${this.busy || !this.preview} @click=${() => this.execute('trial')}>试采</button>
          <button class="btn-primary" .disabled=${this.busy || !this.preview || !this.publishReady()} @click=${() => this.execute('publish')}>发布</button>` : nothing}
      </div>
      ${this.applicabilityMessage(resolved?.applicability)}
      ${this.preview ? html`<p>影响 ${this.preview.affected_resources} 个资源 · 每小时逻辑读取估算 ${this.preview.requests_per_hour_before} → ${this.preview.requests_per_hour_after}</p>` : nothing}
      ${resolved ? html`<details><summary>高级指标覆盖与能力依据</summary>${resolved.metric_templates.map(t => { const key = `${t.metric.id}@${t.metric.semantic_version}`; return html`<app-form-field label=${metricName(t.metric.id)} hint=${`${label(t.decision)} · ${label(t.capability.status)} · 来源 ${label(resolved.metric_sources[key]?.layer)}`}>
        ${this.toggle(this.overrides.metrics?.[key] ?? 'inherit', value => { this.overrides = { ...this.overrides, metrics: { ...this.overrides.metrics, [key]: value } }; })}
        <details><summary>能力依据与有效期</summary><p>判定 ${t.capability.evaluated_at} · 有效至 ${t.capability.valid_until}</p><pre>${JSON.stringify(t.capability.basis, null, 2)}</pre></details>
      </app-form-field>`; })}</details>` : nothing}
      ${this.trial ? html`<h3>本次试采（不写正式观测）</h3>${this.trial.lifecycle_evidence === 'unavailable' ? html`<p>缺少权威生命周期证据：累计计数能力待验证，暂不生成速率。</p>` : nothing}<p>${this.trialMessage()}</p>${this.applicabilityMessage(this.trial.applicability)}<p>返回 ${this.trial.samples.length} 个样本；${this.trial.attempts.length} 次采集尝试。</p><details><summary>高级诊断与样本</summary><pre>${JSON.stringify(this.trial, null, 2)}</pre></details>` : nothing}
      <h3>最近正式采集尝试</h3><div class="scroll"><app-data-table .loading=${this.busy} .columns=${[{ key: 'collector_id', label: '采集器' }, { key: 'config_revision', label: '配置版本' }, { key: 'status', label: '状态' }, { key: 'error', label: '错误码' }, { key: 'started_at', label: '开始时间' }]} .rows=${this.attempts.map(a => ({ ...a, status: label(String(a.status)), error: a.error ? '采集失败，请检查权限、连接或重新试采' : '—' }))}></app-data-table></div>
    </app-card><app-dialog .open=${this.discardPending} title="放弃未发布的修改？" @app-dialog-close=${(e: Event) => { e.stopPropagation(); this.discardPending = false; this.afterDiscard = null; }}><p>离开后需要重新编辑、预检和试采。</p><div slot="footer"><button class="btn" @click=${() => { this.discardPending = false; this.afterDiscard = null; }}>继续编辑</button><button class="btn-primary" @click=${() => { this.discardPending = false; this.dirty = false; const action = this.afterDiscard; this.afterDiscard = null; action?.(); }}>放弃修改并继续</button></div></app-dialog>`;
  }
}
