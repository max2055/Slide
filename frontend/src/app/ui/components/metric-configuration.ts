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
import { collectionLayoutStyles } from './collection-layout-styles.js';
import { icons } from '../../../icons.js';
import './app-badge.js';
import { showToast } from './app-toast-container.js';

import { metricRequest, metricError, MetricRequestError, recommendationOptions, coverageAvailability, readCollectionStatus, statusLabel,
  type Catalog, type Applicability, type Resolved, type Published, type CollectionStatus, type Recommendation, type RecommendationResult, type PolicyGroup } from './metric-api.js';
export { metricRequest, metricError } from './metric-api.js';
export type { Catalog } from './metric-api.js';
import { type Toggle, type Overrides } from './metric-policy-fields.js';
import './metric-policy-fields.js';
export type { Overrides } from './metric-policy-fields.js';
interface Preview { resources: Published[]; affected_resources: number; requests_per_hour_before: number; requests_per_hour_after: number }
interface TrialSample { metric?: { id: string }; value?: unknown; quality?: { status: string; reason?: string } }
interface Trial { applicability?: Applicability[]; lifecycle_evidence?: string; decision: string; error?: string; capabilities: unknown[]; attempts: Array<{ collector_id?: string; status: string; error?: string }>; samples: TrialSample[] }
const goodSample = (sample: TrialSample) => sample.value != null && sample.quality?.status === 'good';
// Match the server's activation evidence gate; activation rechecks live permission and CAS.
export function trialPassed(trial: Trial | null): boolean {
  return !!trial && trial.decision === 'attempted' && !trial.error
    && trial.samples.some(goodSample) && trial.attempts.some(a => ['succeeded', 'partial'].includes(a.status));
}
function trialComplete(trial: Trial): boolean {
  return trialPassed(trial) && trial.attempts.every(a => a.status === 'succeeded' && !a.error) && trial.samples.every(goodSample);
}
const labels: Record<string,string> = { pending: '等待应用', applied: '已应用', failed: '应用失败', succeeded: '成功', partial: '部分成功', running: '执行中', cancelled: '已取消', supported: '支持', unsupported: '不支持', unknown: '待验证', enabled: '启用', disabled: '停用', package: '采集包', platform: '平台默认', group: '策略组', resource: '本资源覆盖', attempted: '已试采' };
const label = (value: string | undefined) => value ? labels[value] ?? '待确认' : '未知';
@customElement('metric-configuration')
export class MetricConfiguration extends LitElement {
  @property() resourceType = 'instance';
  @property({ type: Number }) resourceId = 0;
  @property({ type: Boolean }) connectionPending = false;
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
    this.recommendations = []; this.selected = ''; this.groupId = ''; this.dirty = false; this.loaded = false;
    this.error = '权限或登录状态已变更，请重新打开资源后读取配置';
  };
  private editVersion = 0;
  @state() private loaded = false;
  @state() private dirty = false;
  @state() private discardPending = false;
  @state() private flowOpen = false;
  @state() private activationStep = 0;
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
    if (changes.has('connectionPending') && this.connectionPending) {
      // Connection edits invalidate checks, but do not create a collection draft.
      const dirty = this.dirty;
      this.invalidate();
      this.dirty = dirty;
    }
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
  private invalidate() { this.editVersion++; this.dirty = true; this.preview = null; this.trial = null; this.activationStep = 0; this.error = ''; }
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
  private globalBlocksCandidate() {
    return this.collection?.effective_enabled.global_enabled === false
      && this.preview?.resources[0]?.resolved.settings.enabled !== false;
  }
  private async execute(operation: 'preview' | 'trial' | 'publish') {
    if (this.busy || !this.canManage || this.connectionPending) return;
    if (operation !== 'preview' && this.globalBlocksCandidate()) return;
    if (operation === 'trial' && !this.preview || operation === 'publish' && (!this.preview || !this.publishReady())) return;
    const generation = this.generation, editVersion = this.editVersion;
    this.busy = true; this.error = '';
    try {
      const path = operation === 'publish' ? `config/${this.root()}/activate` : `${operation === 'trial' ? 'config' : 'policy'}/${this.root()}/${operation}`;
      const result = await metricRequest<Preview & Trial>(path, this.candidate());
      if (generation !== this.generation || editVersion !== this.editVersion) return;
      if (operation === 'preview') { this.trial = null; this.preview = result; this.activationStep = 1; }
      if (operation === 'trial') { this.trial = result; this.activationStep = this.publishReady() ? 2 : 1; }
      if (operation === 'publish') {
        this.dirty = false; this.preview = null; this.trial = null;
        showToast('采集配置已发布，正在确认应用与正式数据状态', 'success');
        await this.load();
        this.activationStep = 3;
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
    const diagnostics = errors.map(error => messages[error!] ?? '实际采集失败，请检查诊断后重试。').join(' ');
    if (trialPassed(trial)) return trialComplete(trial) ? '试采成功，可以发布' : '可发布有效指标，部分指标仍失败/待验证。请逐项核对下方采集结果；发布不代表全部指标可用。';
    if (errors.length) return diagnostics;
    if (!trial.samples.length) return '试采未返回样本，不能发布。请检查指标是否启用并重新试采。';
    return '试采缺少有效样本或成功采集尝试，不能发布。请检查原因并重新试采';
  }
  private applicabilityMessage(checks: Applicability[] | undefined) {
    return checks?.filter(c => c.status !== 'supported').map(c => html`<p role="status">
      ${c.attribute === 'db.version' ? c.status === 'unknown' ? '版本待验证' : '版本不适用' : '资源适用性待确认'}：当前${c.attribute === 'db.version' ? '数据库版本' : c.attribute === 'db.engine' ? '数据库类型' : '资源属性'} ${c.value ?? '未知'}；
      支持范围 ${c.supported_values.join(' / ')}。
      ${c.status === 'unknown' ? '请补全或刷新资源信息并重新预检。' : '请选择支持当前版本的采集包；未验证版本需先完成兼容验证，不能修改资源版本绕过检查。'}
    </p>`);
  }
  private toggle(value: Toggle, update: (value: Toggle) => void) {
    return html`<select aria-label="指标覆盖" .value=${value} .disabled=${this.busy || !this.canManage || this.connectionPending} @change=${(e: Event) => { update((e.target as HTMLSelectElement).value as Toggle); this.invalidate(); }}>
      <option value="inherit">继承</option><option value="enable">启用</option><option value="disable">停用</option></select>`;
  }
  private renderCoverage() {
    const recommendation = this.recommendations.find(r => r.package.digest === this.selected);
    const metrics = [...new Set([...(recommendation?.metrics ?? []), ...(recommendation?.missing_core_metrics ?? [])])];
    return html`<app-card><div class="section-title"><h2>指标覆盖</h2><span class="muted">候选模板 · 缺口单独说明</span></div>
      <div class="coverage-table">${metrics.map(id => {
        const covered = recommendation?.metrics.includes(id);
        const evidence = this.selected === this.collection?.binding.package?.digest ? this.collection?.coverage.find(c => c.metric.id === id) : undefined;
        return html`<div><strong>${metricName(id)}</strong><app-badge variant=${covered ? 'ok' : 'muted'}>${covered ? '已覆盖' : evidence?.state === 'unsupported' ? '版本不支持' : '模板未覆盖'}</app-badge><span>${covered ? '由候选模板提供；正式数据状态单独确认' : evidence?.state === 'unsupported' ? '当前版本能力未提供' : '绑定不表示所有指标都有值'}</span></div>`;
      })}</div>${!metrics.length ? html`<p class="muted">尚无可核实的覆盖信息，请先选择兼容模板。</p>` : nothing}</app-card>`;
  }
  private renderFlow() {
    const steps = ['检查兼容性与权限', '执行试采', '发布并应用配置', '等待正式采集'];
    return html`<app-dialog .open=${this.flowOpen} title="检查并启用采集" size="xl" @app-dialog-close=${(e: Event) => { e.stopPropagation(); this.flowOpen = false; }}>
      <p class="muted">${packageName(this.catalog?.packages.find(p => p.package.digest === this.selected)?.package.id ?? '')} · 配置与正式采集分别确认</p>
      <ol class="activation-steps">${steps.map((text, i) => html`<li class=${i < this.activationStep ? 'done' : i === this.activationStep ? 'current' : ''}><span class="step-number">${i < this.activationStep ? '✓' : i + 1}</span><div><strong>${text}</strong><p>${i < this.activationStep ? ['兼容与影响检查完成，目标权限仍由试采确认', this.trial && !trialComplete(this.trial) ? '有效指标可发布，部分指标仍失败/待验证' : '有效样本门禁通过，完整性以正式证据为准', '配置已发布，实际应用结果以运行状态为准'][i] : i === this.activationStep ? ['不更改正式配置', '验证连接、权限和本次样本', '服务复核试采与配置版本后发布', '试采成功不等于持续采集就绪'][i] : '等待前一步完成'}</p></div></li>`)}</ol>
      ${this.error ? html`<p class="notice error" role="alert">${this.error}</p>` : nothing}
      ${this.globalBlocksCandidate() ? html`<p class="notice" role="status">全局采集已关闭，不能继续启用；请联系平台运维。</p>` : nothing}
      ${this.preview ? html`<p>影响 ${this.preview.affected_resources} 个资源 · 每小时逻辑读取估算 ${this.preview.requests_per_hour_before ?? '未知'} → ${this.preview.requests_per_hour_after ?? '未知'}</p>${this.applicabilityMessage(this.preview.resources[0]?.resolved.applicability)}` : nothing}
      ${this.trial ? html`<h3>本次试采（不写正式观测）</h3><p role="status">${this.trialMessage()}</p>
        <ul aria-label="逐项采集结果">${this.trial.attempts.map((attempt, i) => html`<li>${attempt.collector_id ?? `采集项 ${i + 1}`}：${attempt.status === 'failed' ? '采集失败' : label(attempt.status)}${attempt.error ? html` · ${attempt.error}` : nothing}</li>`)}
        ${this.trial.samples.filter(sample => !goodSample(sample)).map(sample => html`<li>${metricName(sample.metric?.id ?? '未知指标')}：待验证${sample.quality?.reason ? html` · ${sample.quality.reason}` : nothing}</li>`)}</ul>
        ${this.applicabilityMessage(this.trial.applicability)}<p>返回 ${this.trial.samples.length} 个样本；${this.trial.attempts.length} 次采集尝试。</p>${this.trial.lifecycle_evidence === 'unavailable' ? html`<p>缺少权威生命周期证据：累计计数能力待验证，暂不生成速率。</p>` : nothing}<details><summary>高级诊断与样本</summary><pre>${JSON.stringify(this.trial, null, 2)}</pre></details>` : nothing}
      ${this.activationStep === 3 && this.collection ? renderCollectionStatus(this.collection) : nothing}
      <div slot="footer" class="actions"><button class="btn" @click=${() => { this.flowOpen = false; }}>关闭</button>
        ${this.canManage ? html`<button class="btn" .disabled=${this.busy || this.connectionPending || !this.selected} @click=${() => this.execute('preview')}>预检与影响预览</button>
        <button class="btn" .disabled=${this.busy || this.connectionPending || this.globalBlocksCandidate() || !this.preview} @click=${() => this.execute('trial')}>试采</button>
        <button class="btn-primary" .disabled=${this.busy || this.connectionPending || this.globalBlocksCandidate() || !this.preview || !this.publishReady()} @click=${() => this.execute('publish')}>发布</button>` : nothing}</div>
    </app-dialog>`;
  }
  render() {
    const resolved = this.preview?.resources[0]?.resolved ?? (this.selected === this.published?.binding.package.digest ? this.effective : null);
    const packages = this.catalog?.packages.filter(p => p.package.resource_type === this.resourceType) ?? [];
    const selectedPackage = packages.find(p => p.package.digest === this.selected);
    const recommendation = this.recommendations.find(r => r.package.digest === this.selected);
    const status = this.collection;
    const globalBlocked = status?.effective_enabled.global_enabled === false;
    return html`<style>${sharedFieldStyles}${collectionFactsStyles}${collectionLayoutStyles}
      .scroll{overflow:auto;max-width:100%} .scroll app-data-table{min-width:36rem}
      .group-picker input{margin-bottom:var(--space-sm)}
      .state-card .collection-facts{grid-template-columns:1fr;gap:var(--space-md)}
      .state-card .collection-facts>div{display:flex;gap:var(--space-sm);justify-content:space-between}.state-card dd{text-align:right;font-size:12px;margin:0}
      .state-card .collection-facts dt{flex-shrink:0} .state-card .collection-facts dd{max-width:65%}
      ${sharedBtnStyles}
    </style>
    ${!this.loaded && !this.error ? html`<div class="notice" role="status">正在读取采集配置…</div>` : nothing}
    ${this.loaded && !this.canManage ? html`<p class="notice">只读：未获得此资源的管理权限。</p>` : nothing}
    ${this.error ? html`<p class="notice error" role="alert">${this.error}</p>` : nothing}
    ${globalBlocked ? html`<p class="notice" role="status">全局采集已关闭；本资源发布不能解除全局暂停，请联系平台运维。</p>` : nothing}
    <div class="edit-grid"><section class="stack">
      <app-card><div class="section-title"><div><span class="eyebrow">采集配置</span><h2>选择适合此对象的采集模板</h2></div><app-badge variant=${this.dirty ? 'warn' : 'muted'}>${this.dirty ? '有未保存修改' : !this.loaded || !status ? '等待确认' : statusLabel(status.binding.state)}</app-badge></div>
        <p class="section-description">按引擎与版本匹配。模板版本表示能力变化，与指标体系无关。</p>
        ${this.loaded && status?.binding.state === 'unbound' ? html`<p class="muted">首次绑定：此资源尚未发布采集策略。</p>` : nothing}
        <app-form-field label="采集模板"><select aria-label="采集包 / 模板版本" .value=${this.selected} .disabled=${this.busy || !this.canManage || this.connectionPending} @change=${(e: Event) => { this.selected = (e.target as HTMLSelectElement).value; this.invalidate(); }}>
          <option value="">请选择已验证兼容的模板</option>
          ${packages.map(p => { const r = this.recommendations.find(r => r.package.digest === p.package.digest); return html`<option value=${p.package.digest} ?disabled=${r?.status !== 'supported'} .selected=${p.package.digest === this.selected}>${packageName(p.package.id)} · ${p.package.version}${r?.recommended ? '（推荐）' : ''}${r?.status !== 'supported' ? ` · ${label(r?.status)}` : ''}</option>`; })}
        </select></app-form-field>
        ${recommendation ? html`<div class="template-preview"><div class="template-heading"><div class="template-icon">${icons[this.resourceType === 'server' ? 'server' : 'database']}</div><div><h3>${packageName(recommendation.package.id)}</h3><p class="muted">${recommendation.applicability.map(c => `${c.value ?? '未知'} · ${label(c.status)}`).join(' / ') || '按服务端兼容性证据匹配'}</p></div><app-badge variant=${recommendation.status === 'supported' ? 'ok' : 'warn'}>${recommendation.status === 'supported' ? '兼容' : label(recommendation.status)}</app-badge></div>
          <div class="coverage-line"><span>本模板覆盖</span><strong>${recommendation.metrics.slice(0, 3).map(metricName).join('、') || '未提供指标覆盖'}${recommendation.metrics.length > 3 ? html`<span class="muted"> 等 ${recommendation.metrics.length} 项，完整列表见下方指标覆盖</span>` : nothing}</strong></div>
          <div class="coverage-line"><span>仍有缺口</span><span>${recommendation.missing_core_metrics?.length ? recommendation.missing_core_metrics.map(metricName).join('、') : '未报告核心指标缺口；实际覆盖与样本质量单独确认'}</span></div>
        </div>` : nothing}
        <div class="section-divider"></div>
        <metric-policy-fields .compact=${true} .overrides=${this.overrides} .values=${resolved?.settings ?? selectedPackage?.recommendations ?? {}} .sources=${resolved?.sources ?? {}} .disabled=${this.busy || !this.canManage || this.connectionPending} @policy-change=${(e: CustomEvent<Overrides>) => { this.overrides = e.detail; this.invalidate(); }}>
        <div slot="group" class="group-picker"><app-form-field label="策略组（可选）" .error=${this.groupError}><input type="search" aria-label="搜索策略组" placeholder="搜索或选择策略组" ?disabled=${!this.loaded} .value=${this.groupSearch} @input=${(e: Event) => this.searchGroups((e.target as HTMLInputElement).value)}><select aria-label="策略组" .value=${this.groupId} ?disabled=${this.busy || !this.canManage || this.connectionPending} @change=${(e: Event) => { this.groupId = (e.target as HTMLSelectElement).value; this.invalidate(); }}>
          <option value="">不继承策略组</option>${this.groupId && !this.groups.some(g => g.id === this.groupId) ? html`<option value=${this.groupId}>已有策略组（当前不可选择其他不可见组）</option>` : nothing}
          ${this.groups.filter(g => g.id === this.groupId || `${g.label ?? ''} ${g.id}`.toLowerCase().includes(this.groupSearch.trim().toLowerCase())).map(g => html`<option value=${g.id} .selected=${g.id === this.groupId}>${g.label || g.id}</option>`)}</select></app-form-field></div></metric-policy-fields>
        <p class="muted">策略组用于统一管理；对象停用设置优先。修改候选后需重新检查与试采。</p>
        <details class="advanced"><summary>模板兼容性与覆盖说明</summary>${this.recommendations.map(r => html`<p>${packageName(r.package.id)} · ${r.package.version}：${label(r.status)}</p>${this.applicabilityMessage(r.applicability)}`)}
          ${resolved ? html`<h3>高级指标覆盖与能力依据</h3>${resolved.metric_templates.map(t => { const key = `${t.metric.id}@${t.metric.semantic_version}`; return html`<app-form-field label=${metricName(t.metric.id)} hint=${`${label(t.decision)} · ${label(t.capability.status)} · 来源 ${label(resolved.metric_sources[key]?.layer)}`}>${this.toggle(this.overrides.metrics?.[key] ?? 'inherit', value => { this.overrides = { ...this.overrides, metrics: { ...this.overrides.metrics, [key]: value } }; })}<details><summary>能力依据与有效期</summary><p>判定 ${t.capability.evaluated_at} · 有效至 ${t.capability.valid_until}</p><pre>${JSON.stringify(t.capability.basis, null, 2)}</pre></details></app-form-field>`; })}` : nothing}
        </details>
        <div class="editor-actions"><span class="muted">${this.dirty ? '修改后将重新检查与试采' : `配置版本 ${this.published?.binding.revision ?? '—'} · 无未保存修改`}</span><div class="actions"><button class="btn" .disabled=${this.busy || !this.dirty} @click=${() => this.confirmDiscard(() => void this.load())}>放弃修改</button><button class="btn-primary" .disabled=${this.busy || !this.canManage || this.connectionPending || !this.selected} @click=${() => { this.flowOpen = true; }}>检查并启用</button></div></div>
      </app-card>${this.renderCoverage()}
    </section><aside class="stack"><app-card class="state-card"><span class="eyebrow">当前运行状态</span>${status ? html`<app-badge variant=${status.formal_visibility.state === 'available' ? 'ok' : 'muted'}>${status.formal_visibility.state === 'pending' ? '等待正式数据' : statusLabel(status.formal_visibility.state)}</app-badge>` : nothing}<p class="muted">已生效的配置与证据；主列候选修改尚未发布。</p>
      ${status ? renderCollectionStatus(status) : html`<p>采集状态未知</p>`}
      <div class="actions"><button class="btn btn-refresh" .disabled=${this.busy} @click=${() => void this.refreshStatus()}>刷新采集状态</button></div>
      ${this.statusError ? html`<p role="alert">${this.statusError}</p>` : nothing}
      ${this.polling ? html`<p role="status">正在确认：发布 → 应用 → 来源验证 → 正式可见（最多刷新 15 次）</p>` : nothing}
      ${this.pollLimitReached ? html`<p role="status">本次自动刷新已结束，采集尚未确认正式可见。</p>` : nothing}
      ${this.statusError || this.pollLimitReached || status?.binding.application === 'failed' ? html`<button class="btn" @click=${() => this.startPolling()}>重试状态检查</button>` : nothing}
    </app-card><section class="quiet-panel"><h3>从配置到正式数据</h3><p class="muted">步骤指示对应本次编辑；当前生效状态见上方。</p><ol class="vertical-steps">${['检查兼容性', '执行试采', '发布并应用', '等待正式数据'].map((text, i) => html`<li data-step=${i + 1} class=${i < this.activationStep ? 'done' : i === this.activationStep ? 'current' : ''}>${text}<span>${['确认引擎、版本与采集权限', '检查连接与本次样本', '使配置在此对象生效', '试采成功不等于持续采集就绪'][i]}</span></li>`)}</ol></section></aside></div>
    <details class="technical"><summary>最近正式采集尝试与技术证据</summary><div class="scroll"><app-data-table .loading=${this.busy} .columns=${[{ key: 'collector_id', label: '采集器' }, { key: 'config_revision', label: '配置版本' }, { key: 'status', label: '状态' }, { key: 'error', label: '错误码' }, { key: 'started_at', label: '开始时间' }]} .rows=${this.attempts.map(a => ({ ...a, status: label(String(a.status)), error: a.error ? '采集失败，请检查权限、连接或重新试采' : '—' }))}></app-data-table></div><button class="btn btn-refresh" .disabled=${this.busy} @click=${() => this.confirmDiscard(() => void this.load())}>重新加载</button></details>
    ${this.renderFlow()}
    <app-dialog .open=${this.discardPending} title="放弃未发布的修改？" @app-dialog-close=${(e: Event) => { e.stopPropagation(); this.discardPending = false; this.afterDiscard = null; }}><p>离开后需要重新编辑、预检和试采。</p><div slot="footer"><button class="btn" @click=${() => { this.discardPending = false; this.afterDiscard = null; }}>继续编辑</button><button class="btn-primary" @click=${() => { this.discardPending = false; this.dirty = false; const action = this.afterDiscard; this.afterDiscard = null; action?.(); }}>放弃修改并继续</button></div></app-dialog>`;
  }
}
