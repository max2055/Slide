import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { metricError, metricRequest, readCollectionStatus, statusLabel, type CollectionStatus } from './metric-api.js';
import { metricName, packageName } from './resource-metric-summary.js';
import { collectionLayoutStyles } from './collection-layout-styles.js';
import { renderCollectionStatus, collectionFactsStyles } from './metric-collection-status.js';
import './app-card.js';
import './app-badge.js';
import './app-dialog.js';
import './metric-configuration.js';
import type { MetricConfiguration } from './metric-configuration.js';

@customElement('resource-collection-section')
export class ResourceCollectionSection extends LitElement {
  @property() resourceType = 'instance';
  @property({ type: Number }) resourceId = 0;
  @property({ type: Boolean }) connectionPending = false;
  @property() mode = 'summary';
  @state() private triggers: any = null;
  @state() private triggerError = '';
  @state() private editing = false;
  @state() private status: CollectionStatus | null = null;
  @state() private error = '';
  @state() private loading = false;
  @state() private events: Array<{ action: string; revision: number; at: string }> = [];
  @state() private eventError = '';
  private generation = 0;
  private readonly accessChanged = () => {
    this.generation++; this.editing = false; this.status = null; this.triggers = null; this.triggerError = ''; this.loading = false; this.events = []; this.eventError = '';
    this.error = '权限或登录状态已变更，请重新打开资源后读取采集状态';
  };
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.accessChanged);
    window.addEventListener('slide-session-expired', this.accessChanged);
  }
  openEditor() {
    if (!this.resourceId || this.connectionPending || this.mode === 'edit') return;
    this.editing = true;
  }

  confirmDiscard(action: () => void) {
    const editor = this.renderRoot.querySelector<MetricConfiguration>('metric-configuration');
    if (editor) editor.confirmDiscard(action); else action();
  }
  override willUpdate(changes: Map<string, unknown>) {
    if (changes.has('resourceType') || changes.has('resourceId')) { this.editing = false; this.status = null; void this.load(); }
  }
  override disconnectedCallback() {
    this.generation++;
    window.removeEventListener('slide-permissions-loaded', this.accessChanged);
    window.removeEventListener('slide-session-expired', this.accessChanged);
    super.disconnectedCallback();
  }
  private async load() {
    const generation = ++this.generation;
    this.error = ''; this.loading = false;
    this.events = []; this.eventError = ''; this.triggers = null; this.triggerError = '';
    if (!this.resourceId || this.mode === 'edit') return;
    this.loading = true;
    try {
      const status = await readCollectionStatus(this.resourceType, this.resourceId);
      if (generation === this.generation) {
        this.status = status;
        void this.loadEvents(generation);
        void this.loadTriggers(generation);
      }
    } catch (e) { if (generation === this.generation) { this.status = null; this.error = metricError(e); } }
    finally { if (generation === this.generation) this.loading = false; }
  }
  private async loadTriggers(generation:number) {
    try { const value=await metricRequest<any>(`template-bindings/${this.resourceType}/${this.resourceId}/effective-triggers`);
      if(generation===this.generation)this.triggers=value;
    } catch(e) {if(generation===this.generation)this.triggerError=metricError(e);}
  }
  private async loadEvents(generation: number) {
    try {
      const events = await metricRequest<ResourceCollectionSection['events']>(`policy/resources/${this.resourceType}/${this.resourceId}/audit`);
      if (!Array.isArray(events)) throw new Error('AUDIT_CONTRACT');
      if (generation === this.generation) this.events = events.slice(0, 5);
    } catch (e) { if (generation === this.generation) this.eventError = metricError(e); }
  }
  render() {
    if (this.mode === 'edit') return html`<style>${sharedBtnStyles}</style>${!this.resourceId || this.connectionPending
      ? html`<p role="status">先保存连接信息，再配置采集。连接保存与采集发布分别确认。</p>` : nothing}
      ${this.resourceId ? html`<metric-configuration .connectionPending=${this.connectionPending} .resourceType=${this.resourceType} .resourceId=${this.resourceId}></metric-configuration>` : nothing}`;
    if (this.editing) return html`<style>${sharedBtnStyles}</style><button class="btn" @click=${() => this.confirmDiscard(() => { this.editing = false; void this.load(); })}>返回配置与运行证据</button><metric-configuration .resourceType=${this.resourceType} .resourceId=${this.resourceId}></metric-configuration>`;
    const status = this.status;
    const observed = status?.formal_visibility.last_observed_at;
    return html`<style>${sharedBtnStyles}${collectionFactsStyles}${collectionLayoutStyles}
      :host{display:block;min-width:0;} .actions{display:flex;flex-wrap:wrap;gap:var(--space-sm);margin-block:var(--space-md);}
      p{overflow-wrap:anywhere;} .skeleton{min-height:6rem;background:var(--bg-hover);}
    </style><app-card><div class="detail-intro"><div><span class="eyebrow">监控与采集</span><h2>配置与运行证据</h2><p class="muted">在这里确认结果；在本资源内修改模板与参数，复用同一配置来源。</p></div>${status ? html`<app-badge>${status.formal_visibility.state === 'pending' ? '等待正式数据' : statusLabel(status.formal_visibility.state)}</app-badge>` : nothing}</div>
      ${!this.resourceId ? html`<p>先保存连接信息，再在此配置兼容模板、检查并试采。保存连接不会代替采集发布。</p>`
        : this.loading ? html`<div class="skeleton" role="status" aria-label="正在读取采集状态">正在读取采集状态…</div>`
        : this.error ? html`<p role="alert">${this.error}</p><button class="btn btn-refresh" @click=${this.load}>重试读取</button>`
        : status ? html`<div class="fact-strip"><div><span>采集模板</span><strong>${status.binding.package ? packageName(status.binding.package.id) : statusLabel(status.binding.state)}</strong><small>模板 ${status.binding.package?.version ?? '—'} · 配置版本 ${status.binding.published_revision ?? '—'}</small></div>
          <div><span>有效采集开关</span><strong>${status.effective_enabled.enabled === null ? '未知' : status.effective_enabled.enabled ? '已启用' : '已停用'}</strong><small>${statusLabel(status.effective_enabled.source)} · ${statusLabel(status.binding.application)}</small></div>
          <div><span>最近正式样本</span><strong>${observed && Number.isFinite(Date.parse(observed)) ? new Date(observed).toLocaleString('zh-CN') : '尚未就绪'}</strong><small>不使用试采替代正式数据</small></div></div>
          ${status.blockers.length ? html`<div class="notice" role="status">${status.blockers.map(b => html`<p>${statusLabel(b)}</p>`)}</div>` : nothing}` : html`<p>采集状态未知</p>`}
      ${this.connectionPending && this.resourceId ? html`<p role="status">连接信息尚未保存，请先保存后再检查或修改采集配置。</p>` : nothing}
      <div class="actions"><button class="btn btn-refresh" ?disabled=${this.loading || !this.resourceId} @click=${this.load}>刷新采集状态</button>
        <button class="btn" ?disabled=${!this.resourceId || this.connectionPending} @click=${this.openEditor}>修改模板与参数</button></div>
    </app-card>
    ${status && !this.loading && !this.error ? html`<app-card><h2>有效触发器</h2>
      ${this.triggerError ? html`<p role="alert">${this.triggerError}</p><button class="btn btn-refresh" @click=${this.load}>重试</button>` : this.triggers?.state === 'available' ? html`<p>实际生效配置 ${this.triggers.revision} · 规则来源为不可变应用快照。</p>${this.triggers.snapshot.rules.length ? this.triggers.snapshot.rules.map((r:any)=>html`<p>${r.rule_id} @ ${r.version} · ${r.metric.id} · ${r.decision}</p>`) : html`<p>该生效快照未配置触发器，不代表资源无异常。</p>`}` : html`<p>尚未取得有效触发器快照；不推断为零项或没有告警。</p>`}</app-card><div class="detail-grid"><app-card><h2>指标与数据质量</h2><div class="coverage-table">${status.coverage.map(c => html`<div><strong>${metricName(c.metric.id)}</strong><app-badge variant=${c.state === 'covered' ? 'ok' : 'muted'}>${statusLabel(c.state)}</app-badge><span>${c.state === 'covered' ? '模板覆盖不等于正式样本就绪' : c.reason ? statusLabel(c.reason) : '依当前资源能力与模板判定'}</span></div>`)}</div>${!status.coverage.length ? html`<p class="muted">尚无可核实的单项覆盖证据</p>` : nothing}</app-card>
      <app-card><h2>最近配置事件</h2>${this.eventError ? html`<p role="alert">${this.eventError}</p>` : this.events.length ? html`<ol class="key-values">${this.events.map(e => html`<li><time>${new Date(e.at).toLocaleString('zh-CN')}</time><p>${e.action === 'binding.publish' ? '发布资源配置' : e.action === 'group.publish' ? '发布策略组' : '配置变更'} · 版本 ${e.revision}</p></li>`)}</ol>` : html`<p class="muted">暂无可读取的配置事件</p>`}</app-card></div>
      <details class="technical"><summary>技术证据与配置版本</summary>${renderCollectionStatus(status)}</details>` : nothing}
    `;
  }
}
