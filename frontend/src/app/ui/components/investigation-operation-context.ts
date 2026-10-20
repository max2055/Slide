import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { OperationsResource, operationLabels, resourceLabel, type RelationGraph, type BaselineRecord, type ResourceRef, type AttentionPage } from '../controllers/operations-api.ts';
import { resourceDetailUrl } from './resource-investigation-links.ts';
import { operationsStyles } from '../views/operations-styles.ts';
import './app-card.ts';
import './app-badge.ts';
import './app-empty-state.ts';

@customElement('operations-resource-relations')
export class OperationsResourceRelations extends LitElement {
  static styles = operationsStyles;
  @property() resourceType: ResourceRef['type'] = 'instance';
  @property({ type: Number }) resourceId = 0;
  private graph = new OperationsResource<RelationGraph>(this);
  private contextKey = '';
  private async load() {
    this.contextKey = `${this.resourceType}:${this.resourceId}`;
    if (this.resourceId > 0) await this.graph.load(`/resources/${this.resourceType}/${this.resourceId}/relations?hops=2&maxEdges=100&factsOnly=false`);
  }
  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has('resourceType') || changed.has('resourceId')) { this.graph.reset(); this.contextKey = ''; }
  }
  render() {
    const g = this.graph;
    return html`<details @toggle=${(e: Event) => { if ((e.target as HTMLDetailsElement).open && !this.contextKey) void this.load(); }}>
      <summary>资源关系与可信度</summary><p class="muted">最多 2 跳、100 条边。缺失关系不代表不存在依赖；建议关系不作为已确认事实。</p>
      <button class="btn btn-refresh" ?disabled=${g.loading || g.accessInvalidated} @click=${this.load}>刷新资源关系</button>
      ${g.loading ? html`<p role="status">正在读取资源关系…</p>` : nothing}${g.error ? html`<p role="alert">${g.error}</p>` : nothing}
      ${g.data ? html`${g.data.partial ? html`<p class="notice warn" role="status">关系仅部分可见，不能据此判断完整影响范围。</p>` : nothing}
        ${g.data.edges.length ? g.data.edges.map(edge => html`<div class="row"><p><a href=${resourceDetailUrl(edge.source.type,edge.source.id)}>${resourceLabel(edge.source)}</a> · ${operationLabels[edge.relationType] ?? edge.relationType} · <a href=${resourceDetailUrl(edge.target.type,edge.target.id)}>${resourceLabel(edge.target)}</a></p>
          <div class="meta"><app-badge variant=${edge.verification === 'confirmed' ? 'ok' : 'warn'}>${operationLabels[edge.verification] ?? edge.verification}</app-badge><span>来源：${operationLabels[edge.provenance] ?? edge.provenance}</span><span>v${edge.version}</span><span>有效期至 ${edge.validUntil ? new Date(edge.validUntil).toLocaleString('zh-CN') : '未设截止时间'}</span></div>
          <details><summary>关系版本标识</summary><pre>${JSON.stringify({relationId:edge.relationId,version:edge.version,hash:edge.contentHash,validFrom:edge.validFrom},null,2)}</pre></details></div>`)
        : html`<app-empty-state title="暂无可访问关系" description="当前授权范围没有可显示关系，不能推断资源无依赖。"></app-empty-state>`}` : nothing}
    </details>`;
  }
}

const baselineReasons: Record<string, string> = {
  insufficient_valid_days:'有效观测天数不足', coverage_below_90_percent:'有效覆盖率不足 90%', long_gap:'存在连续观测缺口',
  insufficient_repeated_periods:'同时间段的重复样本不足', not_covered:'当前模板未覆盖', collection_disabled:'采集已关闭',
  configuration_pending:'采集配置尚未生效', stale_observation:'当前观测已过期', resource_changed_reaccumulating:'资源变更后需重新积累',
  holdout_distribution_shift:'独立验证窗口发生分布变化', observation_window:'观测窗口尚不满足要求',
};
@customElement('operations-behavior-baseline')
export class OperationsBehaviorBaseline extends LitElement {
  static styles = operationsStyles;
  @property() resourceType: ResourceRef['type'] = 'instance';
  @property({ type: Number }) resourceId = 0;
  @property() metric = '';
  @property({ attribute: false }) dimensions: Record<string,string> = {};
  @state() private mode = 'weekly';
  private baseline = new OperationsResource<BaselineRecord>(this);
  protected willUpdate(changed: Map<string,unknown>) {
    if (['resourceType','resourceId','metric','dimensions'].some(key => changed.has(key))) this.baseline.reset();
  }
  private async compute() {
    if (!this.resourceId || !this.metric) return;
    const value = await this.baseline.write<BaselineRecord>('/baselines', { resource:{type:this.resourceType,id:this.resourceId}, metric:this.metric, dimensions:this.dimensions,mode:this.mode });
    if (value) { this.baseline.data = value; this.requestUpdate(); }
  }
  render() {
    const b = this.baseline, r = b.data?.result;
    const known = r?.state === 'qualified' && r.status === 'known' && Date.parse(r.validUntil) > Date.now();
    return html`<app-card><span slot="header">行为基线与资格</span><p>按相同资源、指标、单位及采集版本比较。缺数据保持未知，静态阈值独立保留。</p>
      <div class="toolbar"><label>比较周期<select aria-label="基线比较周期" .value=${this.mode} ?disabled=${b.locked} @change=${(e: Event) => {this.mode=(e.target as HTMLSelectElement).value;b.reset();}}><option value="weekly">周模式 · 28 天</option><option value="daily">日模式 · 14 天</option></select></label>
      <button class="btn" ?disabled=${b.locked || !this.metric} @click=${this.compute}>评估此指标基线</button></div>
      ${b.writing ? html`<p role="status">正在评估历史观测，不会触发资源变更…</p>` : nothing}${b.error ? html`<p role="alert">${b.error}</p>` : nothing}
      ${b.mutationUnknown ? html`<p class="notice warn">基线保存结果未知，当前页面不重发。</p>` : nothing}
      ${r ? html`<dl><dt>当前资格</dt><dd><app-badge variant=${known ? 'ok' : 'warn'}>${known ? '可提供比较' : '偏离状态未知'}</app-badge></dd>
        <dt>有效观测天数</dt><dd>${r.quality.validDays} / ${r.mode === 'daily' ? 14 : 28} 天</dd><dt>有效覆盖</dt><dd>${(r.quality.coverage*100).toFixed(1)}%</dd>
        <dt>有效采样</dt><dd>${r.quality.samples} · 缺失小时 ${r.quality.missing}</dd><dt>独立验证窗口</dt><dd>${r.validation.from} — ${r.validation.until}</dd></dl>
        ${known && r.comparison.reference && r.comparison.value !== null ? html`<p class="notice">当前观测 ${r.comparison.value} · 参考区间 ${r.comparison.reference.lower}–${r.comparison.reference.upper} · ${r.comparison.baselineAnomaly === null ? '偏离未知' : r.comparison.baselineAnomaly ? '偏离参考区间' : '位于参考区间内'}</p>`
          : html`<p class="notice warn">${r.reason ? baselineReasons[r.reason] ?? '当前证据尚不满足可比条件' : '观测已过期或资格未满足'}。不绘制正常偏离图。</p>`}
        <p>本次比较附带的静态阈值：${r.staticComparison.status === 'not_configured' ? '未指定（原有静态告警规则保持独立）' : r.staticComparison.status !== 'known' || r.staticComparison.anomaly === null ? '未知' : r.staticComparison.anomaly ? '触发阈值' : '未触发阈值'}</p>
        <details><summary>版本与资格依据</summary><pre>${JSON.stringify(b.data,null,2)}</pre></details>` : html`<p class="muted">选择指标与维度后显式评估；尚未评估不代表正常。</p>`}
    </app-card>`;
  }
}

@customElement('investigation-operation-context')
export class InvestigationOperationContext extends LitElement {
  static styles = operationsStyles;
  @property() investigationId = '';
  @property({ type:Number }) resultVersion = 0;
  @property({ attribute:false }) resources: ResourceRef[] = [];
  private attention = new OperationsResource<AttentionPage>(this);
  protected willUpdate(changed: Map<string,unknown>) {
    if (changed.has('investigationId') || changed.has('resources')) this.attention.reset();
  }
  private async computeAttention() {
    if (!this.resources.length || this.resources.length > 20) return;
    // A persisted server snapshot, calculated only on explicit user request.
    const snapshot = await this.attention.write<{id:string}>('/attention',{observedAt:new Date().toISOString(),resources:this.resources.map(({type,id})=>({type,id}))});
    if (snapshot) await this.attention.load(`/attention/${encodeURIComponent(snapshot.id)}`);
  }
  render() {
    const a = this.attention;
    return html`<app-card><span slot="header">案例参考与行动</span><p>历史案例是参考材料，与当前事实分开核对。创建计划不会获得执行许可。</p>
      <div class="toolbar"><a class="btn" href=${`/operations-knowledge?sourceInvestigation=${encodeURIComponent(this.investigationId)}`}>查找可信案例</a>
        ${this.resultVersion ? html`<a class="btn" href=${`/operations-knowledge?sourceInvestigation=${encodeURIComponent(this.investigationId)}&resultVersion=${this.resultVersion}`}>从当前结果整理案例</a>` : nothing}
        <a class="btn" href=${`/operations-actions?sourceInvestigation=${encodeURIComponent(this.investigationId)}`}>查看行动计划</a></div>
      <p class="muted">行动仅限专用工具、不可变计划与独立人工批准；后续仍需显式执行及效果验证。</p>
    </app-card><app-card><span slot="header">关联事项与解释</span><p>按资源、当前时间窗口与可信关系关联，不将相关性解释为根因。</p>
      <button class="btn" ?disabled=${a.locked || !this.resources.length || this.resources.length > 20} @click=${this.computeAttention}>评估当前关联事项</button>
      ${a.writing || a.loading ? html`<p role="status">正在读取关联事项…</p>` : nothing}${a.error ? html`<p role="alert">${a.error}</p>` : nothing}
      ${a.mutationUnknown ? html`<p class="notice warn">关联快照保存结果未知，当前页面不重发。</p>` : nothing}
      ${a.data ? html`<p class="muted">${a.data.from} — ${a.data.until} · ${a.data.authorizedCounts.total} 项可访问关联组</p>${a.data.partial ? html`<p class="notice warn">部分数据不可用，排序与影响范围仍有缺口。</p>` : nothing}
        ${a.data.items.length ? a.data.items.map(group => html`<div class="row"><div class="row-head"><strong>${group.eventIds.length} 个关联事件 · ${operationLabels[group.severity] ?? group.severity}</strong><app-badge variant="warn">${group.currentValidity === 'current' ? '规则关联' : '有效性未知'}</app-badge></div>
          <p>已知分数 / 可能上界：${group.score.lower}–${group.score.upper} · 评分覆盖率 ${(group.score.coverage*100).toFixed(0)}%</p>
          <details><summary>关联理由与评分缺口</summary><p>关联不等于根因；未知分项不重分配权重。</p><pre>${JSON.stringify({reasons:group.reasons,components:group.score.components,missing:group.missing,ruleVersion:a.data!.ruleVersion},null,2)}</pre></details>
          ${group.investigationIds.map(id => html`<a href=${`/investigations?investigation=${encodeURIComponent(id)}`}>打开关联调查</a> `)}</div>`)
          : html`<app-empty-state title="当前窗口暂无关联事件" description="没有匹配记录不代表无异常。"></app-empty-state>`}
        ${a.data.nextCursor ? html`<button class="btn" ?disabled=${a.loading} @click=${() => void a.load(`/attention/${encodeURIComponent(a.data!.id)}?version=${a.data!.version}&cursor=${encodeURIComponent(a.data!.nextCursor!)}`)}>下一页关联事项</button>` : nothing}` : nothing}
    </app-card>`;
  }
}
