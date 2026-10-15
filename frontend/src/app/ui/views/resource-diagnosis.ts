import { tabKeydown, workspaceStyles, badge, table, pairs } from './workspace-ui.js';
import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, css, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
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
import '../components/legacy-analysis-link.ts';
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
  @state() private tab: 'evidence' | 'evaluation' | 'relations' | 'result' = 'evidence';
  @state() private evidenceKind: 'facts' | 'inferences' | 'hypotheses' = 'facts';
  @state() private dialog: 'evidence' | 'gaps' | 'scope' | '' = '';
  @state() private selectedEvidence: EvidenceItem | null = null;
  @state() private search = '';
  @state() private permissions: Set<string> = new Set();
  private requestVersion = 0;
  private submissionVersion = 0;
  private submitting = false;
  @state() private contextReady = false;
  private readonly onPopState = () => { this.readSelection(); void this.loadEvidence(); };
  private listVersion = 0;
  // Facts belong to a successful list/permission generation. Task receipts have a
  // separate lifetime: invalidating facts must never permit a duplicate paid call.
  private invalidateFacts() {
    this.requestVersion++; this.stopStatus(); this.contextReady = false;
    this.resources = []; this.evidence = null; this.pack = null;
    this.dialog = ''; this.selectedEvidence = null; this.retryDialogOpen = false;
    if (this.agentResult) this.agentResult = { analysisId: this.agentResult.analysisId, status: this.agentResult.status };
    this.busy = this.submitting;
    this.statusUnconfirmed = this.agentResult !== null || this.submitting;
    this.taskMessage = this.statusUnconfirmed ? '任务状态待确认，请先查询原任务' : '';
  }
  private clearSensitive() {
    this.invalidateFacts(); this.listVersion++; this.error = ''; this.loading = false;
  }
  private readonly onExpired = () => { this.permissions = new Set(); this.clearSensitive(); };
  private readonly onPermissions = (event: Event) => {
    this.clearSensitive();
    const codes = (event as CustomEvent<{ permissions?: string[] }>).detail?.permissions;
    this.permissions = new Set(Array.isArray(codes) ? codes : []);
    void this.load();
  };

  static styles = [sharedFieldStyles, sharedBtnStyles, workspaceStyles, css`
    .error { color:var(--danger); } select,input { width:100%; min-width:0; }
    svg { width:16px; height:16px; } .metadata,time { color:var(--muted); font-size:12px; }
    .skeleton { height:100px; background:var(--border); opacity:.4; }
    .actions { display:flex; gap:var(--space-sm); align-items:center; flex-wrap:wrap; }
  `];
  override connectedCallback() {
    super.connectedCallback();
    this.readPermissions(); this.readSelection();
    window.addEventListener('popstate', this.onPopState); window.addEventListener('slide-session-expired', this.onExpired);
    window.addEventListener('slide-permissions-loaded', this.onPermissions);
    void this.load();
  }
  override disconnectedCallback() {
    this.requestVersion++; this.submissionVersion++; this.listVersion++; this.stopStatus();
    window.removeEventListener('popstate', this.onPopState); window.removeEventListener('slide-session-expired', this.onExpired);
    window.removeEventListener('slide-permissions-loaded', this.onPermissions);
    super.disconnectedCallback();
  }
  private readPermissions() {
    try { this.permissions = new Set(JSON.parse(localStorage.getItem('permissions') ?? '[]')); } catch { this.permissions = new Set(); }
  }
  private readSelection() {
    const params = new URL(location.href).searchParams;
    const tab = params.get('diagnosisTab'); this.tab = ['evidence','evaluation','relations','result'].includes(tab ?? '') ? tab as typeof this.tab : 'evidence';
    const kind = params.get('evidenceKind'); this.evidenceKind = kind === 'inferences' || kind === 'hypotheses' ? kind : 'facts';
    const type = params.get('resourceType') as ResourceType;
    const id = Number(params.get('resourceId'));
    this.selected = Object.hasOwn(resourceLabels, type) && Number.isSafeInteger(id) && id > 0 ? { type, id } : null;
  }
  private async load() {
    const generation = ++this.listVersion;
    this.invalidateFacts(); this.loading = true; this.error = '';
    try {
      const response = await authFetch('/api/resources');
      if (!response.ok) throw new Error(response.status === 403 ? '无资源浏览权限，请联系管理员授权' : `资源列表加载失败 (${response.status})，请刷新或检查服务连接`);
      const body = await response.json(); if (generation !== this.listVersion || !this.isConnected) return;
      this.resources = body.items; this.contextReady = true;
      await this.loadEvidence(true);
    } catch (error) { if (generation === this.listVersion) this.error = String(error); } finally { if (generation === this.listVersion) this.loading = false; }
  }
  private async loadEvidence(preserveTask = false) {
    const version = ++this.requestVersion;
    this.stopStatus(); this.retryDialogOpen = false;
    if (!preserveTask) { this.submissionVersion++; this.taskMessage = ''; this.statusUnconfirmed = false; this.agentResult = null; this.submitting = false; this.busy = false; }
    this.dialog = ''; this.selectedEvidence = null; this.evidence = null; this.pack = null; this.error = '';
    if (!this.selected) { this.loading = false; return; }
    this.loading = true;
    const id = Number(new URL(location.href).searchParams.get('analysisId'));
    if (Number.isSafeInteger(id) && id > 0) { if (!new URL(location.href).searchParams.has('diagnosisTab')) this.tab = 'result'; this.agentResult = { analysisId: id, status: 'unconfirmed' }; this.startStatus(); }
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
    url.searchParams.set('resourceType', type); url.searchParams.set('resourceId', id); url.searchParams.delete('analysisId'); url.searchParams.delete('diagnosisTab'); url.searchParams.delete('evidenceKind');
    history.pushState({}, '', url); this.readSelection(); void this.loadEvidence();
  }
  private async diagnose(agent = false, retryOf?: number) {
    if (agent && !permissionMatches(this.permissions, 'ai:manage')) return;
    if (!this.selected || this.busy || (agent && this.taskActive() && retryOf === undefined)) return;
    const version = agent ? this.submissionVersion : this.requestVersion;
    const isCurrent = () => version === (agent ? this.submissionVersion : this.requestVersion);
    this.busy = true; this.submitting = agent; this.error = ''; this.switchTab(agent ? 'result' : 'relations');
    try {
      const response = await authFetch(`/api/resources/${this.selected.type}/${this.selected.id}/${agent ? 'diagnose-agent' : 'diagnose'}`, { method: 'POST', ...(retryOf !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retryOf, confirmUnknownRetry: true }) } : {}) });
      const result = await response.json();
      if (!response.ok) {
        if (agent && Number.isSafeInteger(result.analysisId) && result.analysisId > 0 && isCurrent()) { this.agentResult = { analysisId: result.analysisId, status: result.status === 'unknown' ? 'unknown' : 'unconfirmed' }; this.persistAnalysisId(result.analysisId); this.followReceipt(); }
        throw new Error(response.status === 409 ? '供应商可能已经执行，结果未知；重试可能再次计费，需要明确确认' : response.status === 403 ? '无诊断权限，资源与证据浏览仍可用' : response.status === 503 ? 'Agent 或模型暂不可用，请检查配置；已创建的任务可查询状态' : `诊断请求失败 (${response.status})`);
      }
      if (!isCurrent()) return;
      if (agent) {
        if (!Number.isSafeInteger(result.analysisId) || result.analysisId <= 0) throw new Error('未取得有效任务 ID，请检查服务状态');
        this.agentResult = { analysisId: result.analysisId, status: 'pending' };
        this.persistAnalysisId(result.analysisId);
        this.taskMessage = result.status === 'cached' ? '已复用任务，正在查询真实状态' : '已受理，正在查询真实状态';
        this.followReceipt();
      } else this.pack = result;
    } catch (error) { if (isCurrent()) this.error = String(error); }
    finally { if (isCurrent()) { this.busy = false; if (agent) this.submitting = false; } }
  }
  private followReceipt() {
    if (this.contextReady) this.startStatus();
    else { this.statusUnconfirmed = true; this.taskMessage = '任务状态待确认，请先刷新资源后查询原任务'; }
  }
  private taskActive() { return this.statusUnconfirmed || (this.agentResult !== null && !['completed', 'failed'].includes(this.agentResult.status)); }
  private persistAnalysisId(id: number) { const url = new URL(location.href); url.searchParams.set('analysisId', String(id)); history.replaceState(history.state, '', url); }
  private stopStatus() {
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = null; this.statusController?.abort(); this.statusController = null;
  }
  private startStatus() { this.stopStatus(); this.statusDeadline = Date.now() + 120_000; void this.checkStatus(); }
  private async checkStatus() {
    if (!this.selected || !this.agentResult || !this.contextReady) return;
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
          <p>原任务 #${task.analysisId} 的执行结果未知，供应商可能已执行并计费。重新分析将创建新任务，可能再次计费；具体费用取决于模型和用量，目前无法估算。原记录会保留。</p>
          <div slot="footer"><button class="btn" @click=${() => { this.retryDialogOpen = false; }}>取消</button><button class="btn-primary" .disabled=${this.busy} @click=${() => { this.retryDialogOpen = false; void this.diagnose(true, task.analysisId); }}>接受可能再次计费并重试</button></div>
        </app-dialog>` : nothing}
      ${task.status === 'failed' ? html`<p class="error">诊断执行失败，尚无可用结论。下一步：检查模型配置与任务记录；再次分析可能产生新的模型费用。</p>` : nothing}
      ${task.status === 'completed' ? html`<p>历史诊断上下文：未验证 Evidence ID 关联的结果不作为已验证证据。关联关系不代表因果。</p>
        <p>历史依据采集时间 ${displayTime(snapshot?.collectedAt)}；当前证据另列下方，刷新证据不会更新此历史结论。</p>
        <p>${partial ? '执行已结束，但部分引用缺失，结论仍需人工确认。' : structured?.verification === 'bound' ? '引用已绑定冻结证据，不代表根因已证实；处理前仍需人工确认。' : '结果验证信息未知，不能作为已验证的当前证据。'}</p>
        <h3>分析结论（待人工确认）</h3>${conclusions.length ? html`<ul>${conclusions.map(value => html`<li>${value}</li>`)}</ul>` : summary ? html`<pre>${summary}</pre>` : html`<p>历史结果未提供结论，不能据此判断异常。</p>`}
        <h3>建议下一步</h3>${recommendations.length ? html`<ul>${recommendations.map(value => html`<li>${value.action}</li>`)}</ul><p>建议尚未执行，操作及恢复仍需人工确认。</p>` : html`<p>刷新当前证据并核对缺口，再人工确认处理方案。</p>`}<a href="#evidence-facts" @click=${async (event: Event) => { event.preventDefault(); this.evidenceKind = 'facts'; this.switchTab('evidence'); await this.updateComplete; this.renderRoot.querySelector<HTMLElement>('#evidence-facts')?.focus(); }}>查看当前资源证据</a>` : nothing}
      <details><summary>查看任务技术详情</summary><p>任务 ID ${task.analysisId} · 原始状态 ${task.status}</p><pre>${JSON.stringify(task, null, 2)}</pre></details>
      ${this.selected?.type === 'instance' ? html`<legacy-analysis-link .analysisId=${task.analysisId} .status=${task.status}></legacy-analysis-link>` : nothing}
      <button class="btn" .disabled=${this.statusController !== null || this.statusTimer !== null} @click=${this.startStatus}>查询任务状态</button></section>`;
  }
  private resourceName(ref: ResourceRef | null) {
    if (!ref) return '未选择资源';
    return this.resources.find(item => key(item.resource) === key(ref))?.label || `${resourceLabels[ref.type]}（名称不可用）`;
  }
  private switchTab(tab: typeof this.tab) {
    this.tab = tab;
    const url = new URL(location.href); url.searchParams.set('diagnosisTab', tab); url.searchParams.set('evidenceKind', this.evidenceKind);
    history.replaceState(history.state, '', url);
  }
  private renderOverview() {
    if (!this.selected) return nothing;
    const evidence = this.evidence;
    const fresh = evidence?.facts.filter(item => item.quality === 'good' && evidenceFreshness(item) === '新鲜').length ?? 0;
    return html`<div class="diagnosis-context" data-diagnosis-overview><div><div class="row"><h2>${this.resourceName(this.selected)}</h2>${badge(resourceLabels[this.selected.type])}${badge(!evidence || !fresh ? '当前证据不可用' : evidence.gaps.length || evidence.truncated ? '存在待补充证据' : '已读取当前观测',!evidence || !fresh || evidence.gaps.length || evidence.truncated ? 'warn' : 'muted')}</div><p class="caption">证据读取时间 ${displayTime(evidence?.generatedAt)}（不是观测时间） · 配置状态不代表健康结论</p></div><div class="actions"><button class="btn" .disabled=${this.busy || this.loading || !this.contextReady} @click=${() => this.diagnose()}>获取关联证据</button>${permissionMatches(this.permissions,'ai:manage') ? html`<button class="btn-primary" .disabled=${this.busy || this.loading || !this.contextReady || this.taskActive()} @click=${() => this.diagnose(true)}>开始只读诊断</button>` : nothing}</div></div>
      <p class="diagnosis-intro">${this.loading ? '正在读取证据，尚不能判断异常。' : !evidence || !fresh ? '缺少有效的当前事实，不能据此判断当前正常或异常。' : '已读取当前观测；异常需结合规则评估与业务场景人工确认。'} <span class="caption">刷新、关联证据与状态查询不调用模型；只读诊断可能产生费用，具体金额取决于模型和用量，目前无法估算。</span></p>
      ${!permissionMatches(this.permissions,'ai:manage') ? html`<div class="notice neutral"><div><strong>当前仅有浏览权限</strong>无只读诊断权限，需要 ai:manage；可继续查看资源证据。</div></div>` : nothing}
      ${this.agentResult ? html`<p class="caption" role="status">任务 #${this.agentResult.analysisId} · ${this.statusUnconfirmed ? '任务状态待确认' : this.taskMessage || this.agentResult.status} <button class="link" @click=${() => this.switchTab('result')}>查看分析结果 →</button></p>` : nothing}`;
  }
  private resourceHref(ref: ResourceRef) {
    const url = new URL(location.href);
    url.searchParams.delete('analysisId'); url.searchParams.delete('diagnosisTab'); url.searchParams.delete('evidenceKind');
    url.searchParams.set('resourceType', ref.type); url.searchParams.set('resourceId', String(ref.id));
    if (this.selected) url.searchParams.set('returnResource', key(this.selected));
    return `${url.pathname}${url.search}`;
  }
  private renderEvidence() {
    const evidence = this.evidence;
    const kind = this.evidenceKind;
    const items = [...(evidence?.[kind] ?? [])].sort((a,b) => (b.observedAt ?? '').localeCompare(a.observedAt ?? ''));
    const fresh = evidence?.facts.filter(item => item.quality === 'good' && evidenceFreshness(item) === '新鲜').length ?? 0;
    return html`<div class="diagnosis-subhead"><div class="row" role="group" aria-label="证据分类">${(['facts','inferences','hypotheses'] as const).map((kind,index) => html`<button class="btn-ghost" aria-pressed=${this.evidenceKind === kind} @click=${() => { this.evidenceKind = kind; this.switchTab('evidence'); }}>${['事实','推论','假设'][index]} ${evidence?.[kind].length ?? 0}</button>`)}</div><span class="caption">${fresh} / ${evidence?.facts.length ?? 0} 项事实处于有效期且质量有效</span></div>
      <div id=${`evidence-${kind}`} tabindex="-1" data-kind=${kind}>${this.loading ? html`<div class="skeleton" role="status" aria-label="加载证据"></div>` : !items.length ? html`<app-card><app-empty-state title="暂无证据" description="检查采集连接、权限和观测时间后，刷新证据。没有证据不能证明资源正常。" icon="alert-circle"></app-empty-state></app-card>` : html`<p class="caption">${kind === 'facts' ? '事实来自自动观测与记录，仍需结合业务场景核验。' : kind === 'inferences' ? '推论待人工确认，尚不能证明因果。' : '假设待人工确认，需要补充依据。'}</p><app-card .compact=${true}>${table([{key:'metric',label:'证据与观测值',width:'37%'},{key:'quality',label:'有效性',width:'23%'},{key:'time',label:'观测时间',width:'23%'},{key:'action',label:'详情',width:'17%'}],items.map(item => ({metric:html`<div class="entity" data-evidence-id=${item.id}>${diagnosisLabels[item.payload.metricId ?? ''] ?? item.payload.metricId ?? item.payload.statement ?? diagnosisLabels[item.kind] ?? '证据'} <span class="diagnosis-value">${item.payload.value === null ? '未知' : item.payload.value ?? ''}</span></div><div class="entity-sub">${item.status === 'fact' ? diagnosisLabels[item.kind] ?? '来源类型待确认' : diagnosisLabels[item.status] ?? '判断类型未知'}</div>`,quality:html`${badge(evidenceFreshness(item),evidenceFreshness(item) === '新鲜' && item.quality === 'good' ? 'ok' : 'warn')}<div class="entity-sub">${evidenceLabels[item.quality] ?? '质量未知'}</div>`,time:html`<time>${displayTime(item.observedAt)}</time>`,action:html`<button class="link" aria-label=${`查看证据 ${item.id}`} @click=${() => { this.selectedEvidence = item; this.dialog = 'evidence'; }}>查看</button>`})))}</app-card>`}</div>`;
  }
  private renderRelations() {
    const pack = this.pack;
    if (!pack) return html`<app-card><app-empty-state title="尚未获取关联证据" description="点击上方「获取关联证据」，读取配置关系与关联资源证据。此操作不调用模型。" icon="network"></app-empty-state></app-card>`;
    const refs = new Map<string,ResourceRef>();
    for (const relation of pack.relations) for (const ref of [relation.source,relation.target]) if (key(ref) !== key(this.selected!)) refs.set(key(ref),ref);
    for (const item of pack.relatedEvidence) if (key(item.resource.resource) !== key(this.selected!)) refs.set(key(item.resource.resource),item.resource.resource);
    return html`<p class="caption">关联关系仅表示配置依赖，不代表已确认因果。切换资源会清理当前分析上下文。</p><app-card .compact=${true}>${table([{key:'name',label:'关联资源',width:'44%'},{key:'relation',label:'关系来源',width:'29%'},{key:'action',label:'操作',width:'27%'}],[...refs.values()].map(ref => ({name:html`<div class="entity">${pack.relatedEvidence.find(item => key(item.resource.resource) === key(ref))?.resource.label ?? this.resourceName(ref)}</div><div class="entity-sub">${resourceLabels[ref.type]}</div>`,relation:'配置依赖 · 尚未确认因果',action:html`<a class="link" href=${this.resourceHref(ref)}>切换诊断 →</a>`})), '未建立关联关系')}</app-card><details><summary>查看关联技术详情</summary><pre>${JSON.stringify(pack,null,2)}</pre></details>`;
  }
  private renderAside() {
    const gaps = [...new Set([...(this.evidence?.gaps ?? []),...(this.pack?.gaps.map(gap => gap.code) ?? [])])];
    return html`<aside class="diagnosis-aside"><app-card><span slot="header">证据缺口与下一步</span>${gaps.length ? gaps.map(gap => html`<div class="diagnosis-gap"><strong>${gapExplanation(gap)[0]}</strong><p class="caption">下一步：${gapExplanation(gap)[1]}。</p></div>`) : html`<p class="caption">${this.evidence ? '当前返回未列出缺口，仍需核对质量与时间，不能据此确认根因。' : '当前证据尚未取得，检查采集连接与访问权限后刷新。'}</p>`}<button class="link small" @click=${() => { this.dialog = 'gaps'; }}>查看缺口详情 →</button></app-card>
      <app-card><span slot="header">证据来源与范围</span><p class="caption">观测时间与读取时间分别展示。推论、假设及关联关系均不能证明根因。</p><button class="link small" @click=${() => { this.dialog = 'scope'; }}>查看技术信息 →</button>${permissionMatches(this.permissions,'config:view') ? html`<div class="diagnosis-source-link"><a href="/settings/platform/source">按需查看源码快照 →</a></div>` : nothing}</app-card></aside>`;
  }
  private renderDialog() {
    const item = this.selectedEvidence;
    return html`<app-dialog .open=${!!this.dialog} size="xl" title=${{evidence:'证据详情',gaps:'证据缺口详情',scope:'证据来源与范围','':''}[this.dialog]} @app-dialog-close=${() => { this.dialog = ''; }}>
      ${this.dialog === 'evidence' && item ? html`${pairs([['证据类型',diagnosisLabels[item.status] ?? item.status],['质量',evidenceLabels[item.quality] ?? '质量未知'],['新鲜度',evidenceFreshness(item)],['观测时间',displayTime(item.observedAt)],['有效至',displayTime(item.validUntil)],['观测值',item.payload.value === null ? '未知' : item.payload.value ?? '未提供'],['说明',item.payload.reason ?? item.payload.statement ?? '无']])}<p class="detail-note">${evidenceFreshness(item) === '新鲜' && item.quality === 'good' ? '时间和质量有效；仍需结合规则与业务场景确认异常。' : '不能作为当前可信依据。检查采集来源、观测时间和缺失数据，再刷新证据。'}</p><details><summary>原始字段与来源</summary>${pairs([['证据 ID',item.id],['原始状态',item.status],['来源',item.source],['关联 ID',item.correlationId]])}<pre>${JSON.stringify({provenance:item.provenance,dimensions:item.dimensions,payload:item.payload},null,2)}</pre></details>` : this.dialog === 'gaps' ? html`<pre>${JSON.stringify({ current:this.evidence?.gaps ?? [],related:this.pack?.gaps ?? [],truncated:this.evidence?.truncated ?? null,relatedTruncated:this.pack?.truncated ?? null },null,2)}</pre>` : this.dialog === 'scope' ? html`${pairs([['资源 ID',this.selected ? key(this.selected) : '未选择'],['配置状态',this.resources.find(item => this.selected && key(item.resource) === key(this.selected))?.status ?? '未知'],['证据读取时间',displayTime(this.evidence?.generatedAt)],['当前证据截断',!this.evidence ? '未知' : this.evidence.truncated ? '已截断' : '未截断']])}<p class="detail-note">配置状态不代表诊断结论。历史分析快照时间在分析结果中单独展示。</p>` : nothing}
      <div slot="footer"><button class="btn" @click=${() => { this.dialog = ''; }}>关闭</button></div></app-dialog>`;
  }
  override render() {
    const filtered = this.resources.filter(item => `${item.label} ${key(item.resource)}`.toLowerCase().includes(this.search.toLowerCase()) || (this.selected && key(item.resource) === key(this.selected)));
    const selectedListed = this.resources.some(item => this.selected && key(item.resource) === key(this.selected));
    const returnResource = new URL(location.href).searchParams.get('returnResource');
    const returnTo = safeDashboardReturn(new URL(location.href).searchParams.get('returnTo'));
    return html`${returnTo ? html`<a class="btn-ghost" href=${returnTo}>返回原运维总览</a>` : nothing}
      <div class="page-header"><div><h1>跨资源诊断</h1><p class="muted small">围绕资源核对当前证据、关联关系与只读分析结果。</p></div><button class="btn" title="刷新" aria-label="刷新" .disabled=${this.loading} @click=${this.load}>刷新</button></div>
      <app-card .compact=${true}><div class="diagnosis-picker"><app-form-field label="搜索资源"><input aria-label="搜索资源" type="search" placeholder="搜索名称或资源标识" .value=${this.search} @input=${(event: Event) => { this.search = (event.target as HTMLInputElement).value; }}></app-form-field><app-form-field label="诊断对象"><select aria-label="资源" .value=${this.selected ? key(this.selected) : ''} @change=${(event: Event) => this.selectResource((event.target as HTMLSelectElement).value)}><option value="" .disabled=${true}>选择资源</option>${this.selected && !selectedListed ? html`<option .selected=${true} value=${key(this.selected)}>${resourceLabels[this.selected.type]} #${this.selected.id}</option>` : nothing}${Object.entries(resourceLabels).map(([type,label]) => html`<optgroup label=${label}>${filtered.filter(item => item.resource.type === type).map(item => html`<option .selected=${this.selected !== null && key(item.resource) === key(this.selected)} value=${key(item.resource)}>${item.label || `${resourceLabels[item.resource.type]} #${item.resource.id}`} · #${item.resource.id}</option>`)}</optgroup>`)}</select></app-form-field><span class="caption">支持数据库、服务器及网络设备</span></div></app-card>
      ${returnResource && /^(instance|server|network_device):[1-9]\d*$/.test(returnResource) ? html`<button class="btn-ghost diagnosis-return" @click=${() => { const url = new URL(location.href); url.searchParams.delete('returnResource'); history.replaceState({},'',url); this.selectResource(returnResource); }}>← 返回 ${this.resourceName({type:returnResource.split(':')[0] as ResourceType,id:Number(returnResource.split(':')[1])})}</button>` : nothing}
      ${this.renderOverview()}${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${this.evidence?.truncated || this.pack?.truncated ? html`<div class="notice" role="status"><div><strong>返回证据已截断</strong>当前列表不代表完整证据，请核对缺口与采集范围。</div></div>` : nothing}
      ${!this.selected ? this.loading ? html`<div class="skeleton" role="status" aria-label="加载证据"></div>` : html`<app-empty-state title="选择诊断资源" icon="search"></app-empty-state>` : html`
      <div class="diagnosis-workspace"><section class="diagnosis-main"><div class="tabs" role="tablist" @keydown=${tabKeydown} aria-label="诊断工作区">${(['evidence','evaluation','relations','result'] as const).map((tab,index) => html`<button class="tab" role="tab" id=${`diagnosis-tab-${tab}`} aria-controls="diagnosis-panel" tabindex=${this.tab === tab ? 0 : -1} aria-selected=${this.tab === tab} @click=${() => this.switchTab(tab)}>${['当前证据','规则评估','关联资源','分析结果'][index]}${tab === 'result' && this.agentResult ? html`<span>${this.statusUnconfirmed ? '待确认' : this.agentResult.status === 'unknown' ? '未知' : this.agentResult.status === 'completed' ? '已完成' : '待核对'}</span>` : nothing}</button>`)}</div>
        <div id="diagnosis-panel" role="tabpanel" aria-labelledby=${`diagnosis-tab-${this.tab}`}>${this.tab === 'evidence' ? this.renderEvidence() : this.tab === 'evaluation' ? this.contextReady ? keyed(this.requestVersion, html`<resource-evaluation .resourceType=${this.selected.type} .resourceId=${this.selected.id}></resource-evaluation>`) : html`<p role="status">当前评估不可用，请先刷新资源并确认读取权限。</p>` : this.tab === 'relations' ? this.renderRelations() : this.agentResult ? html`<app-card>${this.renderAgentResult()}</app-card>` : html`<app-card><app-empty-state title="尚无诊断任务" description="按需开始只读诊断，可能产生模型费用。"></app-empty-state></app-card>`}
      </div></section>${this.renderAside()}</div>`}${this.renderDialog()}`;
  }
}
