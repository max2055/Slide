import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { safeDashboardReturn } from './dashboard-model.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { permissionMatches } from '../settings-navigation.js';
import { diagnosisLabels, displayTime, evidenceFreshness, gapExplanation } from './diagnosis-presentation.js';
import '../components/app-card.js';
import '../components/app-form-field.js';
import '../components/app-empty-state.js';
import '../components/app-badge.js';
import '../components/app-dialog.js';
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
  @state() private retryDialogOpen = false;
  @state() private statusUnconfirmed = false;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private statusController: AbortController | null = null;
  private statusDeadline = 0;
  @state() private search = '';
  @state() private permissions: Set<string> = new Set();
  private requestVersion = 0;
  private readonly onPopState = () => { this.readSelection(); void this.loadEvidence(); };
  private readonly onPermissions = () => { this.readPermissions(); };

  static styles = [sharedFieldStyles, sharedBtnStyles, css`
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
    a { color: var(--accent-text); }
    svg { width: 16px; height: 16px; }
    .skeleton { height: 100px; background: var(--border); opacity: .4; }
    .error { color: var(--danger); }
    app-card { display: block; margin-top: var(--space-lg); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
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
      if (!response.ok) throw new Error(response.status === 403 ? '无资源浏览权限，请联系管理员授权' : `资源列表加载失败 (${response.status})，请刷新或检查服务连接`);
      this.resources = (await response.json()).items;
      await this.loadEvidence();
    } catch (error) { this.error = String(error); } finally { this.loading = false; }
  }
  private async loadEvidence() {
    const version = ++this.requestVersion;
    this.stopStatus(); this.taskMessage = ''; this.retryDialogOpen = false; this.statusUnconfirmed = false;
    this.evidence = null; this.pack = null; this.agentResult = null; this.error = ''; this.busy = false;
    if (!this.selected) { this.loading = false; return; }
    this.loading = true;
    const id = Number(new URL(location.href).searchParams.get('analysisId'));
    if (Number.isSafeInteger(id) && id > 0) { this.agentResult = { analysisId: id, status: 'unconfirmed' }; this.startStatus(); }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await authFetch(`/api/resources/${this.selected.type}/${this.selected.id}/evidence`, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 403 ? '无当前资源证据查看权限，请联系管理员授权' : response.status === 404 ? '资源不存在或不在当前账号可见范围，请重新选择资源' : `证据加载失败 (${response.status})，请刷新或检查采集服务`);
      const evidence = await response.json();
      if (version === this.requestVersion) this.evidence = evidence;
    } catch (error) { if (version === this.requestVersion) this.error = controller.signal.aborted ? '证据读取超时，当前状态未知；请刷新证据，刷新不会调用模型' : String(error); }
    finally { clearTimeout(timeout); if (version === this.requestVersion) this.loading = false; }
  }
  private selectResource(value: string) {
    const [type, id] = value.split(':');
    const url = new URL(location.href);
    url.searchParams.set('resourceType', type); url.searchParams.set('resourceId', id); url.searchParams.delete('analysisId');
    history.pushState({}, '', url); this.readSelection(); void this.loadEvidence();
  }
  private async diagnose(agent = false, retryOf?: number) {
    if (!this.selected || this.busy || (agent && this.taskActive() && retryOf === undefined)) return;
    const version = this.requestVersion;
    this.busy = true; this.error = '';
    try {
      const response = await authFetch(`/api/resources/${this.selected.type}/${this.selected.id}/${agent ? 'diagnose-agent' : 'diagnose'}`, { method: 'POST', ...(retryOf !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retryOf, confirmUnknownRetry: true }) } : {}) });
      const result = await response.json();
      if (!response.ok) {
        if (agent && Number.isSafeInteger(result.analysisId) && result.analysisId > 0 && version === this.requestVersion) { this.agentResult = { analysisId: result.analysisId, status: result.status === 'unknown' ? 'unknown' : 'unconfirmed' }; this.persistAnalysisId(result.analysisId); this.startStatus(); }
        throw new Error(response.status === 409 ? '供应商可能已经执行，结果未知；重试可能再次计费，需要明确确认' : response.status === 403 ? '无诊断权限，资源与证据浏览仍可用' : response.status === 503 ? 'Agent 或模型暂不可用，请检查配置；已创建的任务可查询状态' : `诊断请求失败 (${response.status})`);
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
  private taskActive() { return this.statusUnconfirmed || (this.agentResult !== null && !['completed', 'failed'].includes(this.agentResult.status)); }
  private persistAnalysisId(id: number) { const url = new URL(location.href); url.searchParams.set('analysisId', String(id)); history.replaceState(history.state, '', url); }
  private stopStatus() {
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = null; this.statusController?.abort(); this.statusController = null;
  }
  private startStatus() { this.stopStatus(); this.statusDeadline = Date.now() + 120_000; void this.checkStatus(); }
  private async checkStatus() {
    if (!this.selected || !this.agentResult) return;
    if (Date.now() >= this.statusDeadline) { this.statusUnconfirmed = true; this.taskMessage = '等待超时，任务状态待确认'; this.stopStatus(); return; }
    const version = this.requestVersion;
    const analysisId = this.agentResult.analysisId;
    const controller = new AbortController(); this.statusController = controller; this.requestUpdate();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await authFetch(`/api/resources/${this.selected.type}/${this.selected.id}/analyses/${analysisId}`, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 409 ? '供应商可能已经执行，结果未知；重试可能再次计费，需要明确确认' : response.status === 403 ? '无分析结果查看权限，需要 ai:view' : response.status === 404 ? '任务不存在或不属于当前账号与资源权限范围' : '任务状态暂不可用，可重试查询');
      const result = await response.json();
      if (version !== this.requestVersion || !this.isConnected || controller.signal.aborted) return;
      if (result.analysisId !== analysisId || !['pending', 'running', 'completed', 'failed', 'unknown'].includes(result.status)) throw new Error('任务状态暂不可用，可重试查询');
      this.agentResult = result;
      this.statusUnconfirmed = false;
      this.taskMessage = ({ pending: '排队中，等待执行', running: '运行中，尚无最终结论', completed: '执行完成', failed: '执行失败', unknown: '结果未知，已停止自动重试' } as Record<string, string>)[result.status];
      if (['pending', 'running'].includes(result.status)) this.statusTimer = setTimeout(() => { this.statusTimer = null; void this.checkStatus(); }, 3000);
    } catch (error) {
      if (version === this.requestVersion && this.isConnected) { this.statusUnconfirmed = true; this.taskMessage = controller.signal.aborted ? '等待超时，任务状态待确认' : error instanceof Error ? error.message : '任务状态暂不可用'; }
    } finally { clearTimeout(timeout); if (this.statusController === controller) this.statusController = null; this.requestUpdate(); }
  }
  private renderAgentResult() {
    const task = this.agentResult;
    if (!task) return nothing;
    const data = task.result as Record<string, unknown> | string | null;
    const summary = typeof data === 'string' ? data : data && (typeof data.displayMarkdown === 'string' ? data.displayMarkdown : typeof data.summary === 'string' ? data.summary : null);
    const structured = data && typeof data === 'object' ? data : null;
    const partial = task.status === 'completed' && structured?.verification === 'partial';
    const snapshot = structured?.evidenceSnapshot as { collectedAt?: string } | undefined;
    const conclusions = Array.isArray(structured?.conclusions) ? structured.conclusions.filter((value): value is string => typeof value === 'string') : [];
    const recommendations = Array.isArray(structured?.recommendations) ? structured.recommendations.filter((value): value is { action: string } => value !== null && typeof value === 'object' && typeof value.action === 'string') : [];
    const status = this.statusUnconfirmed ? '状态待确认' : partial ? '部分完成（证据不完整）' : ({ pending: '排队中', running: '运行中', completed: '执行完成', failed: '执行失败', unknown: '结果未知' } as Record<string, string>)[task.status] ?? '状态待确认';
    return html`<section data-analysis-id=${task.analysisId} aria-labelledby="agent-heading"><h2 id="agent-heading">只读 Agent 诊断 · ${this.resourceName(this.selected)}</h2><p role="status" data-task-status><app-badge>${status}</app-badge> ${this.taskMessage}</p>
      ${this.statusUnconfirmed ? html`<p>当前执行状态无法确认；上次记录为${({ pending: '排队', running: '运行中', completed: '完成', failed: '失败', unknown: '未知' } as Record<string, string>)[task.status] ?? '待确认'}。先查询任务状态，不要重复提交分析。</p>` : nothing}
      <p class="metadata">创建时间 ${displayTime(task.createdAt)} · 完成时间 ${task.completedAt ? displayTime(task.completedAt) : '尚未确认'}</p>
      ${task.status === 'unknown' ? html`<p class="error">供应商可能已执行并计费，但结果无法确认。系统不会自动再次调用。</p>
        <button class="btn" .disabled=${this.busy || !permissionMatches(this.permissions, 'ai:manage')} @click=${() => { this.retryDialogOpen = true; }}>确认后重新分析</button>
        <app-dialog .open=${this.retryDialogOpen} title="确认重新分析" @app-dialog-close=${() => { this.retryDialogOpen = false; }}>
          <p>原分析的执行结果未知，供应商可能已执行并计费。重新分析将创建新任务，可能再次计费；具体费用取决于模型和用量，目前无法估算。原记录会保留。</p>
          <div slot="footer"><button class="btn" @click=${() => { this.retryDialogOpen = false; }}>取消</button><button class="btn-primary" .disabled=${this.busy} @click=${() => { this.retryDialogOpen = false; void this.diagnose(true, task.analysisId); }}>接受可能再次计费并重试</button></div>
        </app-dialog>` : nothing}
      ${task.status === 'failed' ? html`<p class="error">诊断执行失败，尚无可用结论。下一步：检查模型配置与任务记录；再次分析可能产生新的模型费用。</p>` : nothing}
      ${task.status === 'completed' ? html`<p>历史诊断上下文：未验证 Evidence ID 关联的结果不作为已验证证据。关联关系不代表因果。</p>
        <p>历史依据采集时间 ${displayTime(snapshot?.collectedAt)}；当前证据另列下方，刷新证据不会更新此历史结论。</p>
        <p>${partial ? '执行已结束，但部分引用缺失，结论仍需人工确认。' : structured?.verification === 'bound' ? '引用已绑定冻结证据，不代表根因已证实；处理前仍需人工确认。' : '结果验证信息未知，不能作为已验证的当前证据。'}</p>
        <h3>分析结论（待人工确认）</h3>${conclusions.length ? html`<ul>${conclusions.map(value => html`<li>${value}</li>`)}</ul>` : summary ? html`<pre>${summary}</pre>` : html`<p>历史结果未提供结论，不能据此判断异常。</p>`}
        <h3>建议下一步</h3>${recommendations.length ? html`<ul>${recommendations.map(value => html`<li>${value.action}</li>`)}</ul><p>建议尚未执行，操作及恢复仍需人工确认。</p>` : html`<p>刷新当前证据并核对缺口，再人工确认处理方案。</p>`}<a href="#evidence-facts" @click=${(event: Event) => { event.preventDefault(); this.renderRoot.querySelector<HTMLElement>('#evidence-facts')?.focus(); }}>查看当前资源证据</a>` : nothing}
      <details><summary>查看任务技术详情</summary><p>任务 ID ${task.analysisId} · 原始状态 ${task.status}</p><pre>${JSON.stringify(task, null, 2)}</pre></details>
      <button class="btn" .disabled=${this.statusController !== null || this.statusTimer !== null} @click=${this.startStatus}>查询任务状态</button></section>`;
  }
  private resourceName(ref: ResourceRef | null) {
    if (!ref) return '未选择资源';
    return this.resources.find(item => key(item.resource) === key(ref))?.label || `${resourceLabels[ref.type]}（名称不可用）`;
  }
  private renderOverview() {
    if (!this.selected) return nothing;
    const evidence = this.evidence;
    const fresh = evidence?.facts.filter(item => item.quality === 'good' && evidenceFreshness(item) === '新鲜').length ?? 0;
    return html`<app-card data-diagnosis-overview><h2 slot="header">分析对象：${this.resourceName(this.selected)}</h2>
      <p><strong>当前结论：</strong>${this.loading ? '正在读取证据，尚不能判断异常。' : !evidence ? '证据不可用，不能判断当前异常。' : !fresh ? '缺少有效的当前事实，不能据此判断当前异常。' : '已读取当前观测；异常需结合下方规则评估与诊断结果人工确认。'}</p>
      <p>证据读取时间 ${displayTime(evidence?.generatedAt)}（不是观测时间）；有效期内且质量有效的事实 ${fresh} 项。</p>
      <p><strong>不确定性：</strong>${!evidence ? '当前证据尚未取得。' : !fresh ? '现有证据缺失、过期或有效性未知，不能证明当前正常或已恢复。' : '自动观测不等于人工确认，推论与假设仍待验证。'}${evidence?.truncated ? ' 返回证据已截断。' : ''}</p>
      <p><strong>下一步：</strong>${!fresh ? '检查采集连接、权限和观测时间，再点击刷新读取证据。' : '核对下方观测时间与规则异常；按需获取关联证据或开始只读诊断。'} 刷新和查询状态不调用模型；重新分析可能产生模型费用，具体金额取决于模型和用量，目前无法估算。</p>
      <details><summary>查看资源技术详情</summary><p>资源 ID ${key(this.selected)} · 配置状态 ${this.resources.find(item => key(item.resource) === key(this.selected!))?.status ?? '未知'}（不代表诊断结论）</p></details>
    </app-card>`;
  }
  private resourceHref(ref: ResourceRef) {
    const url = new URL(location.href);
    url.searchParams.delete('analysisId');
    url.searchParams.set('resourceType', ref.type); url.searchParams.set('resourceId', String(ref.id));
    if (this.selected) url.searchParams.set('returnResource', key(this.selected));
    return `${url.pathname}${url.search}`;
  }
  private renderItem(item: EvidenceItem) {
    const freshness = evidenceFreshness(item);
    return html`<details data-evidence-id=${item.id}><summary><span>${diagnosisLabels[item.payload.metricId ?? ''] ?? item.payload.metricId ?? item.payload.statement ?? diagnosisLabels[item.kind] ?? '证据'}</span><app-badge>${evidenceLabels[item.quality] ?? '质量未知'}</app-badge><span>${freshness}</span><span>${item.status === 'fact' ? diagnosisLabels[item.kind] ?? '来源类型待确认' : diagnosisLabels[item.status] ?? '判断类型未知'}</span><span>观测 <time>${displayTime(item.observedAt)}</time> · 有效至 <time>${displayTime(item.validUntil)}</time></span></summary>
      <p>${item.payload.value === null ? '未知' : item.payload.value ?? ''} ${item.payload.reason ?? ''}</p>
      <p>${freshness === '新鲜' && item.quality === 'good' ? '时间和质量有效；仍需结合规则与业务场景确认异常。' : '不能作为当前可信依据。下一步：检查采集来源、观测时间和缺失数据，再刷新证据。'}</p>
      <div class="metadata"><span>证据 ID ${item.id}</span><span>原始状态 ${item.status}</span><span>来源 ${item.source}</span><span>关联 ID ${item.correlationId}</span></div>
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
      ${returnResource && /^(instance|server|network_device):[1-9]\d*$/.test(returnResource) ? html`<button class="btn-ghost" @click=${() => { const url = new URL(location.href); url.searchParams.delete('returnResource'); history.replaceState({}, '', url); this.selectResource(returnResource); }}>${icons['chevron-left']} 返回 ${this.resourceName({ type: returnResource.split(':')[0] as ResourceType, id: Number(returnResource.split(':')[1]) })}</button>` : nothing}
      ${this.renderOverview()}
      ${this.selected ? html`<div class="actions"><button class="btn" .disabled=${this.busy || this.loading} @click=${() => this.diagnose()}>${icons.search} 获取关联证据</button>${permissionMatches(this.permissions, 'ai:manage') ? html`<button class="btn-primary" .disabled=${this.busy || this.loading || this.taskActive()} @click=${() => this.diagnose(true)}>${icons.bot} 开始只读诊断</button>` : html`<span>无只读诊断权限，需要 ai:manage；可继续查看资源证据</span>`}</div>` : nothing}
      ${this.renderAgentResult()}
      ${this.selected && !this.pack ? html`<p class="metadata">关联证据尚未获取，请按需点击「获取关联证据」。浏览不会自动提交 Agent 诊断。</p>` : nothing}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${this.loading ? html`<div class="skeleton" role="status" aria-label="加载证据"></div>` : !this.selected ? html`<app-empty-state title="选择诊断资源" icon="search"></app-empty-state>` : nothing}
      ${this.evidence ? html`${this.evidence.truncated ? html`<p role="status">证据已截断，请缩小查询范围再核对</p>` : nothing}
        ${this.evidence.gaps.length ? html`<section aria-labelledby="gaps-heading"><h2 id="gaps-heading">证据缺口与下一步</h2>${this.evidence.gaps.map(gap => html`<p>${gapExplanation(gap)[0]}。下一步：${gapExplanation(gap)[1]}。</p>`)}<details><summary>查看缺口技术详情</summary><pre>${JSON.stringify(this.evidence.gaps, null, 2)}</pre></details></section>` : nothing}
        ${(['facts', 'inferences', 'hypotheses'] as const).map((kind, index) => html`<section id=${`evidence-${kind}`} tabindex="-1" aria-labelledby=${`${kind}-heading`} data-kind=${kind}><h2 id=${`${kind}-heading`}>${['事实（自动观测与记录）', '推论（待人工确认）', '假设（待人工确认）'][index]} (${this.evidence![kind].length})</h2>${this.evidence![kind].length ? [...this.evidence![kind]].sort((a, b) => (b.observedAt ?? '').localeCompare(a.observedAt ?? '')).map(item => this.renderItem(item)) : html`<app-empty-state title="暂无证据"></app-empty-state>`}</section>`)}` : nothing}
      ${this.pack ? html`<section><h2>关联资源</h2><p>关联关系仅表示配置依赖，不代表已确认因果。</p>${this.pack.relations.map(relation => html`<p><a href=${this.resourceHref(relation.source)}>${this.resourceName(relation.source)}</a> ${relation.relationType === 'depends_on' ? '依赖于' : '关联'} <a href=${this.resourceHref(relation.target)}>${this.resourceName(relation.target)}</a></p>`)}${this.pack.relatedEvidence.map(item => html`<p><a href=${this.resourceHref(item.resource.resource)}>${resourceLabels[item.resource.resource.type]} · ${item.resource.label}</a></p>`)}${this.pack.gaps.map(gap => html`<p>${gapExplanation(gap.code)[0]}。下一步：${gapExplanation(gap.code)[1]}。</p>`)}${this.pack.truncated ? html`<p>关联证据已截断</p>` : nothing}<details><summary>查看关联技术详情</summary><pre>${JSON.stringify(this.pack, null, 2)}</pre></details></section>` : nothing}
      ${this.selected ? html`<resource-evaluation .resourceType=${this.selected.type} .resourceId=${this.selected.id}></resource-evaluation>` : nothing}
      ${permissionMatches(this.permissions, 'config:view') ? html`<section><source-manifest></source-manifest></section>` : nothing}

    `;
  }
}
