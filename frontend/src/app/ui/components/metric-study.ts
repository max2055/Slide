import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { isMetricAccessError, metricReadError, metricRequest, MetricRequestError } from './metric-api.js';
import { metricDisplayName } from './metric-display.js';
import { metricValueText } from './metric-value-display.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import './app-data-table.js';
import './app-card.js';
import type { MetricStudyCatalogResult,MetricStudyTrendResult,MetricStudyReplayResult,MetricStudyCapacityResult } from '../../../api/generated/public-api.js';

type Catalog=MetricStudyCatalogResult;
type Trend=MetricStudyTrendResult;
type Replay=MetricStudyReplayResult;
type Bucket=Trend['buckets'][number];
type Exact=Bucket['min'];
type StudyRequest = <T>(operation: string, body: unknown) => Promise<T>;
type StudyWork = (request: StudyRequest) => Promise<void>;
type StudyWindow = Catalog['window'];
type CatalogMetric = Catalog['metrics'][number];
const dimensionOperation = '长窗口维度';
const text=(v:Exact)=>v? v.denominator==='1'?v.numerator:`${v.numerator}/${v.denominator}`:'不适用 / 未知';
const local=(s:string)=>new Date(s).toLocaleString('zh-CN');
const inputTime=(s:string)=>{const d=new Date(s),p=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;};

@customElement('metric-study')
export class MetricStudy extends LitElement {
  @property() resourceType='instance';
  @property({type:Number}) resourceId=0;
  @state() private days=30;
  @state() private to=inputTime(new Date().toISOString());
  @state() private from=inputTime(new Date(Date.parse(this.to)-30*86400000).toISOString());
  @state() private metricKey='';
  @state() private dimKey='{}';
  @state() private dimensions:Record<string,string>[]=[];
  @state() private dimensionError = '';
  private retryDimensions?: () => Promise<void>;
  @state() private ruleKey='';
  @state() private tier='1h';
  @state() private interval=60;
  @state() private numericDays=30;
  @state() private otherDays=7;
  @state() private series=1;
  @state() private busy=false;
  @state() private error='';
  @state() private operation = '';
  @state() private appliedWindow: StudyWindow | null = null;
  private retry?: () => Promise<void>;
  private catalogAt = '';
  private trendAt = '';
  private replayAt = '';
  @state() private catalog:Catalog|null=null;
  @state() private trend:Trend|null=null;
  @state() private replay:Replay|null=null;
  @state() private capacity:MetricStudyCapacityResult|null=null;
  @state() private raw:any=null;
  @state() private offset=0;
  private generation=0;
  private invalidated=false;
  private controller=new AbortController();
  static styles=[sharedBtnStyles,css`
    :host{display:block;margin-block:var(--space-lg)}
    .tools{display:flex;gap:var(--space-md);align-items:end;flex-wrap:wrap;margin-block:var(--space-md)}
    label{display:flex;gap:var(--space-xs);flex-direction:column;color:var(--text)}
    select,input{font:inherit;max-width:28rem;padding:var(--space-xs);border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);color:var(--text)}
    .table{overflow:auto;max-width:100%} .hint{color:var(--muted)} [role=alert]{color:var(--danger)}
    .reading{white-space:nowrap;font-variant-numeric:tabular-nums}
    pre{white-space:pre-wrap;overflow-wrap:anywhere} button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  `];
  private accessChanged=()=>{this.invalidated=true;this.clear();this.error='登录或权限已变化，请重新打开资源。';};
  override connectedCallback(){super.connectedCallback();window.addEventListener('slide-permissions-loaded',this.accessChanged);window.addEventListener('slide-session-expired',this.accessChanged);}
  override disconnectedCallback(){this.clear();window.removeEventListener('slide-permissions-loaded',this.accessChanged);window.removeEventListener('slide-session-expired',this.accessChanged);super.disconnectedCallback();}
  override willUpdate(changes:Map<string,unknown>){if(changes.has('resourceType')||changes.has('resourceId')){this.invalidated=false;this.clear();if(this.resourceId)void this.load();}}
  private clear() {
    this.generation++;
    this.controller.abort();
    this.busy = false;
    this.clearFailure();
    this.appliedWindow = null;
    this.clearResults();
  }
  private clearResults() {
    this.catalog = null; this.trend = null; this.replay = null; this.capacity = null; this.raw = null;
    this.dimensions = []; this.dimKey = '{}'; this.metricKey = ''; this.ruleKey = ''; this.offset = 0;
    this.clearDimensionFailure();
    this.catalogAt = ''; this.trendAt = ''; this.replayAt = '';
  }
  private clearFailure() {
    this.error = '';
    this.retry = undefined;
  }
  private clearDimensionFailure() {
    this.dimensionError = '';
    this.retryDimensions = undefined;
  }
  private window() {
    const from = Date.parse(this.from), to = Date.parse(this.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 366 * 86400000) {
      throw new Error('时间窗口需在 366 天内且起点早于终点');
    }
    return { resource: { type: this.resourceType, id: this.resourceId }, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }
  private async run(operation: string, work: StudyWork, retainedAt = '') {
    if (this.invalidated || !this.resourceId) return;
    const generation = ++this.generation, type = this.resourceType, id = this.resourceId, session = apiClient.getSessionContext();
    this.controller.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const current = () => {
      if (generation !== this.generation || type !== this.resourceType || id !== this.resourceId) return false;
      if (session !== apiClient.getSessionContext()) { this.accessChanged(); return false; }
      return true;
    };
    this.busy = true;
    this.operation = operation;
    if (operation === dimensionOperation) this.clearDimensionFailure();
    else this.clearFailure();
    const request: StudyRequest = async <T>(op: string, body: unknown) => {
      const value = await metricRequest<T>(op, body, signal);
      if (!current()) throw new Error('STALE_STUDY');
      return value;
    };
    try { await work(request); }
    catch (error) {
      if (!current()) return;
      if (isMetricAccessError(error)) {
        this.clear();
        this.error = '无权限、登录已失效或资源不可用。';
      } else if (operation === dimensionOperation) {
        this.dimensionError = metricReadError(error, operation);
        this.retryDimensions = () => this.run(operation, work);
      } else if (error instanceof MetricRequestError && error.code === 'HISTORY_RAW_EXPIRED') {
        this.error = '该窗口原始证据已过期；保全趋势可读，但不能用于回放。';
      } else if (error instanceof MetricRequestError && error.code === 'HISTORY_COMPOSITE_REPLAY_UNAVAILABLE') {
        this.error = '组合触发器支持正式告警，历史回放暂仅支持单监控项。';
      } else {
        this.error = metricReadError(error, operation)
          + (retainedAt ? ` 保留同窗口 ${local(retainedAt)} 读取的结果。` : '');
        this.retry = () => this.run(operation, work, retainedAt);
      }
    } finally {
      if (current()) this.busy = false;
    }
  }
  async load() {
    if (this.invalidated || !this.resourceId) return;
    let requested: ReturnType<MetricStudy['window']>;
    try { requested = this.window(); }
    catch (error) {
      this.clear();
      this.error = (error as Error).message;
      return;
    }
    const { from, to } = requested;
    if (this.appliedWindow?.from !== from || this.appliedWindow?.to !== to) this.clearResults();
    this.appliedWindow = { from, to };
    await this.run('长窗口目录', async request => {
      const catalog = await request<Catalog>('study/catalog', requested);
      const previousMetric = this.metricKey;
      const metric = catalog.metrics.find(item => JSON.stringify(item.metric) === previousMetric) ?? catalog.metrics[0];
      this.catalog = catalog;
      this.catalogAt = new Date().toISOString();
      const rules = this.rules();
      if (!rules.some(item => item.key === this.ruleKey)) {
        this.ruleKey = rules[0]?.key ?? '';
        this.replay = null; this.replayAt = '';
      }
      await this.loadDimensions(requested, metric);
    }, this.catalogAt);
  }
  private rules() {
    return (this.catalog?.snapshots ?? []).flatMap(snapshot => snapshot.rules.map(rule => ({
      key: JSON.stringify({ revision: snapshot.config_revision, snapshot_hash: snapshot.snapshot_hash, rule_id: rule.rule_id, scope: rule.scope }),
      label: `${metricDisplayName(rule.metric.id)} · v${rule.version} · 配置修订 ${snapshot.config_revision} · ${rule.scope}`,
    })));
  }
  private changePreset(days: number) {
    const now = Date.now();
    this.days = days;
    this.to = inputTime(new Date(now).toISOString());
    this.from = inputTime(new Date(now - days * 86400000).toISOString());
    void this.load();
  }
  private clearTrend() { this.trend = null; this.raw = null; this.offset = 0; this.trendAt = ''; }
  private async selectMetric(key: string) {
    const metric = this.catalog?.metrics.find(item => JSON.stringify(item.metric) === key);
    if (metric) await this.loadDimensions(this.window(), metric);
  }
  private async loadDimensions(window: ReturnType<MetricStudy['window']>, metric?: CatalogMetric) {
    this.clearDimensionFailure();
    const key = metric ? JSON.stringify(metric.metric) : '';
    if (key !== this.metricKey) {
      this.clearTrend();
      this.dimensions = [];
      this.dimKey = '{}';
      this.metricKey = key;
    }
    if (!metric) return;
    if (!metric.definition) {
      this.dimensions = [];
      this.dimKey = '{}';
      this.clearTrend();
      this.dimensionError = '该指标缺少定义，无法读取维度。请选择其他指标。';
      return;
    }
    const body = { ...window, metric: metric.metric };
    await this.run(dimensionOperation, async request => {
      const result = await request<{ dimensions: Record<string, string>[] }>('study/dimensions', body);
      this.dimensions = result.dimensions;
      const dimension = this.dimensions.find(item => JSON.stringify(item) === this.dimKey) ?? this.dimensions[0];
      const dimensionKey = JSON.stringify(dimension ?? {});
      if (!dimension || dimensionKey !== this.dimKey) this.clearTrend();
      this.dimKey = dimensionKey;
    });
  }
  async queryTrend() {
    const body = { ...this.window(), metric: JSON.parse(this.metricKey), dimensions: JSON.parse(this.dimKey), tier: this.tier, interval_ms: this.interval * 1000 };
    await this.run('长窗口趋势', async request => {
      this.trend = await request<Trend>('study/trend', body);
      this.raw = null; this.offset = 0; this.trendAt = new Date().toISOString();
    }, this.trendAt);
  }
  async replayWindow() {
    const body = { ...this.window(), ...JSON.parse(this.ruleKey) };
    await this.run('隔离回放', async request => {
      this.replay = await request<Replay>('study/replay', body);
      this.replayAt = new Date().toISOString();
    }, this.replayAt);
  }
  private async preview() {
    this.capacity = null;
    const body = { resource: { type: this.resourceType, id: this.resourceId }, assumptions: {
      numeric_days: this.numericDays, non_numeric_days: this.otherDays, interval_ms: this.interval * 1000, series_per_resource: this.series,
    }};
    await this.run('容量预览', async request => { this.capacity = await request('study/capacity', body); });
  }
  private async moreRaw() { await this.readRaw(this.raw.window, this.raw.next_cursor); }
  private async readRaw({ from, to }: StudyWindow, cursor?: string) {
    const body = { resource: { type: this.resourceType, id: this.resourceId }, metric: JSON.parse(this.metricKey),
      dimensions: JSON.parse(this.dimKey), from, to, ...(cursor ? { cursor } : {}), limit: 100 };
    if (!cursor) this.raw = null;
    await this.run('同桶原始观测', async request => { this.raw = await request('observations', body); });
  }
  private statistic(value: Exact, metric: Catalog['metrics'][number] | undefined) {
    if (!value) return text(value);
    const exact = text(value);
    const unit = metric?.definition?.unit;
    const number = Number(value.numerator) / Number(value.denominator);
    const reading = metric && unit && (value.denominator === '1' || Number.isFinite(number))
      ? metricValueText(value.denominator === '1' ? value.numerator : number, unit, metric.metric.id) : exact;
    return html`<span class="reading">${reading}</span><details><summary>精确值</summary><code>${exact}${unit ? ` ${unit}` : ''}</code></details>`;
  }
  override render(){const rules=this.rules(),buckets=this.trend?.buckets??[];
    const metric = this.catalog?.metrics.find(item => JSON.stringify(item.metric) === this.metricKey);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return html`<app-card><span slot="header">长窗口历史、趋势与隔离回放</span>
      <p class="hint">研究窗口与主图窗口独立。时间按 ${timezone} 显示。</p>
      <div class="tools"><label>研究窗口<select aria-label="历史研究窗口" .value=${String(this.days)} @change=${(e: Event) => this.changePreset(Number((e.target as HTMLSelectElement).value))}>${[1,7,30,90,366].map(d=>html`<option value=${d} .selected=${this.days === d}>${d} 天</option>`)}</select></label>
        <label>开始<input aria-label="研究开始时间" type="datetime-local" step="1" .value=${this.from} @change=${(e:Event)=>{this.from=(e.target as HTMLInputElement).value;void this.load();}}></label>
        <label>结束<input aria-label="研究结束时间" type="datetime-local" step="1" .value=${this.to} @change=${(e:Event)=>{this.to=(e.target as HTMLInputElement).value;void this.load();}}></label>
        <button class="btn btn-refresh" ?disabled=${this.busy||!this.resourceId||this.invalidated} @click=${this.load}>刷新历史研究</button></div>
      ${this.appliedWindow ? html`<p class="hint">研究窗口（${timezone}）：${local(this.appliedWindow.from)} — ${local(this.appliedWindow.to)}</p>
        <details><summary>研究窗口边界</summary><p>UTC [${this.appliedWindow.from}, ${this.appliedWindow.to})。聚合保留缺口，回放从未知状态开始。</p></details>` : nothing}
      ${this.busy && this.operation !== dimensionOperation ? html`<p role="status">正在读取${this.operation}</p>` : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>${this.retry ? html`<button class="btn" @click=${() => void this.retry?.()}>重试${this.operation}</button>` : nothing}` : nothing}
      ${!this.resourceId?html`<p>请先选择授权资源。</p>`:nothing}
      ${this.catalog?html`<div class="tools"><label>历史指标<select aria-label="历史研究指标" ?disabled=${this.busy} @change=${(e:Event)=>void this.selectMetric((e.target as HTMLSelectElement).value)}>${this.catalog.metrics.map(m=>html`<option value=${JSON.stringify(m.metric)} .selected=${this.metricKey===JSON.stringify(m.metric)}>${metricDisplayName(m.metric.id)}${this.catalog?.metrics.some(other => other.metric.id === m.metric.id && other.metric.semantic_version !== m.metric.semantic_version) ? ` · v${m.metric.semantic_version}` : ''}</option>`)}</select></label>
        <label>维度<select aria-label="历史研究维度" ?disabled=${this.busy} @change=${(e:Event)=>{this.dimKey=(e.target as HTMLSelectElement).value;this.clearTrend();this.clearFailure();}}>${this.dimensions.map(d=>html`<option value=${JSON.stringify(d)} .selected=${this.dimKey===JSON.stringify(d)}>${Object.entries(d).map(([k,v])=>`${k}=${v}`).join(' / ')||'整体'}</option>`)}</select></label>
        <label>聚合层级<select aria-label="历史聚合层级" ?disabled=${this.busy} .value=${this.tier} @change=${(e:Event)=>{this.tier=(e.target as HTMLSelectElement).value;this.clearTrend();this.clearFailure();}}><option value="5m">5 分钟</option><option value="1h">1 小时</option><option value="1d">1 天</option></select></label>
        <label>采样周期假设（秒）<input aria-label="研究采样周期秒" ?disabled=${this.busy} type="number" min="1" max="86400" .value=${String(this.interval)} @change=${(e:Event)=>{this.interval=Number((e.target as HTMLInputElement).value);this.clearTrend();this.capacity=null;this.clearFailure();}}></label>
        <button class="btn" ?disabled=${this.busy||!this.metricKey||!this.dimensions.length||!!this.dimensionError} @click=${this.queryTrend}>对照原始与趋势</button></div>
        ${this.metricKey ? html`<section aria-label="历史研究维度">
          ${this.busy && this.operation === dimensionOperation ? html`<p role="status">正在读取${dimensionOperation}</p>` : nothing}
          ${this.dimensionError ? html`<p role="alert">${this.dimensionError}</p>
            ${this.retryDimensions ? html`<button class="btn" ?disabled=${this.busy} @click=${() => void this.retryDimensions?.()}>重试${dimensionOperation}</button>` : nothing}` : nothing}
        </section>` : nothing}
        ${!this.catalog.metrics.length && !(this.operation === '长窗口目录' && (this.busy || this.error)) ? html`<p role="status">研究窗口没有可读取的正式历史。</p>`:nothing}
        <div class="tools"><label>固定历史规则<select aria-label="历史回放规则" ?disabled=${this.busy} @change=${(e:Event)=>{this.ruleKey=(e.target as HTMLSelectElement).value;this.replay=null;this.replayAt='';this.clearFailure();}}>${rules.map(r=>html`<option value=${r.key} .selected=${this.ruleKey===r.key}>${r.label}</option>`)}</select></label><button class="btn" ?disabled=${this.busy||!this.ruleKey} @click=${this.replayWindow}>隔离回放此窗口</button></div>
        ${!rules.length?html`<p>没有保全的历史规则快照，不能用当前规则代填。</p>`:nothing}`:nothing}
      ${this.trend?html`<p role="status">${buckets.length ? `趋势已完成 · ${buckets.length} 个桶；${this.trend.note}` : '研究窗口没有趋势记录。'}</p><details><summary>趋势定义与证据</summary>
          <p>${metric?.metric.id} · 语义版本 ${metric?.metric.semantic_version} · 单位 ${metric?.definition?.unit ?? '未知'}</p>
          <p>证据 ${this.trend.evidence_hash}</p></details>
        <div class="table"><app-data-table .columns=${[{key:'window',label:'本地时间窗口'},{key:'count',label:'count / 数值有效'},{key:'min',label:'min'},{key:'max',label:'max（峰值）'},{key:'avg',label:'avg（精确比值）'},{key:'quality',label:'质量 / 覆盖假设 / 最大缺口'},{key:'raw',label:'原始对照'}]}
          .rows=${buckets.slice(this.offset,this.offset+50).map(b=>({window:`${local(b.from)} — ${local(b.to)}`,count:`${b.count} / ${b.numeric_count}`,min:this.statistic(b.min,metric),max:this.statistic(b.max,metric),avg:this.statistic(b.avg,metric),quality:`${b.quality} / ${(b.coverage*100).toFixed(0)}% / ${b.max_gap_ms/1000}s；无效${b.invalid_count} 非数值${b.non_numeric_count} 估算${b.estimated_count}`,raw:b.raw_status&&b.raw_status!=='available'?html`<span>${b.raw_status==='partial_expired'?'部分原始已过期':'原始已过期'} · ${b.statistics_complete?'保全统计':'边界统计不完整'}；不能回放</span>`:html`<button class="btn btn-sm" ?disabled=${this.busy} @click=${()=>void this.readRaw(b)}>查看原始观测</button>`}))}></app-data-table></div>
        <button class="btn" ?disabled=${this.offset===0} @click=${()=>this.offset=Math.max(0,this.offset-50)}>上一组时间桶</button><button class="btn" ?disabled=${this.offset+50>=buckets.length} @click=${()=>this.offset+=50}>下一组时间桶</button>
        ${this.raw?html`<details open><summary>同桶原始观测 ${this.raw.observations.length}/${this.raw.total}；${this.raw.has_more?'当前页，后续可继续读取':'完整桶'}</summary><pre>${JSON.stringify(this.raw.observations,null,2)}</pre>${this.raw.has_more?html`<button class="btn" ?disabled=${this.busy} @click=${this.moreRaw}>下一页同桶原始观测</button>`:nothing}</details>`:nothing}`:nothing}
      ${this.replay?html`<section aria-label="隔离回放结果"><h3>隔离回放已完成</h3><p>配置修订 ${this.replay.revision} · 规则 v${this.replay.rule.version} · 原始证据 ${this.replay.evidence_count} 条；初态未知。未写正式问题、事件或通知。</p><p>证据 ${this.replay.evidence_hash}</p><p>同规则、版本与配置修订的正式事件：${this.replay.formal_events_readable?this.replay.formal_events.length:'无查看权限'}；以下为正式区段对照，回放未修改这些事实。</p><pre>${this.replay.formal_events.map(e=>`${local(e.from)} — ${e.to?local(e.to):'尚未恢复'}；事件 ${e.event_id}，未知区段 ${e.unknown_segments.length}`).join('\n')}</pre>${!this.replay.runs.length?html`<p>没有可评估的原始证据，结果未知。</p>`:nothing}${this.replay.runs.map(r=>html`<p>${Object.values(r.dimensions).join(' / ')||'整体'}：样本判定 ${r.timeline.filter(t=>t.event_type==='sample').length}、时钟判定 ${r.timeline.filter(t=>t.event_type==='clock').length}；问题 ${r.timeline.filter(t=>t.business==='problem').length} 次、健康 ${r.timeline.filter(t=>t.business==='healthy').length} 次、未知 ${r.timeline.filter(t=>t.business==='unknown').length} 次；窗口末 ${r.tail.business}（${r.tail.reason}）。</p><details><summary>样本与时钟判定、质量</summary><pre>${JSON.stringify(r.timeline,null,2)}</pre></details>`)}</section>`:nothing}
      <details><summary>按值类型的保留、容量与清理预览</summary><p>500 服务器 / 100 数据库 / 50 网络设备是预测目标；每资源序列数和周期是测量假设。预览需要资源管理与指标管理权限。</p><div class="tools">${[['数值保留天数',this.numericDays,(v:number)=>this.numericDays=v],['非数值保留天数',this.otherDays,(v:number)=>this.otherDays=v],['每资源序列假设',this.series,(v:number)=>this.series=v]].map(([label,value,set])=>html`<label>${label}<input aria-label=${String(label)} ?disabled=${this.busy} type="number" min="1" .value=${String(value)} @change=${(e:Event)=>{(set as (v:number)=>void)(Number((e.target as HTMLInputElement).value));this.capacity=null;this.clearFailure();}}></label>`)}<button class="btn" ?disabled=${this.busy||!this.resourceId||this.invalidated} @click=${this.preview}>预览容量与清理</button></div>
        ${this.capacity?html`<p role="status">预览已审计；未执行清理。</p><p>${this.capacity.boundary}</p><p>保全趋势实测：${this.capacity.retained_trends.buckets} 个桶、${this.capacity.retained_trends.payload_bytes} 载荷字节、${this.capacity.retained_trends.receipts} 条幂等保全回执；独立保留 ${this.capacity.retained_trends.retention_ms/86400000} 天。</p><p>趋势预测（650资源）：${this.capacity.retained_trends.projected_buckets_650} 个桶，统计JSON ${this.capacity.retained_trends.projected_statistics_bytes_650??'未知'} 字节；幂等回执 ${this.capacity.retained_trends.projected_receipts_650} 条。${this.capacity.retained_trends.basis}</p><p>已配置的保留上限：原始证据 ${this.capacity.configured_retention.rawMs/86400000} 天，归一化历史 ${this.capacity.configured_retention.historyMs/86400000} 天；趋势 ${(this.capacity.configured_retention.trendMs??365*86400000)/86400000} 天独立保留。下表天数是本次预测输入，未修改正式配置。</p>
          <div class="table"><app-data-table .columns=${[{key:'type',label:'值类型'},{key:'rows',label:'选中资源实测行数'},{key:'bytes',label:'实测载荷字节'},{key:'days',label:'假设保留天数'},{key:'projected',label:'650资源预测行数'},{key:'storage',label:'预测载荷字节'}]} .rows=${this.capacity.measured.map(m=>({type:m.value_class,rows:m.rows,bytes:m.payload_bytes,days:m.retention_days,projected:m.projected_rows_650??'未知',storage:m.projected_payload_bytes_650??'未知'}))}></app-data-table></div>
          ${!this.capacity.measured.length?html`<p>没有可测量的载荷，容量预测未知。</p>`:nothing}
          <div class="table"><app-data-table .columns=${[{key:'object',label:'候选对象'},{key:'count',label:'可清理数量'},{key:'oldest',label:'最早存储时间'}]} .rows=${Object.entries(this.capacity.cleanup_candidates).map(([k,v])=>({object:({rawPayload:'原始载荷',normalized:'归一化历史',rawIdentity:'已过期原始身份'} as Record<string,string>)[k]??k,count:v.count,oldest:v.oldestAt?local(v.oldestAt):'无候选'}))}></app-data-table></div>
          <p class="hint">既有650资源短时基线：每资源1序列、60秒周期，组合历史读 p95 为10.19–18.75毫秒。本次预测未证明生产 SLO。P0停止门槛：采样延迟 p95 超过2周期、缺测率超过5%或出现重复事件；本预览未测量这些运行门槛。</p>`:nothing}</details>
    </app-card>`;
  }
}
