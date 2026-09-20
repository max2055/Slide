import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import './app-card.js';
import './app-data-table.js';
import './app-form-field.js';
import './app-empty-state.js';
import './app-dialog.js';
import { metricName, packageName } from './resource-metric-summary.js';
import { showToast } from './app-toast-container.js';

type Pin = { id: string; version: string; digest: string };
import { type Toggle, type Overrides } from './metric-policy-fields.js';
import './metric-policy-fields.js';
export type { Overrides } from './metric-policy-fields.js';
export interface Catalog { packages: Array<{ package: Pin & { resource_type: string; applicability: unknown[]; collectors?: Array<{ mappings?: Array<{ metric: { id: string } }> }> }; recommendations: Record<string, number | boolean>; documentation: Array<{ permissions?: string[]; discovery?: string }> }>;
  metrics: Array<{ id: string; category: string; semantic_version: string; unit: string; kind: string; resource_type: string }> }
interface Resolved { settings: Record<string, number | boolean>; sources: Record<string, { layer: string; id: string }>;
  metric_templates: Array<{ metric: { id: string; semantic_version: string }; enabled: boolean; decision: string;
    capability: { status: string; basis: unknown[]; evaluated_at: string; valid_until: string } }>;
  metric_sources: Record<string, { layer: string; id: string }> }
interface Published { binding: { package: Pin; revision: number; group_id: string | null; overrides: Overrides }; resolved: Resolved;
  application: { status: string; applied_revision: number | null } }
interface Preview { resources: Published[]; affected_resources: number; requests_per_hour_before: number; requests_per_hour_after: number }
interface Trial { lifecycle_evidence?: string; decision: string; error?: string; capabilities: unknown[]; attempts: Array<{ status: string; error?: string }>; samples: unknown[] }
export function trialPassed(trial: Trial | null): boolean { return !!trial && trial.decision === 'attempted' && !trial.error && trial.attempts.length > 0 && trial.attempts.every(a => a.status === 'succeeded'); }
const labels: Record<string,string> = { pending: '等待应用', applied: '已应用', failed: '应用失败', succeeded: '成功', partial: '部分成功', running: '执行中', cancelled: '已取消', supported: '支持', unsupported: '不支持', unknown: '待验证', enabled: '启用', disabled: '停用', package: '采集包', platform: '平台默认', group: '策略组', resource: '本资源覆盖', attempted: '已试采' };
const label = (value: string | undefined) => value ? labels[value] ?? '待确认' : '未知';
export async function metricRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await authFetch(`/api/metrics-v2/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}
export const metricError = (error: unknown) => ({ '401': '登录已失效，请重新登录', '403': '没有此资源的操作权限', '404': '配置或资源不存在',
  '409': '配置已变化或试采正在运行，请重新加载并预览、试采', '400': '配置不符合约束，请检查覆盖值和依赖' }[error instanceof Error ? error.message : ''] ?? '暂时无法完成操作，请稍后重试');

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
  private generation = 0;
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
  override connectedCallback() { super.connectedCallback(); window.addEventListener('beforeunload', this.beforeUnload); window.addEventListener('slide-navigate', this.navigate, true); }
  static componentStyles = [sharedBtnStyles, css`
    :host { display:block; min-width:0; color:var(--text); }
    .actions { display:flex; flex-wrap:wrap; gap:var(--space-sm); margin-block:var(--space-md); }
    .scroll { overflow:auto; max-width:100%; } app-data-table { min-width:36rem; }
    .fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr)); gap:var(--space-md); }
    input,select { box-sizing:border-box; width:100%; color:var(--text); background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-sm); padding:var(--space-sm); }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; }
    p { overflow-wrap:anywhere; } .error { color:var(--danger); }
  `];
  override updated(changes: Map<string, unknown>) {
    if (changes.has('resourceId') || changes.has('resourceType')) void this.load();
  }
  override disconnectedCallback() { this.generation++; window.removeEventListener('beforeunload', this.beforeUnload); window.removeEventListener('slide-navigate', this.navigate, true); super.disconnectedCallback(); }
  private root() { return `resources/${this.resourceType}/${this.resourceId}`; }
  private invalidate() { this.editVersion++; this.dirty = true; this.preview = null; this.trial = null; this.error = ''; }
  private async load() {
    const generation = ++this.generation;
    this.catalog = null; this.canManage = false; this.published = null; this.effective = null; this.overrides = {}; this.attempts = [];
    this.selected = ''; this.groupId = ''; this.busy = false; this.invalidate(); this.loaded = false; this.dirty = false;
    if (!Number.isSafeInteger(this.resourceId) || this.resourceId <= 0) return;
    this.busy = true;
    try {
      const [catalog, access, published, attempts] = await Promise.all([
        metricRequest<Catalog>('config/catalog'), metricRequest<{ can_manage: boolean }>(`config/${this.root()}/access`),
        metricRequest<Published>(`policy/${this.root()}`).catch(e => { if (e.message === '404') return null; throw e; }),
        metricRequest<Record<string, unknown>[]>(`config/${this.root()}/attempts`),
      ]);
      const effective = published ? await metricRequest<{ resolved: Resolved }>(`policy/${this.root()}/effective`) : null;
      if (generation !== this.generation) return;
      this.catalog = catalog; this.canManage = access.can_manage; this.published = published; this.effective = effective?.resolved ?? null;
      this.overrides = structuredClone(published?.binding.overrides ?? {}); this.groupId = published?.binding.group_id ?? '';
      this.selected = published?.binding.package.digest ?? catalog.packages.find(p => p.package.resource_type === this.resourceType)?.package.digest ?? '';
      this.attempts = attempts; this.loaded = true;
    } catch (error) { if (generation === this.generation) this.error = metricError(error); }
    finally { if (generation === this.generation) this.busy = false; }
  }
  private candidate() {
    const pack = this.catalog?.packages.find(p => p.package.digest === this.selected)?.package;
    if (!pack) throw new Error('400');
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
      const result = await metricRequest<Preview & Trial>(`${operation === 'trial' ? 'config' : 'policy'}/${this.root()}/${operation}`, this.candidate());
      if (generation !== this.generation || editVersion !== this.editVersion) return;
      if (operation === 'preview') this.preview = result;
      if (operation === 'trial') this.trial = result;
      if (operation === 'publish') { this.dirty = false; showToast('已发布，等待采集器应用', 'success'); await this.load(); }
    } catch (error) { if (generation === this.generation) { this.invalidate(); this.error = metricError(error); } }
    finally { if (generation === this.generation) this.busy = false; }
  }
  private toggle(value: Toggle, update: (value: Toggle) => void) {
    return html`<select aria-label="指标覆盖" .value=${value} .disabled=${this.busy || !this.canManage} @change=${(e: Event) => { update((e.target as HTMLSelectElement).value as Toggle); this.invalidate(); }}>
      <option value="inherit">继承</option><option value="enable">启用</option><option value="disable">停用</option></select>`;
  }
  render() {
    const resolved = this.preview?.resources[0]?.resolved ?? this.effective;
    const packages = this.catalog?.packages.filter(p => p.package.resource_type === this.resourceType && (!this.published || p.package.id === this.published.binding.package.id)) ?? [];
    return html`<style>${MetricConfiguration.componentStyles.map(style => style.cssText).join("\n")}</style><app-card><h2 slot="header">采集配置</h2>
      <p>采集包不改变标准指标定义。预检仅验证配置与已有能力证据；目标权限需试采验证。</p>
      ${this.published?.application.status === 'failed' ? html`<p role="alert">采集器应用失败。请重新加载状态，检查连接和权限后重新预检、试采。</p>` : nothing}<p>当前发布版本 ${this.published?.binding.revision ?? '未绑定'} · 当前应用版本 ${this.published?.application.applied_revision ?? '未应用'} · ${this.published ? label(this.published.application.status) : '未发布'}</p>
      ${this.loaded && !this.canManage ? html`<p>只读：未获得此资源的管理权限。</p>` : nothing}
      ${this.error ? html`<p role="alert" class="error">${this.error}</p>` : nothing}
      <div class="fields">
        <app-form-field label="采集包 / 模板版本"><select aria-label="采集包 / 模板版本" .value=${this.selected} .disabled=${this.busy || !this.canManage} @change=${(e: Event) => { this.selected = (e.target as HTMLSelectElement).value; this.invalidate(); }}>
          ${packages.map(p => html`<option value=${p.package.digest}>${packageName(p.package.id)} · ${p.package.version} (${p.package.id})</option>`)}
        </select></app-form-field>
        <app-form-field label="策略组" hint="策略组选择暂不可用；现有绑定保留"><span>${this.groupId || '未绑定'}</span><details><summary>高级：按标识绑定</summary><p>当前服务尚未提供策略组列表，请向管理员获取标识。</p><input aria-label="策略组标识" .value=${this.groupId} .disabled=${this.busy || !this.canManage} @input=${(e: Event) => { this.groupId = (e.target as HTMLInputElement).value; this.invalidate(); }}></details></app-form-field>
      </div>
      <metric-policy-fields .overrides=${this.overrides} .values=${resolved?.settings ?? this.catalog?.packages.find(p => p.package.digest === this.selected)?.recommendations ?? {}} .sources=${resolved?.sources ?? {}} .disabled=${this.busy || !this.canManage} @policy-change=${(e: CustomEvent<Overrides>) => { this.overrides = e.detail; this.invalidate(); }}></metric-policy-fields>
      <p>编辑配置 → 预检与影响 → 试采 → 发布并检查应用状态。试采限制执行时间与读取量，不写入正式指标。</p><div class="actions"><button class="btn" .disabled=${this.busy} @click=${() => this.confirmDiscard(() => void this.load())}>重新加载</button>
        ${this.canManage ? html`<button class="btn" .disabled=${this.busy} @click=${() => this.execute('preview')}>预检与影响预览</button>
          <button class="btn" .disabled=${this.busy || !this.preview} @click=${() => this.execute('trial')}>试采</button>
          <button class="btn-primary" .disabled=${this.busy || !this.preview || !this.publishReady()} @click=${() => this.execute('publish')}>发布</button>` : nothing}
      </div>
      ${this.preview ? html`<p>影响 ${this.preview.affected_resources} 个资源 · 每小时逻辑读取估算 ${this.preview.requests_per_hour_before} → ${this.preview.requests_per_hour_after}</p>` : nothing}
      ${resolved ? html`<h3>指标能力、依据与覆盖</h3>${resolved.metric_templates.map(t => { const key = `${t.metric.id}@${t.metric.semantic_version}`; return html`<app-form-field label=${metricName(t.metric.id)} hint=${`${label(t.decision)} · ${label(t.capability.status)} · 来源 ${label(resolved.metric_sources[key]?.layer)}`}>
        ${this.toggle(this.overrides.metrics?.[key] ?? 'inherit', value => { this.overrides = { ...this.overrides, metrics: { ...this.overrides.metrics, [key]: value } }; })}
        <details><summary>能力依据与有效期</summary><p>判定 ${t.capability.evaluated_at} · 有效至 ${t.capability.valid_until}</p><pre>${JSON.stringify(t.capability.basis, null, 2)}</pre></details>
      </app-form-field>`; })}` : nothing}
      ${this.trial ? html`<h3>本次试采（不写正式观测）</h3>${this.trial.lifecycle_evidence === 'unavailable' ? html`<p>缺少权威生命周期证据：累计计数能力待验证，暂不生成速率。</p>` : nothing}<p>${this.trial.error === 'timeout' ? '尝试失败：超时，并非永久不支持' : this.trial.decision === 'disabled' && this.publishReady() ? '已验证停用配置，不执行采集，可以发布' : trialPassed(this.trial) ? '试采成功，可以发布' : '试采未完全成功，请检查原因并重新试采'}</p><p>返回 ${this.trial.samples.length} 个样本；${this.trial.attempts.length} 次采集尝试。</p><details><summary>高级诊断与样本</summary><pre>${JSON.stringify(this.trial, null, 2)}</pre></details>` : nothing}
      <h3>最近正式采集尝试</h3><div class="scroll"><app-data-table .loading=${this.busy} .columns=${[{ key: 'collector_id', label: '采集器' }, { key: 'config_revision', label: '配置版本' }, { key: 'status', label: '状态' }, { key: 'error', label: '错误码' }, { key: 'started_at', label: '开始时间' }]} .rows=${this.attempts.map(a => ({ ...a, status: label(String(a.status)), error: a.error ? '采集失败，请检查权限、连接或重新试采' : '—' }))}></app-data-table></div>
    </app-card><app-dialog .open=${this.discardPending} title="放弃未发布的修改？" @app-dialog-close=${() => { this.discardPending = false; this.afterDiscard = null; }}><p>离开后需要重新编辑、预检和试采。</p><div slot="footer"><button class="btn" @click=${() => { this.discardPending = false; this.afterDiscard = null; }}>继续编辑</button><button class="btn-primary" @click=${() => { this.discardPending = false; this.dirty = false; const action = this.afterDiscard; this.afterDiscard = null; action?.(); }}>放弃修改并继续</button></div></app-dialog>`;
  }
}
