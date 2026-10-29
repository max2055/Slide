import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import './app-card.js';
import './app-data-table.js';
import './app-empty-state.js';
import './app-badge.js';
import './metric-chart.js';
import './investigation-operation-context.ts';
import { metricDisplayName as metricName } from './metric-display.js';
import { MetricRequestError, collectionStatusLabels, readCollectionAttempts, readCollectionSummary, type CollectionAttempt, type CollectionStatus } from './metric-api.js';
import { showToast } from './app-toast-container.js';
export type MetricValue = { encoding: string; value?: number | string; [key: string]: unknown };
export interface MetricBucket {
  value: MetricValue | null; unit: string; coverage: number;
  quality: { status: string; reason: string }; freshness: string; observed_at?: string | null; accuracy: string;
  sources: unknown[]; window: { from: string; to: string }; sample_count?: number;
  stats?: { count: number; min: MetricValue; max: MetricValue; avg: MetricValue } | null;
}
export interface MetricResult {
  definition: { id: string; category: string; meaning: string; unit: string; kind?: string; aggregation?: { time?: string[]; space?: string[] } };
  state: string; capability: unknown;
  observed_at?: string;
  series: Array<{ dimensions: Record<string, string>; buckets: MetricBucket[] }>;
}
export interface SemanticResult { profile: { columns: Array<{ key: string; label?: string; metric: { id: string } }> }; window: { from: string; to: string }; metrics: MetricResult[] }
const states: Record<string, string> = { query_operation_unavailable: '当前定义不允许速率聚合', available: '可用', not_configured: '当前模板未覆盖', not_covered: '当前模板未覆盖', disabled: '已停用', unsupported: '能力不支持', permission_denied: '采集权限不足', temporary_failure: '采集暂时失败', capability_unknown: '能力待确认' };
const qualityLabels: Record<string, string> = { good: '良好', partial: '部分', unknown: '未知', invalid: '无效', fresh: '新鲜', stale: '过期', exact: '精确', estimated: '估算' };
const attemptLabels: Record<string, string> = { running: '进行中', succeeded: '成功', partial: '部分完成', failed: '失败', cancelled: '已取消' };
/** The sources of a bucket already name the collector and the package that produced it. */
type BucketSource = { source?: { collector_id?: unknown }; versions?: { package_id?: unknown; package_version?: unknown } };
const sourceSummary = (b: MetricBucket) => {
  const items = (Array.isArray(b.sources) ? b.sources : []) as BucketSource[];
  const collectors = [...new Set(items.map(s => s?.source?.collector_id).filter((v): v is string => typeof v === 'string' && v !== ''))];
  const packages = [...new Set(items.map(s => {
    const id = s?.versions?.package_id, version = s?.versions?.package_version;
    if (typeof id !== 'string' || id === '') return null;
    return typeof version === 'string' && version !== '' ? `${id} ${version}` : id;
  }).filter((v): v is string => v !== null))];
  return { collectors, packages };
};
/** Mirrors the formal query contract: 60s default and a 7-day window at that resolution. */
const MAX_BUCKETS = 10_080, MIN_BUCKET_MS = 60_000, MAX_WINDOW_MS = 31 * 86_400_000;
const DETAIL_BUCKET_LIMIT = 200;
export function bucketMsFor(fromMs: number, toMs: number): number {
  const span = toMs - fromMs;
  if (!Number.isFinite(span) || span <= 0) return MIN_BUCKET_MS;
  return Math.max(MIN_BUCKET_MS, Math.ceil(span / MAX_BUCKETS / MIN_BUCKET_MS) * MIN_BUCKET_MS);
}
const bucketLabel = (ms: number) => ms % 86_400_000 === 0 ? `${ms / 86_400_000} 天` : ms % 3_600_000 === 0 ? `${ms / 3_600_000} 小时` : ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : `${ms / 1000} 秒`;
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const localTime = (iso?: string | null) => iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString('zh-CN') : '未知';
const localInput = (iso: string) => {
  const d = new Date(iso), pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const safeNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : null;
};
/** Rate queries legitimately report `By/s` or `count/s`; anything else must not be merged into the curve. */
const unitMismatch = (metric: MetricResult, unit: string | undefined) => {
  // Older responses do not publish the kind, so the expected suffix cannot be checked.
  if (!unit || !metric.definition.kind) return false;
  const allowed = [metric.definition.unit];
  if (metric.definition.kind === 'counter' && ['By', 'count'].includes(metric.definition.unit) && metric.definition.aggregation?.time?.includes('rate')) allowed.push(`${metric.definition.unit}/s`);
  return !allowed.includes(unit);
};
const bucketNumber = (b: MetricBucket) => safeNumber(b.value && 'value' in b.value ? b.value.value : null);
const qualityBadges = (b: MetricBucket) => html`<div class="quality-badges">${[b.quality.status, b.freshness, b.accuracy].map(label => html`<app-badge variant=${['good', 'fresh', 'exact'].includes(label) ? 'muted' : 'warn'}>${qualityLabels[label] ?? label}</app-badge>`)}</div>`;
const observedTime = (b: MetricBucket | undefined) => b?.observed_at && Number.isFinite(Date.parse(b.observed_at))
  ? html`<div>观测时间：<time datetime=${b.observed_at}>${localTime(b.observed_at)}</time></div>` : html`<div>观测时间：未知</div>`;
export function renderMetricValue(m: MetricResult) {
  return html`<span>${states[m.state] ?? m.state}</span>${m.series.map(s => {
    const b = s.buckets.at(-1);
    return html`<div>
      ${Object.entries(s.dimensions).map(([k, v]) => `${k}=${v}`).join(' / ')}
      ${b ? html`<div><strong>${b.value && 'value' in b.value ? b.value.value : '未知'}</strong> ${b.unit} · 最近时间桶</div>
        ${observedTime(b)}${qualityBadges(b)}
        <span>覆盖率 ${(b.coverage * 100).toFixed(0)}%</span><details><summary>窗口、质量与来源</summary><p>采集窗口 ${localTime(b.window.from)} — ${localTime(b.window.to)}</p><p>质量原因：${b.quality.reason}</p><pre>${JSON.stringify(b.sources, null, 2)}</pre></details>` : html`<span> · 暂无可用观测</span>`}
    </div>`;
  })}`;
}
const errors = (status: number) => status === 403 ? '没有此资源的查看权限' : status === 401 ? '登录已失效' : '查询暂时失败；保留上次结果，不能据此判断健康';
@customElement('semantic-metrics')
export class SemanticMetrics extends LitElement {
  @property() resourceType = 'instance';
  @property({ type: Number }) resourceId = 0;
  @property() from = '';
  @property() to = '';
  @state() private selectedMetric = '';
  @state() private baselineKey = '';
  @state() private hours = 1;
  @state() private custom = false;
  @state() private customFrom = '';
  @state() private customTo = '';
  @state() private customError = '';
  private range: { from: string; to: string } | null = null;
  @state() private chartKeys = new Set<string>();
  @state() private bucketKeys = new Set<string>();
  @state() result: SemanticResult | null = null;
  @state() error = '';
  @state() busy = false;
  private generation = 0;
  @state() private accessInvalidated = false;
  @state() private collection: CollectionStatus | null = null;
  @state() private attempts: CollectionAttempt[] = [];
  @state() private statusError = '';
  private onAccessChanged = () => {
    ++this.generation; this.result = null; this.chartKeys = new Set(); this.bucketKeys = new Set(); this.baselineKey = ''; this.busy = false;
    this.collection = null; this.attempts = []; this.statusError = '';
    this.accessInvalidated = true; this.error = '权限或登录状态已变更，请重新打开资源后读取指标';
  };
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.onAccessChanged);
    window.addEventListener('slide-session-expired', this.onAccessChanged);
  }
  private resetResult() {
    this.result = null; this.chartKeys = new Set(); this.bucketKeys = new Set(); this.baselineKey = '';
    this.collection = null; this.attempts = []; this.statusError = '';
  }
  override willUpdate(changes: Map<string, unknown>) {
    if (['resourceId', 'resourceType', 'from', 'to'].some(k => changes.has(k))) {
      this.resetResult();
      if (changes.has('resourceId') || changes.has('resourceType')) {
        this.accessInvalidated = false;
        if ((changes.get('resourceId') !== undefined || changes.get('resourceType') !== undefined) && !changes.has('from') && !changes.has('to')) {
          this.from = ''; this.to = ''; this.range = null; this.custom = false; this.customFrom = ''; this.customTo = ''; this.hours = 1;
        }
        const p = new URL(location.href).searchParams;
        if (p.get('metricResource') === `${this.resourceType}:${this.resourceId}`) {
          this.selectedMetric = p.get('metric') ?? '';
          const from = p.get('metricFrom'), to = p.get('metricTo');
          if (from && to && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to))) { this.from = from; this.to = to; }
        } else this.selectedMetric = '';
      }
      if (this.from && this.to) {
        this.custom = true; this.range = null;
        this.customFrom = localInput(this.from); this.customTo = localInput(this.to);
      }
      void this.load();
    }
  }
  override disconnectedCallback() {
    this.generation++;
    window.removeEventListener('slide-permissions-loaded', this.onAccessChanged);
    window.removeEventListener('slide-session-expired', this.onAccessChanged);
    super.disconnectedCallback();
  }
  override updated() {
    // Native selects can reset while Lit removes/reinserts async options. Apply
    // the state after the children commit, even when the selected ID is unchanged.
    const select = this.renderRoot.querySelector<HTMLSelectElement>('select[aria-label="指标"]');
    if (select && select.value !== this.selectedMetric) select.value = this.selectedMetric;
  }
  async load() {
    if (this.accessInvalidated || !this.resourceId) return;
    if (this.custom && !this.range && !(this.from && this.to)) { this.error = '请选择并应用自定义时间范围'; return; }
    const generation = ++this.generation, resourceId = this.resourceId, resourceType = this.resourceType;
    const current = () => generation === this.generation && resourceId === this.resourceId && resourceType === this.resourceType;
    this.busy = true; this.error = ''; this.baselineKey = ''; this.statusError = '';
    try {
      const now = Date.now();
      let from: string, to: string;
      if (this.range) ({ from, to } = this.range);
      else if (this.from && this.to) { from = this.from; to = this.to; }
      else { to = new Date(now).toISOString(); from = new Date(now - this.hours * 3600000).toISOString(); }
      const query = { resource: { type: this.resourceType, id: this.resourceId }, view: 'all', from, to, bucket_ms: bucketMsFor(Date.parse(from), Date.parse(to)) };
      const response = await authFetch('/api/metrics/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query) });
      if (!current()) return;
      if (!response.ok) { if ([401, 403, 404].includes(response.status)) this.result = null; throw new Error(errors(response.status)); }
      const result = await response.json();
      if (current()) this.result = result;
    } catch (e) { if (current()) this.error = e instanceof Error ? e.message : errors(503); }
    finally { if (current()) this.busy = false; }
    if (current()) await this.loadCollection(generation, current);
  }
  /** The status strip is read separately: neither recommendations nor collector health may hide history. */
  private async loadCollection(generation: number, current: () => boolean) {
    try {
      const [collection, attempts] = await Promise.all([
        readCollectionSummary(this.resourceType, this.resourceId),
        readCollectionAttempts(this.resourceType, this.resourceId),
      ]);
      if (!current()) return;
      this.collection = collection; this.attempts = attempts; this.statusError = '';
    } catch (e) {
      if (!current()) return;
      this.collection = null; this.attempts = [];
      if (e instanceof MetricRequestError && [401, 403, 404].includes(e.status)) { this.resetResult(); this.error = errors(e.status); }
      else this.statusError = '采集状态读取失败；历史查询结果保留，不能据此判断当前采集状态。';
    }
  }
  private applyCustom() {
    this.customError = '';
    if (!this.customFrom || !this.customTo) { this.customError = '请选择开始时间和结束时间'; return; }
    const from = Date.parse(this.customFrom), to = Date.parse(this.customTo);
    if (!Number.isFinite(from) || !Number.isFinite(to)) { this.customError = '时间格式无效，请重新选择'; return; }
    if (from >= to) { this.customError = '开始时间必须早于结束时间'; return; }
    if (to > Date.now()) { this.customError = '结束时间不能晚于当前时间'; return; }
    if (to - from > MAX_WINDOW_MS) { this.customError = '自定义窗口最长 31 天'; return; }
    this.range = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
    this.resetResult(); void this.load();
  }
  private async copyMetric(id: string) {
    try { await navigator.clipboard.writeText(id); showToast('已复制指标标识', 'success'); }
    catch { showToast('复制失败，请展开指标标识手动复制', 'error'); }
  }
  /** A historical bucket is plotted on its own quality; current collection state and age never hide it. */
  private chartValue(metric: MetricResult, b: MetricBucket): number | null {
    const n = bucketNumber(b);
    return n !== null && !unitMismatch(metric, b.unit) && ['good', 'partial'].includes(b.quality.status) ? n : null;
  }
  private bucketSummary(metric: MetricResult, series: MetricResult['series'][number]) {
    let good = 0, partial = 0, gap = 0, unsafe = 0, mismatch = 0, records = 0;
    for (const b of series.buckets) {
      if (unitMismatch(metric, b.unit)) mismatch++;
      else if (b.value && !('value' in b.value)) records++;
      else if (bucketNumber(b) === null) { if (b.value && 'value' in b.value && b.value.value != null) unsafe++; else gap++; }
      else if (b.quality.status === 'good') good++;
      else if (b.quality.status === 'partial') partial++;
      else gap++;
    }
    return { good, partial, gap, unsafe, mismatch, records };
  }
  private renderTrend(metric: MetricResult, series: MetricResult['series'][number]) {
    const data = series.buckets.map(b => this.chartValue(metric, b));
    // The envelope must obey the same drawable condition as the line: a bucket the line
    // refuses (unit mismatch, non-scalar, unsafe precision, unknown/invalid) must not leak
    // its min/max as a dashed range. Drawable in-bucket spikes are still preserved.
    const min = series.buckets.map((b, i) => data[i] === null ? null : safeNumber(b.stats?.min?.value));
    const max = series.buckets.map((b, i) => data[i] === null ? null : safeNumber(b.stats?.max?.value));
    // Keep the bucket envelope so a spike inside a bucket is never flattened to the selected mode.
    const envelope = min.some((v, i) => v !== null && max[i] !== null && v !== max[i]) ? { min, max } : {};
    return html`<metric-chart .title=${metricName(metric.definition.id)} .yAxisLabel=${series.buckets[0]?.unit ?? metric.definition.unit}
      .timeData=${series.buckets.map(b => b.window.to)} .series=${[{ name: metricName(metric.definition.id), data, ...envelope }]}></metric-chart>`;
  }
  private renderBuckets(metric: MetricResult, series: MetricResult['series'][number]) {
    const shown = series.buckets.length > DETAIL_BUCKET_LIMIT ? series.buckets.slice(-DETAIL_BUCKET_LIMIT) : series.buckets;
    return html`${series.buckets.length > shown.length ? html`<p class="hint">仅渲染最近 ${DETAIL_BUCKET_LIMIT} 个时间桶（共 ${series.buckets.length} 个），其余请在曲线或更窄窗口核对。</p>` : nothing}
      ${[...shown].reverse().map(b => html`<div class="bucket-row">
        <div>${localTime(b.window.from)} — ${localTime(b.window.to)}</div>
        <div>${b.value && !('value' in b.value) ? html`<strong>${b.value.encoding} 记录</strong>（非标量，不做折线）<details><summary>记录内容</summary><pre>${JSON.stringify(b.value, null, 2)}</pre></details>`
          : html`<strong>${b.value && 'value' in b.value ? b.value.value : '缺口'}</strong> ${b.unit} · 覆盖率 ${(b.coverage * 100).toFixed(0)}%${b.sample_count !== undefined ? ` · 样本 ${b.sample_count}` : ''}${b.stats ? ` · 最小 ${b.stats.min?.value} / 最大 ${b.stats.max?.value} / 平均 ${b.stats.avg?.value}` : ''}`}</div>
        ${qualityBadges(b)}
        <details><summary>质量与来源</summary><p>质量原因：${b.quality.reason}</p><pre>${JSON.stringify(b.sources, null, 2)}</pre></details>
      </div>`)}`;
  }
  private renderSeries(metric: MetricResult, series: MetricResult['series'][number]) {
    const key = metric.definition.id + JSON.stringify(series.dimensions);
    const last = series.buckets.at(-1), summary = this.bucketSummary(metric, series);
    const mismatch = unitMismatch(metric, last?.unit);
    const notes = [summary.gap ? `断点 ${summary.gap}` : '', summary.unsafe ? `超出安全数值精度 ${summary.unsafe}` : '', summary.mismatch ? `单位不符 ${summary.mismatch}` : '', summary.records ? `非标量记录 ${summary.records}` : ''].filter(Boolean);
    return html`<div>
      ${Object.entries(series.dimensions).map(([k, v]) => `${k}=${v}`).join(' / ')}
      ${last ? html`<div>${last.value && !('value' in last.value) ? html`<strong>${last.value.encoding} 记录</strong>（非标量，不做折线）<details><summary>记录内容</summary><pre>${JSON.stringify(last.value, null, 2)}</pre></details>`
        : html`<strong>${last.value && 'value' in last.value ? last.value.value : '未知'}</strong> ${last.unit} · 最近时间桶 · 覆盖率 ${(last.coverage * 100).toFixed(0)}%`}</div>
        ${observedTime(last)}${qualityBadges(last)}
        ${mismatch ? html`<p class="error" role="alert">单位不符：该时间桶单位 ${last.unit} 与指标定义 ${metric.definition.unit} 不一致，不参与数值与曲线。</p>` : nothing}` : html`<p>暂无可用观测</p>`}
      <p class="hint">时间桶 ${series.buckets.length} 个：良好 ${summary.good}${summary.partial ? ` · 部分覆盖 ${summary.partial}` : ''}${notes.length ? ` · ${notes.join(' · ')}` : ''}。缺失、质量未知或无效、单位不符及超出安全精度的桶保留断点，不补 0；过期但当时 good/partial 的值照常显示。${summary.partial ? '部分覆盖不代表当前健康。' : ''}</p>
      <details @toggle=${(e: Event) => {
        const next = new Set(this.bucketKeys); (e.target as HTMLDetailsElement).open ? next.add(key) : next.delete(key); this.bucketKeys = next;
      }}><summary>时间桶明细（聚合值，不是原始采样）</summary>${this.bucketKeys.has(key) ? this.renderBuckets(metric, series) : nothing}</details>
      <details @toggle=${(e: Event) => {
        const next = new Set(this.chartKeys); (e.target as HTMLDetailsElement).open ? next.add(key) : next.delete(key); this.chartKeys = next;
      }}><summary>此维度趋势</summary>${this.chartKeys.has(key) ? this.renderTrend(metric, series) : nothing}</details>
    </div>`;
  }
  private windowNote() {
    const w = this.result?.window;
    if (!w) return '';
    const from = Date.parse(w.from), to = Date.parse(w.to), bucket = bucketMsFor(from, to), count = Math.ceil((to - from) / bucket);
    const coarse = bucket > MIN_BUCKET_MS ? `。窗口超过 ${MAX_BUCKETS} 个时间桶，已按较粗粒度聚合，未静默截断` : '';
    return `时间桶：每桶 ${bucketLabel(bucket)}，共 ${count} 个（数值与曲线同窗口）· 本地时区 ${timezone()}${coarse}`;
  }
  /** Newest-to-oldest first bucket that the curve could draw; nothing else may become this value. */
  private windowLatest(metric: MetricResult) {
    let best: { series: MetricResult['series'][number]; bucket: MetricBucket; index: number; at: number } | null = null;
    for (const series of metric.series) {
      for (let index = series.buckets.length - 1; index >= 0; index--) {
        const bucket = series.buckets[index];
        if (this.chartValue(metric, bucket) === null) continue;
        const at = Date.parse(bucket.observed_at ?? bucket.window.to);
        if (!best || (Number.isFinite(at) && at > best.at)) best = { series, bucket, index, at: Number.isFinite(at) ? at : -Infinity };
        break;
      }
    }
    return best;
  }
  private renderCollectionState(collection: CollectionStatus) {
    const state = collection.collection;
    return html`<div class="latest-cell"><h3>当前采集状态</h3>
      <p><strong>${collectionStatusLabels[state.state] ?? state.state}</strong> · ${state.in_flight ? '有采集正在进行' : '当前无进行中的采集'}</p>
      ${collection.blockers.length ? html`<p>阻塞：${collection.blockers.map(b => collectionStatusLabels[b] ?? b).join('、')}</p>` : html`<p class="hint">无阻塞项</p>`}
      <p class="hint">这是资源采集状态，不是某个时间桶的质量。</p>
    </div>`;
  }
  private renderLastAttempt() {
    const attempt = this.attempts[0];
    return html`<div class="latest-cell"><h3>最近一次采集尝试</h3>
      ${attempt ? html`<p><strong>${attemptLabels[attempt.status] ?? attempt.status}</strong>${['partial', 'failed'].includes(attempt.status) ? ' · 不是成功' : ''}</p>
        <p>开始：${localTime(attempt.started_at)}${attempt.ended_at ? ` · 结束：${localTime(attempt.ended_at)}` : ''}</p>
        <p>错误：${attempt.error ?? (attempt.status === 'succeeded' ? '无' : '未提供')}${attempt.evidence_code ? ` · ${attempt.evidence_code}` : ''}</p>`
        : html`<p>暂无采集尝试</p>`}
    </div>`;
  }
  private renderSuccessTimes(collection: CollectionStatus) {
    const last = collection.collection.last_success_at, observed = collection.formal_visibility.last_observed_at;
    const differ = Boolean(last && observed && Date.parse(last) !== Date.parse(observed));
    return html`<div class="latest-cell"><h3>正式采集成功时间</h3>
      <div>最近成功采集：${last ? html`<time datetime=${last}>${localTime(last)}</time>` : '暂无'}</div>
      <div>正式来源最近观测：${observed ? html`<time datetime=${observed}>${localTime(observed)}</time>` : '暂无'}</div>
      ${differ ? html`<p class="hint">两者不同，分别列示，不合并为同一个时间。</p>` : nothing}
    </div>`;
  }
  private renderWindowLatest(metrics: MetricResult[]) {
    return html`<div class="latest-cell"><h3>窗口内最近可用值</h3>${metrics.length ? metrics.map(metric => {
      const found = this.windowLatest(metric);
      if (!found) return html`<p>${metricName(metric.definition.id)}：暂无可用值</p>`;
      const { series, bucket, index } = found, dimensions = Object.entries(series.dimensions).map(([k, v]) => `${k}=${v}`).join(' / ');
      // Never present a historical value as current health: it is old when the metric, its
      // freshness or its position in the window says so.
      const old = metric.state !== 'available' || bucket.freshness !== 'fresh' || index !== series.buckets.length - 1;
      const { collectors, packages } = sourceSummary(bucket);
      return html`<div class="latest-value">
        <div>${metricName(metric.definition.id)}${dimensions ? ` · ${dimensions}` : ''}</div>
        <div class=${old ? 'old-value' : ''}><strong>${bucketNumber(bucket)}</strong> ${bucket.unit} · 窗口内最近可用值</div>
        <div class=${old ? 'old-value' : ''}>质量 ${qualityLabels[bucket.quality.status] ?? bucket.quality.status} · ${qualityLabels[bucket.accuracy] ?? bucket.accuracy} · ${qualityLabels[bucket.freshness] ?? bucket.freshness}</div>
        ${observedTime(bucket)}
        ${collectors.length ? html`<div>采集器 ${collectors.join('、')}</div>` : nothing}
        ${packages.length ? html`<div>模板 ${packages.join('、')}</div>` : nothing}
        ${old ? html`<p class="hint">旧值，不代表当前健康。</p>` : nothing}
      </div>`;
    }) : html`<p>暂无指标</p>`}</div>`;
  }
  private renderLatest(metrics: MetricResult[]) {
    if (!this.collection) return this.statusError ? html`<p class="error" role="alert">${this.statusError}</p>` : nothing;
    return html`<h2>最新数据</h2>
      <div class="latest-grid" aria-label="最新数据">
        ${this.renderCollectionState(this.collection)}${this.renderLastAttempt()}${this.renderSuccessTimes(this.collection)}${this.renderWindowLatest(metrics)}
      </div>`;
  }
  override render() {
    const metrics = this.result?.metrics.filter(m => !this.selectedMetric || m.definition.id === this.selectedMetric) ?? [];
    const baselineSeries = metrics.flatMap(metric => metric.series.map(series => ({metric,series})));
    const baseline = baselineSeries[Number(this.baselineKey)];
    const trends = baselineSeries.filter(({series}) => series.buckets.filter(b => Number.isFinite(Date.parse(b.window.to))).length > 1);
    return html`<style>${sharedFieldStyles}${sharedBtnStyles}
      :host { display:block; min-width:0; color:var(--text); font-size:14px; }
      .actions { display:flex; flex-wrap:wrap; align-items:end; gap:var(--space-sm); margin-block:var(--space-md); }
      .actions label { display:grid; gap:var(--space-xs); min-width:0; max-width:100%; font-size:12px; color:var(--muted); }
      select,input[type="datetime-local"] { width:100%; max-width:360px; min-width:0; box-sizing:border-box; padding:var(--space-sm); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text); background:var(--bg); font-size:14px; }
      .window { flex-basis:100%; margin:0; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
      .hint { margin:0; color:var(--muted); font-size:12px; }
      .error { color:var(--danger); } .skeleton { min-height:4rem; background:var(--border); }
      p,strong,pre { overflow-wrap:anywhere; } pre { white-space:pre-wrap; }
      .quality-badges { display:flex; flex-wrap:wrap; gap:var(--space-xs); }
      app-data-table { display:block; max-width:100%; overflow-x:auto; }
      .summary-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:var(--space-md); border-bottom:1px solid var(--border); padding-block:var(--space-md); }
      .latest-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:var(--space-md); border-bottom:1px solid var(--border); padding-block:var(--space-md); }
      .latest-cell { min-width:0; overflow-wrap:anywhere; } .latest-cell h3 { margin:0 0 var(--space-sm); font-size:13px; color:var(--muted); }
      .latest-cell p { margin:0 0 var(--space-xs); } .latest-value { margin-block:var(--space-sm); }
      .old-value { color:var(--muted); }
      .metric-name { margin:0 0 var(--space-sm); font-size:14px; color:var(--text-strong); }
      .metric-id { color:var(--muted); font-size:12px; user-select:text; }
      .current strong { font-size:24px; color:var(--text-strong); }
      .current { font-size:12px; min-width:0; overflow-wrap:anywhere; }
      .current time { display:block; color:var(--muted); margin-block:var(--space-xs); }
      .trend-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-md); margin-block:var(--space-lg); }
      .trend-grid app-card { min-width:0; }
      metric-chart { display:block; min-width:0; }
      .bucket-row { border-top:1px solid var(--border); padding-block:var(--space-xs); }
      details { margin-block:var(--space-sm); } summary { cursor:pointer; color:var(--text); }
      h2 { font-size:16px; margin-block:var(--space-lg) var(--space-sm); }
      @media(max-width:700px) { .trend-grid { grid-template-columns:minmax(0,1fr); } .summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .actions label { flex:1 1 120px; } select,input[type="datetime-local"] { max-width:100%; } }
    </style>
    <div class="actions">
      <label>时间范围 <select aria-label="时间范围" ?disabled=${this.accessInvalidated} .value=${this.custom ? 'custom' : String(this.hours)} @change=${(e: Event) => {
        const value = (e.target as HTMLSelectElement).value;
        if (value === 'custom') { this.custom = true; this.customError = ''; return; }
        const hadProps = Boolean(this.from || this.to);
        this.range = null; this.custom = false; this.customFrom = ''; this.customTo = ''; this.customError = '';
        this.hours = Number(value);
        this.from = ''; this.to = '';
        // Clearing route-provided endpoints already schedules a reload through willUpdate.
        if (!hadProps) { this.resetResult(); void this.load(); }
      }}><option value="1">最近 1 小时</option><option value="6">最近 6 小时</option><option value="24">最近 24 小时</option><option value="168">最近 7 天</option><option value="custom">自定义…</option></select></label>
      ${this.custom ? html`<label>开始时间（本地时区 ${timezone()}）<input type="datetime-local" aria-label="自定义开始时间" .value=${this.customFrom} @input=${(e: Event) => this.customFrom = (e.target as HTMLInputElement).value}></label>
        <label>结束时间<input type="datetime-local" aria-label="自定义结束时间" .value=${this.customTo} @input=${(e: Event) => this.customTo = (e.target as HTMLInputElement).value}></label>
        <button class="btn" @click=${this.applyCustom} ?disabled=${this.accessInvalidated}>应用自定义窗口</button>` : nothing}
      <label>指标 <select aria-label="指标" ?disabled=${this.accessInvalidated} @change=${(e: Event) => { this.selectedMetric = (e.target as HTMLSelectElement).value; this.baselineKey = ''; }}><option value="" .selected=${!this.selectedMetric}>全部指标</option>${this.selectedMetric && !this.result?.metrics.some(m => m.definition.id === this.selectedMetric) ? html`<option value=${this.selectedMetric} .selected=${true}>${metricName(this.selectedMetric)} · ${this.selectedMetric}</option>` : nothing}${this.result?.metrics.map(m => html`<option value=${m.definition.id} .selected=${m.definition.id === this.selectedMetric}>${metricName(m.definition.id)} · ${m.definition.id}</option>`)}</select></label>
      <button aria-busy=${String(this.busy)} class="btn btn-refresh" .disabled=${this.busy || this.accessInvalidated} @click=${this.load}>刷新标准指标</button>
      ${this.customError ? html`<p class="error" role="alert">${this.customError}</p>` : nothing}
      ${this.result ? html`<p class="window">查询窗口：${localTime(this.result.window.from)} — ${localTime(this.result.window.to)} · ${this.windowNote()}</p>` : nothing}
    </div>
    ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
    ${this.busy && !this.result ? html`<div class="skeleton" aria-label="正在读取指标"></div>` : nothing}
    ${this.result ? this.renderLatest(metrics) : nothing}
    ${this.result && this.selectedMetric && !metrics.length ? html`<p role="status">当前窗口未返回所选指标；可刷新或选择全部指标。</p>` : nothing}
    ${metrics.length ? html`<div class="summary-grid" aria-label="当前指标比较">${metrics.map(m => html`<div class="current"><h3 class="metric-name">${metricName(m.definition.id)}</h3>
      <details class="metric-id"><summary>指标标识</summary><code>${m.definition.id}</code><button class="btn btn-sm btn-ghost" aria-label=${`复制 ${m.definition.id}`} @click=${() => void this.copyMetric(m.definition.id)}>复制标识</button></details>
      <span>当前采集状态：${states[m.state] ?? m.state}</span>
      ${m.state !== 'available' ? html`<p class="hint">当前状态不代表历史：以下时间桶按各自窗口显示当时质量，旧值不代表当前健康。</p>` : nothing}
      ${!m.series.length ? html`<p>暂无可用观测</p>` : m.series.map(series => {
        const b = series.buckets.at(-1);
        return html`<div>${Object.values(series.dimensions).join(' / ')}${b ? html`<div><strong>${b.value && 'value' in b.value ? b.value.value : '未知'}</strong> ${b.unit}</div>
          ${observedTime(b)}${qualityBadges(b)}` : html`<div>暂无可用观测</div>`}</div>`;
      })}</div>`)}</div>` : nothing}
    ${trends.length ? html`<div class="trend-grid" aria-label="指标趋势比较">${trends.slice(0,2).map(({metric,series}) => html`<app-card><span slot="header">${metricName(metric.definition.id)} · ${Object.values(series.dimensions).join(' / ') || '整体'}</span>${this.renderTrend(metric,series)}</app-card>`)}</div>
      <p class="window">断点只用于缺失、质量未知或无效、单位不符、非标量及超出安全数值精度的桶；过期但当时 good/partial 的值照常显示。桶内峰值以最小/最大包络显示，包络与曲线使用同一可绘制条件。部分覆盖的点保留在曲线上，但不代表当前健康。全部维度与精确值可在观测明细中核对。</p>` : nothing}
    <details><summary>行为基线与资格</summary>
      <label>基线指标与维度<select aria-label="基线指标与维度" .value=${this.baselineKey} ?disabled=${this.accessInvalidated || this.busy} @change=${(e:Event)=>this.baselineKey=(e.target as HTMLSelectElement).value}><option value="">选择指标与维度</option>${baselineSeries.map(({metric,series},index)=>html`<option value=${index}>${metricName(metric.definition.id)} · ${Object.values(series.dimensions).join(' / ') || '整体'}</option>`)}</select></label>
      ${this.baselineKey !== '' && baseline ? html`<operations-behavior-baseline .resourceType=${this.resourceType} .resourceId=${this.resourceId} .metric=${baseline.metric.definition.id} .dimensions=${baseline.series.dimensions}></operations-behavior-baseline>` : html`<p>选择实际可见指标的一个维度后，可评估其行为基线。样本不足时偏离保持未知。</p>`}
    </details>
    <h2>观测明细</h2>
    ${['canonical', 'extension'].map(category => html`<app-card><span slot="header">${category === 'canonical' ? '标准指标与能力' : '模板扩展指标'}</span>
      ${metrics.filter(m => m.definition.category === category).length ? html`<details><summary>查看时间桶、定义与来源（${metrics.filter(m => m.definition.category === category).length} 项）</summary>
        <app-data-table .dense=${true} .columns=${[{key:'metric',label:'指标与口径'},{key:'value',label:'观测与质量'}]}
        .rows=${metrics.filter(m => m.definition.category === category).map(m => ({metric:html`<strong>${metricName(m.definition.id)}</strong><details><summary>指标定义</summary><p>${m.definition.id}</p><p>${m.definition.meaning}</p></details>`,value:m.series.length ? html`${m.series.map(series => this.renderSeries(m, series))}` : html`<span>${states[m.state] ?? m.state} · 暂无可用观测</span>`}))}></app-data-table>
      </details>` : html`<app-empty-state title="暂无指标证据" description="未配置或无法读取不代表无异常。"></app-empty-state>`}
    </app-card>`)}`;
  }
}
// Separate from templates: the product's core columns are returned even for an unconfigured resource.
@customElement('semantic-core-list')
export class SemanticCoreList extends LitElement {
  @property() resourceType = 'instance';
  @property({ attribute: false }) resources: Array<{ id: number; name?: string; label?: string; host?: string }> = [];
  @state() private rows: Record<string, unknown>[] = [];
  private get columns() { return [{ key: 'resource', label: '资源' }, ...({
    instance: [{ key: 'db.uptime_seconds', label: '数据库运行时长' }],
    server: [{ key: 'host.filesystem.used_bytes', label: '文件系统已用' }, { key: 'host.filesystem.size_bytes', label: '文件系统容量' }, { key: 'host.network.bytes_total', label: '接口字节速率' }],
    network_device: [{ key: 'network.interface.oper_up', label: '接口运行状态' }],
  }[this.resourceType] ?? []), { key: 'error', label: '查询状态' }]; }
  private generation = 0;
  private onAccessChanged = () => { ++this.generation; this.rows = []; };
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.onAccessChanged);
    window.addEventListener('slide-session-expired', this.onAccessChanged);
  }
  override willUpdate(changes: Map<string, unknown>) { if (changes.has('resources') || changes.has('resourceType')) void this.load(); }
  override disconnectedCallback() {
    this.generation++;
    window.removeEventListener('slide-permissions-loaded', this.onAccessChanged);
    window.removeEventListener('slide-session-expired', this.onAccessChanged);
    super.disconnectedCallback();
  }
  private async load() {
    this.rows = [];
    const generation = ++this.generation, to = new Date().toISOString();
    const rows: Record<string, unknown>[] = [];
    // Bound concurrent requests and keep every row, including failed resources.
    for (const resource of this.resources) {
      if (generation !== this.generation) return;
      const row: Record<string, unknown> = { resource: resource.name || resource.label || resource.host || String(resource.id) };
      try {
        const response = await authFetch('/api/metrics/query', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resource: { type: this.resourceType, id: resource.id }, view: 'core', from: new Date(Date.parse(to) - 60000).toISOString(), to }) });
        if (!response.ok) throw new Error(errors(response.status));
        const data: SemanticResult = await response.json();
        if (generation !== this.generation) return;

        for (const m of data.metrics) row[m.definition.id] = renderMetricValue(m);
      } catch (e) { row.error = e instanceof Error ? e.message : errors(503); }
      rows.push(row);
    }
    if (generation === this.generation) this.rows = rows;
  }
  override render() { return html`<app-card><span slot="header">核心指标（固定产品口径）</span>
    <app-data-table .columns=${this.columns.length ? this.columns : [{ key: 'resource', label: '资源' }, { key: 'error', label: '查询状态' }]} .rows=${this.rows}></app-data-table></app-card>`; }
}
