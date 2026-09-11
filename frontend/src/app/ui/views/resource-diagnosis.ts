import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { safeDashboardReturn } from './dashboard-model.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { permissionMatches } from '../settings-navigation.js';
import '../components/app-form-field.js';
import '../components/app-empty-state.js';
import '../components/app-badge.js';
import './resource-evaluation.js';
import './source-manifest.js';

type ResourceType = 'instance' | 'server' | 'network_device';
interface ResourceRef { type: ResourceType; id: number }
interface ResourceDetail { resource: ResourceRef; label: string; status: string; attributes: Record<string, unknown> }
interface EvidenceItem {
  id: string; kind: string; status: string; quality: string; observedAt: string | null; validUntil: string | null;
  source: string; correlationId: string; provenance: unknown; dimensions?: Record<string, string>;
  payload: { metricId?: string; value?: number | null; statement?: string; reason?: string };
}
interface EvidenceBundle { generatedAt: string; facts: EvidenceItem[]; inferences: EvidenceItem[]; hypotheses: EvidenceItem[]; gaps: string[]; truncated: boolean }
interface DiagnosticPack { relations: Array<{ source: ResourceRef; target: ResourceRef; relationType: string; provenance: string }>; relatedEvidence: Array<{ resource: ResourceDetail }>; gaps: Array<{ scope: string; code: string }>; truncated: boolean }
const resourceLabels: Record<ResourceType, string> = { instance: '数据库', server: '服务器', network_device: '网络设备' };
const key = (ref: ResourceRef) => `${ref.type}:${ref.id}`;
const evidenceLabels: Record<string, string> = { good: '有效', degraded: '质量降级', partial: '部分可用', invalid: '无效', unknown: '未知', fact: '事实', inference: '推论', hypothesis: '假设', online: '在线', offline: '离线', active: '配置启用', unreachable: '不可达', error: '异常', NO_EVIDENCE_IN_WINDOW: '有效窗口内没有证据', EVIDENCE_QUALITY_UNKNOWN: '证据质量未知', OBSERVATIONS_EMPTY: '缺少观测', OBSERVATIONS_STALE: '观测已过期', OBSERVATIONS_UNAVAILABLE: '观测读取失败', RELATIONS_EMPTY: '未建立关系', ALERTS_EMPTY: '未读取到告警', EVIDENCE_PACK_TRUNCATED: '证据包已截断' };


@customElement('resource-diagnosis-page')
export class ResourceDiagnosisPage extends LitElement {
  @state() private resources: ResourceDetail[] = [];
  @state() private selected: ResourceRef | null = null;
  @state() private evidence: EvidenceBundle | null = null;
  @state() private pack: DiagnosticPack | null = null;
  @state() private loading = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private agentResult: { analysisId: number; status: string; result?: unknown; resource?: ResourceRef; createdAt?: string; completedAt?: string; error?: string } | null = null;
  @state() private taskMessage = '';
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private statusController: AbortController | null = null;
  private statusDeadline = 0;
  @state() private search = '';
  @state() private permissions: Set<string> = new Set();
  private requestVersion = 0;
  private readonly onPopState = () => { this.readSelection(); void this.loadEvidence(); };
  private readonly onPermissions = () => { this.readPermissions(); };

  static styles = [sharedBtnStyles, css`
    :host { display: block; min-width: 0; color: var(--text); }
    h1 { font-size: 22px; color: var(--text-strong); margin: 0; }
    h2 { font-size: 16px; margin: 0 0 var(--space-md); }
    header, .actions, .metadata { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm); }
    header { justify-content: space-between; margin-bottom: var(--space-lg); }
    .picker { display: grid; grid-template-columns: 1fr 2fr; gap: var(--space-md); }
    select, input { box-sizing: border-box; width: 100%; min-width: 0; padding: var(--space-sm); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font: inherit; }
    section { border-top: 1px solid var(--border); padding: var(--space-lg) 0; }
    .metadata, time { color: var(--muted); font-size: 12px; }
    details { padding: var(--space-md) 0; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
    summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: baseline; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
    code, p, a { overflow-wrap: anywhere; }
    a { color: var(--accent); }
    svg { width: 16px; height: 16px; }
    .skeleton { height: 100px; background: var(--border); opacity: .4; }
    .error { color: var(--danger); }
    @media (max-width: 640px) { .picker { grid-template-columns: minmax(0, 1fr); } }
  `];

  override connectedCallback() {
    super.connectedCallback();
    this.readPermissions(); this.readSelection();
    window.addEventListener('popstate', this.onPopState);
    window.addEventListener('slide-permissions-loaded', this.onPermissions);
    void this.load();
  }
  override disconnectedCallback() {
    this.requestVersion++; this.stopStatus();
    window.removeEventListener('popstate', this.onPopState);
    window.removeEventListener('slide-permissions-loaded', this.onPermissions);
    super.disconnectedCallback();
  }
  private readPermissions() {
    try { this.permissions = new Set(JSON.parse(localStorage.getItem('permissions') ?? '[]')); } catch { this.permissions = new Set(); }
  }
  private readSelection() {
    const params = new URL(location.href).searchParams;
    const type = params.get('resourceType') as ResourceType;
    const id = Number(params.get('resourceId'));
    this.selected = Object.hasOwn(resourceLabels, type) && Number.isSafeInteger(id) && id > 0 ? { type, id } : null;
  }
  private async load() {
    this.loading = true; this.error = '';
    try {
      const response = await authFetch('/api/resources');
      if (!response.ok) throw new Error(`资源加载失败 (${response.status})`);
      this.resources = (await response.json()).items;
      await this.loadEvidence();
    } catch (error) { this.error = String(error); } finally { this.loading = false; }
  }
  private async loadEvidence() {
    const version = ++this.requestVersion;
    this.stopStatus(); this.taskMessage = '';
    this.evidence = null; this.pack = null; this.agentResult = null; this.error = ''; this.busy = false;
    if (!this.selected) { this.loading = false; return; }
    this.loading = true;
    try {
      const response = await authFetch(`/api/resources/${this.selected.type}/${this.selected.id}/evidence`);
      if (!response.ok) throw new Error(`证据加载失败 (${response.status})`);
      const evidence = await response.json();
      if (version === this.requestVersion) {
        this.evidence = evidence;
        const id = Number(new URL(location.href).searchParams.get('analysisId'));
        if (Number.isSafeInteger(id) && id > 0) { this.agentResult = { analysisId: id, status: 'unknown' }; this.startStatus(); }
      }
    } catch (error) { if (version === this.requestVersion) this.error = String(error); }
    finally { if (version === this.requestVersion) this.loading = false; }
  }
  private selectResource(value: string) {
    const [type, id] = value.split(':');
    const url = new URL(location.href);
    url.searchParams.set('resourceType', type); url.searchParams.set('resourceId', id); url.searchParams.delete('analysisId');
    history.pushState({}, '', url); this.readSelection(); void this.loadEvidence();
  }
  private async diagnose(agent = false) {
    if (!this.selected || this.busy || (agent && this.taskActive())) return;
    const version = this.requestVersion;
    this.busy = true; this.error = '';
    try {
      const response = await authFetch(`/api/resources/${this.selected.type}/${this.selected.id}/${agent ? 'diagnose-agent' : 'diagnose'}`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) {
        if (agent && Number.isSafeInteger(result.analysisId) && result.analysisId > 0 && version === this.requestVersion) { this.agentResult = { analysisId: result.analysisId, status: 'unknown' }; this.persistAnalysisId(result.analysisId); this.startStatus(); }
        throw new Error(response.status === 403 ? '无诊断权限，资源与证据浏览仍可用' : response.status === 503 ? 'Agent 或模型暂不可用，请检查配置；已创建的任务可查询状态' : `诊断请求失败 (${response.status})`);
      }
      if (version !== this.requestVersion) return;
      if (agent) {
        if (!Number.isSafeInteger(result.analysisId) || result.analysisId <= 0) throw new Error('未取得有效任务 ID，请检查服务状态');
        this.agentResult = { analysisId: result.analysisId, status: 'pending' };
        this.persistAnalysisId(result.analysisId);
        this.taskMessage = result.status === 'cached' ? '已复用任务，正在查询真实状态' : '已受理，正在查询真实状态';
        this.startStatus();
      } else this.pack = result;
    } catch (error) { if (version === this.requestVersion) this.error = String(error); }
    finally { if (version === this.requestVersion) this.busy = false; }
  }
  private taskActive() { return this.agentResult !== null && !['completed', 'failed'].includes(this.agentResult.status); }
  private persistAnalysisId(id: number) { const url = new URL(location.href); url.searchParams.set('analysisId', String(id)); history.replaceState(history.state, '', url); }
  private stopStatus() {
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = null; this.statusController?.abort(); this.statusController = null;
  }
  private startStatus() { this.stopStatus(); this.statusDeadline = Date.now() + 120_000; void this.checkStatus(); }
  private async checkStatus() {
    if (!this.selected || !this.agentResult) return;
    if (Date.now() >= this.statusDeadline) { this.taskMessage = '等待超时，任务状态待确认'; this.stopStatus(); return; }
    const version = this.requestVersion;
    const analysisId = this.agentResult.analysisId;
    const controller = new AbortController(); this.statusController = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await authFetch(`/api/resources/${this.selected.type}/${this.selected.id}/analyses/${analysisId}`, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 403 ? '无分析结果查看权限，需要 ai:view' : response.status === 404 ? '任务不存在或不属于当前账号与资源权限范围' : '任务状态暂不可用，可重试查询');
      const result = await response.json();
      if (version !== this.requestVersion || !this.isConnected || controller.signal.aborted) return;
      if (result.analysisId !== analysisId || !['pending', 'running', 'completed', 'failed'].includes(result.status)) throw new Error('任务状态暂不可用，可重试查询');
      this.agentResult = result;
      this.taskMessage = ({ pending: '已受理', running: '运行中', completed: '完成', failed: '失败' } as Record<string, string>)[result.status];
      if (['pending', 'running'].includes(result.status)) this.statusTimer = setTimeout(() => { this.statusTimer = null; void this.checkStatus(); }, 3000);
    } catch (error) {
      if (version === this.requestVersion && this.isConnected) this.taskMessage = controller.signal.aborted ? '等待超时，任务状态待确认' : error instanceof Error ? error.message : '任务状态暂不可用';
    } finally { clearTimeout(timeout); if (this.statusController === controller) this.statusController = null; }
  }
  private renderAgentResult() {
    const task = this.agentResult;
    if (!task) return nothing;
    const data = task.result as Record<string, unknown> | string | null;
    const summary = typeof data === 'string' ? data : data && (typeof data.displayMarkdown === 'string' ? data.displayMarkdown : typeof data.summary === 'string' ? data.summary : null);
    return html`<section data-analysis-id=${task.analysisId} aria-live="polite"><h2>只读 Agent 诊断 · #${task.analysisId}</h2><p>${this.taskMessage || '状态暂不可用'}</p><p class="metadata">分析对象 ${this.selected ? key(this.selected) : ''} · 生成时间 ${task.completedAt ?? '尚未完成'}</p>
      ${task.status === 'failed' ? html`<p class="error">诊断执行失败，请查看任务记录或重试</p>` : nothing}
      ${task.status === 'completed' ? html`<p>历史诊断上下文：未验证 Evidence ID 关联的结果不作为已验证证据。关联关系不代表因果。</p>${summary ? html`<pre>${summary}</pre>` : html`<p>结果可查看；未提供摘要</p>`}<details><summary>查看原始结果与证据引用</summary><pre>${JSON.stringify(task.result, null, 2)}</pre></details><a href="#evidence-facts">查看当前资源证据</a>` : nothing}
      <button class="btn" .disabled=${this.statusController !== null || this.statusTimer !== null} @click=${this.startStatus}>查询任务状态</button></section>`;
  }
  private resourceHref(ref: ResourceRef) {
    const url = new URL(location.href);
    url.searchParams.delete('analysisId');
    url.searchParams.set('resourceType', ref.type); url.searchParams.set('resourceId', String(ref.id));
    if (this.selected) url.searchParams.set('returnResource', key(this.selected));
    return `${url.pathname}${url.search}`;
  }
  private renderItem(item: EvidenceItem) {
    const observed = item.observedAt ? Date.parse(item.observedAt) : NaN;
    const expiry = item.validUntil ? Date.parse(item.validUntil) : NaN;
    const freshness = !Number.isFinite(observed) || observed > Date.now() ? '时间未知' : !Number.isFinite(expiry) ? '有效期未知' : expiry <= Date.now() ? '已过期' : '新鲜';
    return html`<details data-evidence-id=${item.id}><summary><code>${item.id}</code><span>${item.payload.metricId ?? item.payload.statement ?? item.kind}</span><app-badge title=${item.quality}>${evidenceLabels[item.quality] ?? "质量未知"}</app-badge><span>${freshness}</span><time>${item.observedAt ?? '无观测时间'}</time></summary>
      <p>${item.payload.value === null ? '未知' : item.payload.value ?? ''} ${item.payload.reason ?? ''}</p>
      <div class="metadata"><span title=${item.status}>状态 ${evidenceLabels[item.status] ?? "未知"}</span><span>有效期 ${item.validUntil ?? '未知'}</span><span>来源 ${item.source}</span><span>关联 ID ${item.correlationId}</span></div>
      <pre>${JSON.stringify({ provenance: item.provenance, dimensions: item.dimensions, payload: item.payload }, null, 2)}</pre></details>`;
  }
  override render() {
    const filtered = this.resources.filter(item => `${item.label} ${key(item.resource)}`.toLowerCase().includes(this.search.toLowerCase()) || (this.selected && key(item.resource) === key(this.selected)));
    const selectedListed = this.resources.some(item => this.selected && key(item.resource) === key(this.selected));
    const returnResource = new URL(location.href).searchParams.get('returnResource');
    const returnTo = safeDashboardReturn(new URL(location.href).searchParams.get('returnTo'));
    return html`
      ${returnTo ? html`<a class="btn-ghost" href=${returnTo}>返回原运维总览</a>` : nothing}
      <header><h1>跨资源诊断</h1><button class="btn" title="刷新" aria-label="刷新" .disabled=${this.loading} @click=${this.load}>${icons['refresh-cw']}</button></header>
      <div class="picker"><app-form-field label="搜索资源"><input aria-label="搜索资源" type="search" .value=${this.search} @input=${(event: Event) => { this.search = (event.target as HTMLInputElement).value; }}></app-form-field>
      <app-form-field label="资源"><select aria-label="资源" .value=${this.selected ? key(this.selected) : ''} @change=${(event: Event) => this.selectResource((event.target as HTMLSelectElement).value)}><option value="" .disabled=${true}>选择资源</option>
        ${this.selected && !selectedListed ? html`<option .selected=${true} value=${key(this.selected)}>${resourceLabels[this.selected.type]} #${this.selected.id}</option>` : nothing}
        ${Object.entries(resourceLabels).map(([type, label]) => html`<optgroup label=${label}>${filtered.filter(item => item.resource.type === type).map(item => html`<option .selected=${this.selected !== null && key(item.resource) === key(this.selected)} value=${key(item.resource)}>${item.label || `${resourceLabels[item.resource.type]} #${item.resource.id}`} · ${evidenceLabels[item.status] ?? '未知'} · #${item.resource.id}</option>`)}</optgroup>`)}</select></app-form-field></div>
      ${returnResource && /^(instance|server|network_device):[1-9]\d*$/.test(returnResource) ? html`<button class="btn-ghost" @click=${() => { const url = new URL(location.href); url.searchParams.delete('returnResource'); history.replaceState({}, '', url); this.selectResource(returnResource); }}>${icons['chevron-left']} 返回 ${returnResource}</button>` : nothing}
      ${this.selected ? html`<div class="actions"><button class="btn" .disabled=${this.busy || this.loading} @click=${() => this.diagnose()}>${icons.search} 获取关联证据</button>${permissionMatches(this.permissions, 'ai:manage') ? html`<button class="btn-primary" .disabled=${this.busy || this.loading || this.taskActive()} @click=${() => this.diagnose(true)}>${icons.bot} 开始只读诊断</button>` : html`<span>无只读诊断权限，需要 ai:manage；可继续查看资源证据</span>`}</div>` : nothing}
      ${this.renderAgentResult()}
      ${this.selected && !this.pack ? html`<p class="metadata">关联证据尚未获取，请按需点击「获取关联证据」。浏览不会自动提交 Agent 诊断。</p>` : nothing}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${this.loading ? html`<div class="skeleton" aria-label="加载证据"></div>` : !this.selected ? html`<app-empty-state title="选择诊断资源" icon="search"></app-empty-state>` : nothing}
      ${this.evidence ? html`<p class="metadata">${this.evidence.generatedAt}</p>${this.evidence.truncated ? html`<p role="status">证据已截断</p>` : nothing}
        ${this.evidence.gaps.length ? html`<section><h2>证据缺口</h2>${this.evidence.gaps.map(gap => html`<p>${evidenceLabels[gap] ?? "证据存在缺口"} <code>${gap}</code></p>`)}</section>` : nothing}
        ${(['facts', 'inferences', 'hypotheses'] as const).map((kind, index) => html`<section id=${`evidence-${kind}`} data-kind=${kind}><h2>${['事实', '推论', '假设'][index]} (${this.evidence![kind].length})</h2>${this.evidence![kind].length ? [...this.evidence![kind]].sort((a, b) => (b.observedAt ?? '').localeCompare(a.observedAt ?? '')).map(item => this.renderItem(item)) : html`<app-empty-state title="暂无证据"></app-empty-state>`}</section>`)}` : nothing}
      ${this.pack ? html`<section><h2>关联资源</h2>${this.pack.relations.map(relation => html`<p><a href=${this.resourceHref(relation.source)}>${key(relation.source)}</a> ${relation.relationType} <a href=${this.resourceHref(relation.target)}>${key(relation.target)}</a> <span>${relation.provenance}</span></p>`)}${this.pack.relatedEvidence.map(item => html`<p><a href=${this.resourceHref(item.resource.resource)}>${resourceLabels[item.resource.resource.type]} · ${item.resource.label}</a></p>`)}${this.pack.gaps.map(gap => html`<p>${gap.scope}: ${gap.code}</p>`)}${this.pack.truncated ? html`<p>关联证据已截断</p>` : nothing}</section>` : nothing}
      ${this.selected ? html`<resource-evaluation .resourceType=${this.selected.type} .resourceId=${this.selected.id}></resource-evaluation>` : nothing}
      ${permissionMatches(this.permissions, 'config:view') ? html`<section><source-manifest></source-manifest></section>` : nothing}

    `;
  }
}
