import { investigationEntryHref, type InvestigationEntryContext } from '../controllers/investigation-entry.ts';
import { inferBasePathFromPathname } from '../navigation.ts';
import type { MetricHistoryContext as HistoryContext } from '../../../api/generated/public-api.js';
import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import './app-card.js';
import './app-data-table.js';
import './app-empty-state.js';
import './app-badge.js';
import './metric-chart.js';
import './metric-study.js';
import './template-event-evidence.js';
import './investigation-operation-context.ts';
import { metricDisplayName as metricName } from './metric-display.js';
import { MetricRequestError, collectionStatusLabels, isMetricAccessError, metricReadError, metricRequest, readCollectionAttempts, readCollectionSummary, type CollectionAttempt, type CollectionStatus } from './metric-api.js';
import { metricDimensionText, metricPurpose, metricValueText, renderMetricEvidence, renderMetricReading } from './metric-value-display.js';
export type MetricValue = { encoding: string; value?: number | string; [key: string]: unknown };
export interface MetricBucket {
  value: MetricValue | null; unit: string; coverage: number;
  quality: { status: string; reason: string }; freshness: string; observed_at?: string | null; accuracy: string;
  sources: unknown[]; window: { from: string; to: string }; sample_count?: number;
  stats?: { count: number; min: MetricValue; max: MetricValue; avg: MetricValue } | null;
  retained_sample_count?: number;
}
export interface MetricResult {
  definition: { id: string; semantic_version?: string; category: string; meaning: string; unit: string; kind?: string; aggregation?: { time?: string[]; space?: string[] } };
  state: string; capability: unknown;
  observed_at?: string;
  series: Array<{ dimensions: Record<string, string>; buckets: MetricBucket[] }>;
}
/** Formal raw observation page: one snapshot per request, keyset cursor for the next page. */
interface RawObservation {
  id: string; observed_at: string; value: MetricValue | null; unit: string;
  quality: { status: string; reason: string }; accuracy: string; sources: unknown[];
}
interface RawObservationPage {
  contract_version: string; total: number; has_more: boolean; next_cursor?: string; observations: RawObservation[];
}
type HistoryExpression = HistoryContext['snapshots'][number]['rules'][number]['problem'];
const expressionText = (n: HistoryExpression): string => n.node === 'compare'
  ? `${n.select.aggregation}${'window_ms' in n.select ? `(${n.select.window_ms / 1000}秒)` : ''} ${n.operator} ${n.threshold.value}`
  : `(${n.children.map(expressionText).join(n.node === 'all' ? ' 且 ' : ' 或 ')})`;
export interface SemanticResult { history_context?: HistoryContext; profile: { columns: Array<{ key: string; label?: string; metric: { id: string } }> }; window: { from: string; to: string }; metrics: MetricResult[] }
const states: Record<string, string> = { query_operation_unavailable: '当前定义不允许速率聚合', available: '可用', not_configured: '当前模板未覆盖', not_covered: '当前模板未覆盖', disabled: '已停用', unsupported: '能力不支持', permission_denied: '采集权限不足', temporary_failure: '采集暂时失败', capability_unknown: '能力待确认' };
const qualityLabels: Record<string, string> = { good: '良好', partial: '部分', unknown: '未知', invalid: '无效', fresh: '新鲜', stale: '过期', exact: '精确', estimated: '估算' };
const attemptLabels: Record<string, string> = { running: '进行中', succeeded: '成功', partial: '部分完成', failed: '失败', cancelled: '已取消' };
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
      ${b ? html`<div>${renderMetricReading(b.value, b.unit, m.definition.id, '未知')} · 最近时间桶</div>
        ${observedTime(b)}${qualityBadges(b)}
        <span>覆盖率 ${(b.coverage * 100).toFixed(0)}%</span><details><summary>窗口、质量与来源</summary><p>采集窗口 ${localTime(b.window.from)} — ${localTime(b.window.to)}</p><p>质量原因：${b.quality.reason}</p><pre>${JSON.stringify(b.sources, null, 2)}</pre></details>` : html`<span> · 暂无可用观测</span>`}
    </div>`;
  })}`;
}
type QueryWindow = SemanticResult['window'];
type MaintenanceInterval = { id: string; revision: number; name: string; reason: string; timezone: string; effective_from: string; effective_to: string };
type MaintenanceHistory = {
  resource: { type: string; id: number }; from: string; to: string;
  intervals: MaintenanceInterval[];
  event_links: Array<{ event_id?: string; alert_id?: number; state: string; at: string; intervals?: Array<{ id: string; revision: number; reason: string }> }>;
};
const seriesKey = (metric: MetricResult, series: MetricResult['series'][number]) =>
  JSON.stringify([metric.definition.id, metric.definition.semantic_version, Object.entries(series.dimensions).sort()]);
const seriesGroup = (metric: MetricResult, series: MetricResult['series'][number]) =>
  JSON.stringify([metric.definition.id, Object.entries(series.dimensions).sort()]);
const sameWindow = (a: QueryWindow | null, b: QueryWindow) => a?.from === b.from && a.to === b.to;
const retainedNote = (at: string) => at ? ` 保留同窗口 ${localTime(at)} 读取的结果；不能据此判断健康。` : '';
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
  @state() private historyEvent = 0;
  @state() result: SemanticResult | null = null;
  @state() error = '';
  @state() busy = false;
  @state() private maintenance: MaintenanceHistory | null = null;
  @state() private maintenanceBusy = false;
  @state() private activeWindow: QueryWindow | null = null;
  @state() private actionKey = '';
  @state() private trendKey = '';
  private resultAt = '';
  private maintenanceAt = '';
  private queryRequest?: AbortController;
  private maintenanceRequest?: AbortController;
  @state() private maintenanceError = '';
  private generation = 0;
  @state() private accessInvalidated = false;
  @state() private collection: CollectionStatus | null = null;
  @state() private attempts: CollectionAttempt[] = [];
  @state() private statusError = '';
  @state() private rawOpen = false;
  @state() private rawKey = '';
  @state() private raw: RawObservationPage | null = null;
  @state() private rawError = '';
  @state() private rawBusy = false;
  private rawRequest?: AbortController;
  private onAccessChanged = () => {
    ++this.generation;
    this.resetResult();
    this.rawOpen = false; this.rawKey = ''; this.busy = false;
    this.accessInvalidated = true; this.error = '权限或登录状态已变更，请重新打开资源后读取指标';
  };
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.onAccessChanged);
    window.addEventListener('slide-session-expired', this.onAccessChanged);
  }
  private resetResult() {
    this.queryRequest?.abort(); this.maintenanceRequest?.abort();
    this.busy = false; this.maintenanceBusy = false;
    this.resultAt = ''; this.maintenanceAt = '';
    this.maintenance = null; this.maintenanceError = '';
    this.activeWindow = null; this.trendKey = '';
    this.result = null; this.chartKeys = new Set(); this.bucketKeys = new Set(); this.baselineKey = '';
    this.collection = null; this.attempts = []; this.statusError = '';
    this.resetRaw();
  }
  override willUpdate(changes: Map<string, unknown>) {
    if (['resourceId', 'resourceType', 'from', 'to'].some(k => changes.has(k))) {
      this.resetResult();
      if (changes.has('resourceId') || changes.has('resourceType')) {
        this.accessInvalidated = false;
        this.rawOpen = false; this.rawKey = ''; this.actionKey = '';
        if ((changes.get('resourceId') !== undefined || changes.get('resourceType') !== undefined) && !changes.has('from') && !changes.has('to')) {
          this.from = ''; this.to = ''; this.range = null; this.custom = false; this.customFrom = ''; this.customTo = ''; this.hours = 1;
        }
        const p = new URL(location.href).searchParams;
        if (p.get('metricResource') === `${this.resourceType}:${this.resourceId}`) {
          this.selectedMetric = p.get('metric') ?? '';
          const from = p.get('metricFrom'), to = p.get('metricTo');
          if (!(this.from && this.to) && from && to && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to))) {
            this.from = from; this.to = to;
          }
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
    this.queryRequest?.abort(); this.maintenanceRequest?.abort();
    this.rawOpen = false;
    this.resetRaw();
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
    if (this.custom && !this.range && !(this.from && this.to)) { this.customError = '请选择并应用自定义时间范围'; return; }
    const now = Date.now();
    const window = this.range ?? (this.from && this.to ? { from: this.from, to: this.to }
      : { from: new Date(now - this.hours * 3600000).toISOString(), to: new Date(now).toISOString() });
    if (!sameWindow(this.activeWindow, window)) this.resetResult();
    this.activeWindow = window;
    this.statusError = '';
    const generation = ++this.generation, resourceId = this.resourceId, resourceType = this.resourceType;
    const current = () => generation === this.generation && resourceId === this.resourceId && resourceType === this.resourceType;
    const scopeUrl = new URL(location.href);
    scopeUrl.searchParams.set('metricResource', `${resourceType}:${resourceId}`);
    scopeUrl.searchParams.set('metricFrom', window.from);
    scopeUrl.searchParams.set('metricTo', window.to);
    history.replaceState(history.state, '', scopeUrl);
    globalThis.window.dispatchEvent(new CustomEvent('slide-resource-window', { detail: { type: resourceType, id: resourceId, window } }));
    await Promise.all([this.loadQuery(window), this.loadMaintenance(window), this.loadCollection(current)]);
  }
  private async loadQuery(window: QueryWindow) {
    this.queryRequest?.abort();
    const request = this.queryRequest = new AbortController();
    const generation = this.generation, resourceId = this.resourceId, resourceType = this.resourceType;
    const current = () => !request.signal.aborted && generation === this.generation
      && resourceId === this.resourceId && resourceType === this.resourceType;
    this.busy = true;
    this.error = '';
    try {
      const result = await metricRequest<SemanticResult>('query', {
        resource: { type: resourceType, id: resourceId }, view: 'all', history: true, ...window,
        bucket_ms: bucketMsFor(Date.parse(window.from), Date.parse(window.to)),
      }, request.signal);
      if (!current()) return;
      const previousWindow = this.result?.window ?? null;
      const previousRawKey = this.rawChoice()?.key;
      this.result = result;
      this.resultAt = new Date().toISOString();
      if (!sameWindow(previousWindow, result.window) || previousRawKey !== this.rawChoice()?.key) {
        this.resetRaw();
        if (this.rawOpen) void this.loadRaw();
      }
    } catch (error) {
      if (!current()) return;
      if (isMetricAccessError(error)) { this.onAccessChanged(); this.error = metricReadError(error, '指标查询'); }
      else this.error = metricReadError(error, '指标查询') + retainedNote(this.resultAt);
    } finally {
      if (current()) this.busy = false;
    }
  }
  private async loadMaintenance(window: QueryWindow) {
    this.maintenanceRequest?.abort();
    const request = this.maintenanceRequest = new AbortController();
    const generation = this.generation, resourceId = this.resourceId, resourceType = this.resourceType;
    const current = () => !request.signal.aborted && generation === this.generation
      && resourceId === this.resourceId && resourceType === this.resourceType;
    const { from, to } = window;
    this.maintenanceBusy = true;
    this.maintenanceError = '';
    try {
      const response = await authFetch(`/api/maintenance-windows/intervals/${resourceType}/${resourceId}?${new URLSearchParams({ from, to })}`, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(35000)]),
      });
      if (!current()) return;
      if (!response.ok) throw new MetricRequestError(response.status);
      const history: MaintenanceHistory = await response.json();
      if (!current()) return;
      if (history.resource?.type !== resourceType || Number(history.resource?.id) !== resourceId || !sameWindow(history, window)
        || !Array.isArray(history.intervals) || !Array.isArray(history.event_links)) throw new Error('MAINTENANCE_SCOPE');
      const intervals = history.intervals.flatMap(interval => {
        const start = Math.max(Date.parse(from), Date.parse(interval.effective_from));
        const end = Math.min(Date.parse(to), Date.parse(interval.effective_to));
        return Number.isFinite(start) && Number.isFinite(end) && start < end
          ? [{ ...interval, effective_from: new Date(start).toISOString(), effective_to: new Date(end).toISOString() }] : [];
      });
      this.maintenance = { ...history, intervals };
      this.maintenanceAt = new Date().toISOString();
    } catch (error) {
      if (!current()) return;
      if (isMetricAccessError(error)) { this.onAccessChanged(); this.error = metricReadError(error, '维护历史'); }
      else this.maintenanceError = metricReadError(error, '维护历史')
        + (this.maintenanceAt ? ` 保留同窗口 ${localTime(this.maintenanceAt)} 读取的结果。` : ' 当前维护状态未知。');
    } finally {
      if (current()) this.maintenanceBusy = false;
    }
  }
  /** The status strip is read separately: neither recommendations nor collector health may hide history. */
  private async loadCollection(current: () => boolean) {
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
      if (e instanceof MetricRequestError && [401, 403, 404].includes(e.status)) { this.onAccessChanged(); this.error = metricReadError(e, '指标'); }
      else this.statusError = '采集状态读取失败，当前采集状态未知。';
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
    void this.load();
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
  private renderTrend(metric: MetricResult, series: MetricResult['series'][number], explainEmpty = false) {
    const data = series.buckets.map(b => this.chartValue(metric, b));
    if (explainEmpty && !data.some(value => value !== null)) {
      return html`<p role="status">该维度在主图窗口没有可绘制的数值。</p>`;
    }
    // The envelope must obey the same drawable condition as the line: a bucket the line
    // refuses (unit mismatch, non-scalar, unsafe precision, unknown/invalid) must not leak
    // its min/max as a dashed range. Drawable in-bucket spikes are still preserved.
    const min = series.buckets.map((b, i) => data[i] === null ? null : safeNumber(b.stats?.min?.value));
    const max = series.buckets.map((b, i) => data[i] === null ? null : safeNumber(b.stats?.max?.value));
    // Keep the bucket envelope so a spike inside a bucket is never flattened to the selected mode.
    const envelope = min.some((v, i) => v !== null && max[i] !== null && v !== max[i]) ? { min, max } : {};
    const thresholds = (this.result?.history_context?.snapshots ?? []).flatMap(snapshot => snapshot.rules
      .filter(rule => rule.metric.id === metric.definition.id && rule.metric.semantic_version === metric.definition.semantic_version
        && rule.unit === metric.definition.unit && Object.entries(rule.dimensions).every(([k,v]) => series.dimensions[k] === v))
      .flatMap(rule => (['problem', 'recovery'] as const).flatMap(kind => {
        const expression = rule[kind];
        // Only a scalar `last` comparison has a line in the same value space. Composite,
        // nodata and window reducers remain explicit expressions in the evidence section.
        if (expression.node !== 'compare' || expression.select.aggregation !== 'last' || metric.definition.kind === 'counter') return [];
        return [{ name: `${kind === 'problem' ? '问题' : '恢复'}阈值 · ${rule.rule_id} v${rule.version} / 配置${snapshot.config_revision}`,
          data: series.buckets.map(b => b.sources.some(source => (source as { versions?: { config_revision?: number } }).versions?.config_revision === snapshot.config_revision)
            ? expression.threshold.value : null) }];
      })));
    const context = this.result?.history_context;
    const regions = (context?.events ?? []).filter(event => context?.snapshots.some(snapshot => snapshot.config_revision === event.config_revision
      && snapshot.rules.some(rule => rule.rule_id === event.rule_id && rule.metric.id === metric.definition.id
        && rule.metric.semantic_version === metric.definition.semantic_version
        && Object.entries(rule.dimensions).every(([k,v]) => series.dimensions[k] === v))))
      .flatMap(event => [{ name: `问题 · 事件${event.event_id}`, from: event.from, to: event.to, color: 'var(--danger)' },
        ...event.unknown_segments.map(segment => ({ ...segment, name: `证据未知 · ${segment.reason}`, color: 'var(--muted)' }))])
      .flatMap(region => {
        const from = series.buckets.findIndex(b => Date.parse(b.window.to) > Date.parse(region.from));
        const end = region.to ? Date.parse(region.to) : Infinity;
        let to = series.buckets.length - 1;
        while (to >= 0 && Date.parse(series.buckets[to].window.from) >= end) to--;
        return from >= 0 && to >= from ? [{ name: region.name, from, to, color: region.color }] : [];
      });
    for (const interval of this.maintenance?.intervals ?? []) {
      const from = series.buckets.findIndex(b => Date.parse(b.window.to) > Date.parse(interval.effective_from));
      let to = series.buckets.length - 1;
      while (to >= 0 && Date.parse(series.buckets[to].window.from) >= Date.parse(interval.effective_to)) to--;
      if (from >= 0 && to >= from) regions.push({name:`维护 · ${interval.name} r${interval.revision}`,from,to,color:'var(--accent)'});
    }
    const unit = series.buckets.find((_, i) => data[i] !== null)?.unit ?? metric.definition.unit;
    return html`<metric-chart .title=${metricName(metric.definition.id)} .yAxisLabel=${unit === '1' ? '' : unit}
      .formatValue=${(value: number) => metricValueText(value, unit, metric.definition.id)}
      .regions=${regions} .timeData=${series.buckets.map(b => b.window.to)} .series=${[{ name: metricName(metric.definition.id), data, ...envelope }, ...thresholds]}></metric-chart>`;
  }
  private renderBuckets(metric: MetricResult, series: MetricResult['series'][number]) {
    const shown = series.buckets.length > DETAIL_BUCKET_LIMIT ? series.buckets.slice(-DETAIL_BUCKET_LIMIT) : series.buckets;
    return html`${series.buckets.length > shown.length ? html`<p class="hint">仅渲染最近 ${DETAIL_BUCKET_LIMIT} 个时间桶（共 ${series.buckets.length} 个），其余请在曲线或更窄窗口核对。</p>` : nothing}
      ${[...shown].reverse().map(b => html`<div class="bucket-row">
        <div>${localTime(b.window.from)} — ${localTime(b.window.to)}</div>
        <div>${b.value && !('value' in b.value) ? html`<strong>${b.value.encoding} 记录</strong>（非标量，不做折线）<details><summary>记录内容</summary><pre>${JSON.stringify(b.value, null, 2)}</pre></details>`
          : html`${renderMetricReading(b.value, b.unit, metric.definition.id)} · 覆盖率 ${(b.coverage * 100).toFixed(0)}%${b.sample_count !== undefined ? ` · 样本 ${b.sample_count}` : ''}${b.stats ? html` · 最小 ${renderMetricReading(b.stats.min, b.unit, metric.definition.id)} / 最大 ${renderMetricReading(b.stats.max, b.unit, metric.definition.id)} / 平均 ${renderMetricReading(b.stats.avg, b.unit, metric.definition.id)}` : nothing}`}</div>
        ${qualityBadges(b)}
        ${renderMetricEvidence(metric.definition, series.dimensions, b, { window: b.window, observed_at: b.observed_at, quality: b.quality, accuracy: b.accuracy, stats: b.stats })}
      </div>`)}`;
  }
  private investigationHref(metric?: MetricResult, series?: MetricResult['series'][number], eventId?: number) {
    const window = this.result?.window;
    if (!window || !Number.isFinite(Date.parse(window.from)) || !Number.isFinite(Date.parse(window.to))
      || metric && !metric.definition.semantic_version) return null;
    const context: InvestigationEntryContext = { schemaVersion: 1,
      resourceRefs: [{ type: this.resourceType as 'instance' | 'server' | 'network_device', id: this.resourceId, role: 'primary' }],
      from: window.from, to: window.to,
      ...(metric && series ? { metric: { id: metric.definition.id, semantic_version: metric.definition.semantic_version! }, dimensions: { ...series.dimensions } } : {}),
      sourceEventIds: eventId ? [eventId] : [], returnTo: location.pathname + location.search + location.hash };
    try { return investigationEntryHref(context, inferBasePathFromPathname(location.pathname)); }
    catch (error) {
      // Standalone component hosts may have no valid application route prefix.
      if (error instanceof Error && error.message === 'INVALID_BASE_PATH') return null;
      throw error;
    }
  }
  private renderSeries(metric: MetricResult, series: MetricResult['series'][number]) {
    const key = seriesKey(metric, series);
    const last = series.buckets.at(-1), summary = this.bucketSummary(metric, series);
    const retained = !last?.observed_at ? [...series.buckets].reverse().find(b => b.observed_at) : undefined;
    const mismatch = unitMismatch(metric, last?.unit);
    const notes = [summary.gap ? `断点 ${summary.gap}` : '', summary.unsafe ? `超出安全数值精度 ${summary.unsafe}` : '', summary.mismatch ? `单位不符 ${summary.mismatch}` : '', summary.records ? `非标量记录 ${summary.records}` : ''].filter(Boolean);
    return html`<div>
      ${Object.entries(series.dimensions).map(([k, v]) => `${k}=${v}`).join(' / ')}
      ${last ? html`<div>${last.value && !('value' in last.value) ? html`<strong>${last.value.encoding} 记录</strong>（非标量，不做折线）<details><summary>记录内容</summary><pre>${JSON.stringify(last.value, null, 2)}</pre></details>`
        : html`${renderMetricReading(last.value, last.unit, metric.definition.id, '未知')} · 最近时间桶 · 覆盖率 ${(last.coverage * 100).toFixed(0)}%`}</div>
        ${observedTime(last)}${qualityBadges(last)}
        ${mismatch ? html`<p class="error" role="alert">单位不符：该时间桶单位 ${last.unit} 与指标定义 ${metric.definition.unit} 不一致，不参与数值与曲线。</p>` : nothing}` : html`<p>暂无可用观测</p>`}
      ${retained ? html`<div class="hint">窗口内最后保留观测（不代表当前值）：
        ${renderMetricReading(retained.value, retained.unit, metric.definition.id, '未知')}
        ${observedTime(retained)}${qualityBadges(retained)}</div>` : nothing}
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
  private lastUsableBucket(metric: MetricResult, series: MetricResult['series'][number]) {
    return series.buckets.findLast(bucket => bucket.value && !unitMismatch(metric, bucket.unit)
      && ['good', 'partial'].includes(bucket.quality.status));
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
        <p>错误：${attempt.error ?? (attempt.status === 'succeeded' ? '无' : '未提供')}${attempt.evidence_code ? ` · ${attempt.evidence_code}` : ''}</p>
        ${attempt.evidence_code === 'SNMP_INTERFACE_CAPACITY_EXCEEDED' ? html`<p>接口数量超过采集容量，未发布部分接口。请在采集策略中同时提高接口行数（max_rows）和总序列预算（max_series_per_resource）；标准包至少需要 1 + 15 × 行数条序列，厂商包再加 2。平台最多支持 100 行，超过需缩小设备端 SNMP 采集范围，并保证接口总数与范围一致。</p>` : ''}`
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
  private renderReadings(metrics: MetricResult[]) {
    const rows = metrics.flatMap(metric => {
      const series = metric.series.length ? metric.series : [{ dimensions: {}, buckets: [] }];
      return series.map(item => ({ metric, series: item, purpose: metricPurpose(metric.definition), key: seriesKey(metric, item) }));
    }).sort((a, b) => a.purpose.localeCompare(b.purpose, 'zh-CN')
      || metricName(a.metric.definition.id).localeCompare(metricName(b.metric.definition.id), 'zh-CN')
      || a.key.localeCompare(b.key));
    return html`<section aria-label="窗口内最近可用值">
      <h2>窗口内最近可用值</h2>
      <div class="summary-grid">${repeat(rows, row => row.key, ({ metric, series, purpose }) => {
        const last = series.buckets.at(-1);
        const bucket = this.lastUsableBucket(metric, series);
        const old = bucket && (this.error || metric.state !== 'available' || bucket.freshness !== 'fresh' || bucket !== last);
        return html`<div class="current latest-value">
          <div><h3 class="metric-name">${metricName(metric.definition.id)}</h3>
            <span class="hint">${purpose}${metricDimensionText(series.dimensions) ? ` · ${metricDimensionText(series.dimensions)}` : ''}</span>
          </div>
          <div class=${old ? 'old-value' : ''}>${renderMetricReading(bucket?.value, bucket?.unit ?? metric.definition.unit, metric.definition.id, '暂无可用观测')}
            ${old ? html`<p class="hint">旧值，不代表当前健康。</p>` : nothing}
          </div>
          <div>${observedTime(bucket ?? last)}
            ${bucket || last ? qualityBadges((bucket ?? last)!) : nothing}
            <div>${states[metric.state] ?? metric.state}${bucket && bucket !== last ? ' · 最新时间桶缺少可用值' : ''}</div>
          </div>
        </div>`;
      })}</div>
    </section>`;
  }
  private renderLatest() {
    if (!this.collection) return this.statusError ? html`<p class="error" role="alert">${this.statusError}</p>` : nothing;
    return html`<h2>资源采集情况</h2>
      <div class="latest-grid" aria-label="资源采集情况">
        ${this.renderCollectionState(this.collection)}${this.renderLastAttempt()}${this.renderSuccessTimes(this.collection)}
      </div>`;
  }
  private async showTrend(key: string) {
    this.trendKey = key;
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>('.selected-trend')?.focus();
  }
  private async showEvidence(key: string) {
    this.rawOpen = true;
    if (this.rawKey !== key) this.selectRaw(key);
    else if (!this.raw) void this.loadRaw();
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>('.raw-observations summary')?.focus();
  }
  private renderSelectedActions(choices: ReturnType<SemanticMetrics['rawSeries']>) {
    const choice = choices.find(item => item.key === this.actionKey) ?? choices[0];
    if (!choice) return nothing;
    const { key, metric, series } = choice;
    const bucket = this.lastUsableBucket(metric, series) ?? series.buckets.at(-1);
    const investigation = this.investigationHref(metric, series);
    return html`<div class="actions" role="group" aria-label="所选指标操作">
      <label>指标与维度 <select @change=${(e: Event) => { this.actionKey = (e.target as HTMLSelectElement).value; }}>
        ${choices.map(item => html`<option value=${item.key} .selected=${item.key === key}>${item.label}</option>`)}
      </select></label>
      <button class="btn" ?disabled=${['histogram', 'summary'].includes(metric.definition.kind ?? '')} @click=${() => void this.showTrend(key)}>查看历史趋势</button>
      <button class="btn" @click=${() => void this.showEvidence(key)}>查看采集详情</button>
      ${investigation ? html`<a class="btn btn-sm" href=${investigation}>以此指标维度打开调查草案</a>` : nothing}
      ${renderMetricEvidence(metric.definition, series.dimensions, bucket, { observed_at: bucket?.observed_at, quality: bucket?.quality, accuracy: bucket?.accuracy })}
    </div>`;
  }
  /** Raw observations are a separate paginated read; they never replace or reshape the curve. */
  private rawSeries(metrics = this.result?.metrics.filter(m => !this.selectedMetric || m.definition.id === this.selectedMetric) ?? []) {
    const rows = metrics.flatMap(metric => metric.series.map(series => ({ metric, series, group: seriesGroup(metric, series) })));
    const counts = new Map<string, number>();
    for (const { group } of rows) counts.set(group, (counts.get(group) ?? 0) + 1);
    return rows.map(({ metric, series, group }) => ({
      key: seriesKey(metric, series), metric, series,
      label: `${metricName(metric.definition.id)} · ${metricDimensionText(series.dimensions) || '整体'}${counts.get(group)! > 1
        ? ` · v${metric.definition.semantic_version ?? '未知'}` : ''}`,
    }));
  }
  private rawChoice(choices = this.rawSeries()) {
    return choices.find(c => c.key === this.rawKey) ?? choices[0];
  }
  private resetRaw() {
    this.rawRequest?.abort();
    this.rawRequest = undefined;
    this.raw = null; this.rawError = ''; this.rawBusy = false;
  }
  private selectRaw(key: string) {
    this.rawKey = key;
    this.resetRaw();
    if (this.rawOpen) void this.loadRaw();
  }
  private async loadRaw(cursor?: string) {
    if (this.rawBusy || this.accessInvalidated || !this.result) return;
    const choice = this.rawChoice();
    if (!choice) return;
    const version = choice.metric.definition.semantic_version;
    this.rawKey = choice.key;
    if (!version) { this.rawError = '指标语义版本未知，无法读取原始观测。'; return; }
    const { resourceId, resourceType, from, to } = this;
    const window = this.result.window;
    const request = this.rawRequest = new AbortController();
    const current = () => request === this.rawRequest && resourceId === this.resourceId
      && resourceType === this.resourceType && from === this.from && to === this.to;
    this.rawBusy = true; this.rawError = '';
    try {
      const page = await metricRequest<RawObservationPage>('observations', {
        resource: { type: resourceType, id: resourceId },
        metric: { id: choice.metric.definition.id, semantic_version: version },
        dimensions: choice.series.dimensions,
        from: window.from, to: window.to, limit: 100,
        ...(cursor ? { cursor } : {}),
      }, request.signal);
      if (current()) this.raw = page;
    } catch (e) {
      if (!current()) return;
      if (e instanceof MetricRequestError && [401, 403, 404].includes(e.status)) {
        // Same protected clear as the status strip: a revoked or missing resource must not keep showing data.
        this.onAccessChanged(); this.error = metricReadError(e, '指标');
      } else {
        const reason = e instanceof MetricRequestError && e.status === 400 ? '：请求、游标或窗口无效' : '';
        const retained = this.raw ? '曲线与上一页原始观测保留' : '曲线保留，可收起后重新展开重试';
        this.rawError = `这一页原始观测读取失败${reason}；${retained}。`;
      }
    } finally {
      if (current()) {
        this.rawRequest = undefined;
        this.rawBusy = false;
      }
    }
  }
  private renderHistoryContext() {
    const context = this.result?.history_context;
    if (!context) return nothing;
    return html`<details class="history-context"><summary>当时阈值、事件与保留策略</summary>
      <p class="hint">阈值按正式观测的配置修订取不可变快照，仅在有对应修订证据的桶绘制；缺口不外推生效时间。当前参数不回填历史。</p>
      <h3>当时采样配置</h3>
      ${(context.configurations ?? []).map(c => html`<p>修订 ${c.revision}：${c.state === 'unknown' ? '配置快照未保全，采样未知' : html`${c.state === 'effective' ? '有生效依据' : '仅已发布，生效未知'}；每 ${c.settings.interval_ms / 1000} 秒，过期界限 ${c.settings.stale_after_ms / 1000} 秒，计数器最大间隔 ${c.settings.max_counter_gap_ms / 1000} 秒；证据 ${c.evidence.map(e => `${e.basis} @ ${localTime(e.at)}`).join('、') || '无'}。依据时间不代表连续有效区间。`}</p>`)}
      <p>仅对缺失快照或缺少生效依据的修订使用历史采样假设：每 ${context.sampling.interval_ms / 1000} 秒，计数器最大间隔 ${context.sampling.max_gap_ms / 1000} 秒；相关覆盖率为假设，不冒充已还原的周期。有依据的修订按其自身设置计算；跨修订时间桶不混算。</p>
      <p>配置保留策略：原始证据 ${context.retention.rawMs / 86400000} 天，归一化历史 ${context.retention.historyMs / 86400000} 天，采集尝试 ${context.retention.attemptMs / 86400000} 天；清理${context.retention.cleanup_enabled ? '已启用' : '未启用'}。这不是已有数据覆盖承诺。</p>
      ${context.missing_revisions.length ? html`<p>配置 ${context.missing_revisions.join('、')} 没有保留阈值快照；当时阈值未知。</p>` : nothing}
      ${context.snapshots.map(snapshot => html`<h3>配置修订 ${snapshot.config_revision}</h3>${snapshot.rules.map(rule => html`
        <p>${metricName(rule.metric.id)} · 语义版本 ${rule.metric.semantic_version} · ${rule.rule_id} v${rule.version} · ${rule.unit}<br>
          问题：${expressionText(rule.problem)}；恢复：${expressionText(rule.recovery)}</p>`)}`)}
      <h3>同窗口问题区段</h3>
      ${!context.events_readable ? html`<p>没有事件查看权限。</p>` : context.events.length ? context.events.map(event => html`
        <details @toggle=${(e: Event) => { if ((e.target as HTMLDetailsElement).open) this.historyEvent = event.event_id; }}><summary>事件 ${event.event_id} · ${localTime(event.from)} — ${event.to ? localTime(event.to) : '尚未恢复'} · 配置${event.config_revision}</summary>
          ${this.investigationHref(undefined, undefined, event.event_id) ? html`<a class="btn btn-sm" href=${this.investigationHref(undefined, undefined, event.event_id)!}>以此事件打开调查草案</a>` : nothing}
          <p>规则 ${event.rule_id} v${event.version}；未知区段 ${event.unknown_segments.length} 个。问题区段与当前查询窗口相交。</p>
          ${this.historyEvent === event.event_id ? html`<template-event-evidence .eventId=${event.event_id}></template-event-evidence>` : nothing}
        </details>`) : html`<p>此窗口没有可读取的问题区段。</p>`}
      <p class="hint">调查草案沿用所选绝对窗口与来源。打开与读取事实不会调用模型。</p>
    </details>`;
  }
  private renderRaw(metrics: MetricResult[]) {
    if (!this.result) return nothing;
    const choices = this.rawSeries(metrics);
    const choice = this.rawChoice(choices);
    if (!choice) return nothing;
    const page = this.raw;
    const { metric, series } = choice;
    return html`<details class="raw-observations" .open=${this.rawOpen} @toggle=${(e: Event) => {
      const open = (e.currentTarget as HTMLDetailsElement).open;
      if (open === this.rawOpen) return;
      this.rawOpen = open;
      if (open && !this.raw) void this.loadRaw();
    }}><summary>原始观测（正式来源分页）</summary>
      <label>指标与维度 <select aria-label="原始观测指标与维度" ?disabled=${this.rawBusy || this.accessInvalidated} @change=${(e: Event) => {
        this.selectRaw((e.target as HTMLSelectElement).value);
      }}>${choices.map(c => html`<option value=${c.key} .selected=${c.key === choice.key}>${c.label}</option>`)}</select></label>
      ${this.rawError ? html`<p class="error" role="alert">${this.rawError}</p>` : nothing}
      ${page ? (page.observations.length ? html`<p class="hint">本页 ${page.observations.length} 条 · 正式窗口内共 ${page.total} 条 · ${page.has_more ? '还有更多页' : '已到最后一页'} · 按观测时间升序</p>
        <app-data-table .dense=${true} .columns=${[{ key: 'time', label: '观测时间' }, { key: 'value', label: '值' }, { key: 'quality', label: '质量与来源' }]}
          .rows=${page.observations.map(o => ({ time: html`<time datetime=${o.observed_at}>${localTime(o.observed_at)}</time>`,
            value: html`${renderMetricReading(o.value, o.unit, metric.definition.id, '空值')}
               ${renderMetricEvidence(metric.definition, series.dimensions, o, { observation_id: o.id, observed_at: o.observed_at, quality: o.quality, accuracy: o.accuracy })}`,
            quality: html`<app-badge variant=${o.quality.status === 'good' ? 'muted' : 'warn'}>${qualityLabels[o.quality.status] ?? o.quality.status}</app-badge> ${qualityLabels[o.accuracy] ?? o.accuracy}` }))}></app-data-table>
        <button class="btn raw-next" ?disabled=${this.rawBusy || !page.has_more} @click=${() => { if (this.raw === page && page.next_cursor) void this.loadRaw(page.next_cursor); }}>下一页原始观测</button>`
        : html`<p>暂无原始观测</p>`) : this.rawBusy ? html`<div class="skeleton" aria-label="正在读取原始观测"></div>` : nothing}
    </details>`;
  }
  override render() {
    const metrics = this.result?.metrics.filter(m => !this.selectedMetric || m.definition.id === this.selectedMetric) ?? [];
    const baselineSeries = metrics.flatMap(metric => metric.series.map(series => ({metric,series})));
    const baseline = baselineSeries[Number(this.baselineKey)];
    const choices = this.rawSeries(metrics);
    const selectedTrend = choices.find(choice => choice.key === this.trendKey);
    const defaultTrends = choices.filter(({ series }) => series.buckets.filter(b => Number.isFinite(Date.parse(b.window.to))).length > 1).slice(0, 2);
    const trends = selectedTrend ? [selectedTrend] : defaultTrends;
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
      .summary-grid { border-block:1px solid var(--border); overflow-x:auto; }
      .current { display:grid; grid-template-columns: minmax(11rem, 1fr) minmax(9rem, max-content) minmax(14rem, 1fr);
        align-items:baseline; gap:var(--space-md); padding:var(--space-sm); font-size:var(--text-sm); }
      .current + .current { border-top:1px solid var(--border); }
      .metric-reading { white-space:nowrap; font-variant-numeric:tabular-nums; overflow-wrap:normal; }
      .current .metric-reading { font-size:var(--text-lg); color:var(--text-strong); }
      .current .old-value .metric-reading { color:var(--muted); }
      .maintenance p { margin-block:var(--space-xs); }
      .latest-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:var(--space-md); border-bottom:1px solid var(--border); padding-block:var(--space-md); }
      .latest-cell { min-width:0; overflow-wrap:anywhere; } .latest-cell h3 { margin:0 0 var(--space-sm); font-size:13px; color:var(--muted); }
      .latest-cell p { margin:0 0 var(--space-xs); }
      .old-value { color:var(--muted); }
      .metric-name { margin:0; font-size:14px; color:var(--text-strong); overflow-wrap:anywhere; }
      .trend-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-md); margin-block:var(--space-lg); }
      .trend-grid:has(.selected-trend) { grid-template-columns:minmax(0,1fr); }
      .trend-grid app-card { min-width:0; }
      metric-chart { display:block; min-width:0; }
      .bucket-row { border-top:1px solid var(--border); padding-block:var(--space-xs); }
      details { margin-block:var(--space-sm); } summary { cursor:pointer; color:var(--text); }
      h2 { font-size:16px; margin-block:var(--space-lg) var(--space-sm); }
      @media(max-width:700px) { .trend-grid { grid-template-columns:minmax(0,1fr); } .actions label { flex:1 1 120px; } select,input[type="datetime-local"] { max-width:100%; } }
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
      <label>指标 <select aria-label="指标" ?disabled=${this.accessInvalidated} @change=${(e: Event) => { this.selectedMetric = (e.target as HTMLSelectElement).value; this.baselineKey = ''; this.selectRaw(''); }}><option value="" .selected=${!this.selectedMetric}>全部指标</option>${this.selectedMetric && !this.result?.metrics.some(m => m.definition.id === this.selectedMetric) ? html`<option value=${this.selectedMetric} .selected=${true}>${metricName(this.selectedMetric)} · ${this.selectedMetric}</option>` : nothing}${this.result?.metrics.map(m => html`<option value=${m.definition.id} .selected=${m.definition.id === this.selectedMetric}>${metricName(m.definition.id)} · ${m.definition.id}</option>`)}</select></label>
      <button aria-busy=${String(this.busy)} class="btn btn-refresh" .disabled=${this.busy || this.accessInvalidated} @click=${this.load}>刷新标准指标</button>
      <p class="window">主图窗口（${timezone()}）：${this.activeWindow ? `${localTime(this.activeWindow.from)} — ${localTime(this.activeWindow.to)}` : '待应用'}</p>
      ${this.customError ? html`<p class="error" role="alert">${this.customError}</p>` : nothing}
      ${this.result ? html`<p class="window">${this.windowNote()}</p>` : nothing}
    </div>
    ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
    ${this.error && !this.accessInvalidated && this.activeWindow ? html`<button class="btn" @click=${() => void this.loadQuery(this.activeWindow!)}>重试主图指标</button>` : nothing}
    ${this.busy ? html`<p role="status">正在读取主图指标</p>` : nothing}
    ${!this.busy && !this.error && this.result && !this.result.metrics.length ? html`<p role="status">主图窗口没有指标记录。</p>` : nothing}
    ${!this.busy && !this.error && this.result && this.selectedMetric && !metrics.length ? html`<p role="status">当前窗口未返回所选指标；可刷新或选择全部指标。</p>` : nothing}
    ${metrics.length ? this.renderReadings(metrics) : nothing}
    ${this.renderSelectedActions(choices)}
    ${this.result ? this.renderLatest() : nothing}
    <section class="maintenance" aria-label="维护历史"><h2>主图窗口的维护历史</h2>
      ${this.maintenanceBusy ? html`<p role="status">维护历史正在读取，状态未知</p>` : nothing}
      ${this.maintenanceError ? html`<p class="error" role="alert">${this.maintenanceError}</p>
        <button class="btn" @click=${() => void this.loadMaintenance(this.activeWindow!)}>重试维护历史</button>` : nothing}
      ${!this.maintenanceBusy && !this.maintenanceError && this.maintenance?.intervals.length === 0
        ? html`<p>主图窗口没有已记录的有限期限维护区段。</p>` : nothing}
      ${this.maintenance?.intervals.length ? html`<p class="hint">维护期间继续采集并记录问题，告警通知受抑制。</p>` : nothing}
      ${(this.maintenance?.intervals ?? []).map(v => html`<p><strong>${v.name}</strong> · ${localTime(v.effective_from)} — ${localTime(v.effective_to)} · ${v.reason}</p>`)}
      ${this.maintenance ? html`<details><summary>维护区间边界与事件影响</summary>
        <p>区间按主图窗口裁剪，含起点、不含终点。显示时区 ${timezone()}。旧周期维护历史未覆盖。</p>
        ${this.maintenance.intervals.map(v => html`<p>${v.name} · 修订 ${v.revision} · [${v.effective_from}, ${v.effective_to}) · 定义时区 ${v.timezone}</p>`)}
        ${this.maintenance.event_links.map(v => html`<p>事件关联 ${v.event_id ?? v.alert_id} · ${localTime(v.at)} · 维护状态 ${v.state === 'active' ? '维护中' : v.state === 'inactive' ? '未命中' : '未知'} · ${(v.intervals ?? []).map(i => `${i.id} 修订 ${i.revision}：${i.reason}`).join('；')}</p>`)}
      </details>` : nothing}
    </section>
    ${this.renderHistoryContext()}
    <metric-study .resourceType=${this.resourceType} .resourceId=${this.accessInvalidated?0:this.resourceId}></metric-study>
    ${this.renderRaw(metrics)}
    ${trends.length ? html`<div class="trend-grid" aria-label="指标趋势比较">${trends.map(({metric,series}) => html`<app-card><span slot="header" class=${selectedTrend ? 'selected-trend' : ''} tabindex="-1">${metricName(metric.definition.id)} · ${metricDimensionText(series.dimensions) || '整体'}</span>${this.renderTrend(metric, series, Boolean(selectedTrend))}</app-card>`)}</div>
      <p class="window">断点只用于缺失、质量未知或无效、单位不符、非标量及超出安全数值精度的桶；过期但当时 good/partial 的值照常显示。桶内峰值以最小/最大包络显示，包络与曲线使用同一可绘制条件。部分覆盖的点保留在曲线上，但不代表当前健康。全部维度与精确值可在观测明细中核对。</p>` : nothing}
    <details><summary>行为基线与资格</summary>
      <label>基线指标与维度<select aria-label="基线指标与维度" .value=${this.baselineKey} ?disabled=${this.accessInvalidated || this.busy} @change=${(e:Event)=>this.baselineKey=(e.target as HTMLSelectElement).value}><option value="">选择指标与维度</option>${baselineSeries.map(({metric,series},index)=>html`<option value=${index}>${metricName(metric.definition.id)} · ${Object.values(series.dimensions).join(' / ') || '整体'}</option>`)}</select></label>
      ${this.baselineKey !== '' && baseline ? html`<operations-behavior-baseline .resourceType=${this.resourceType} .resourceId=${this.resourceId} .metric=${baseline.metric.definition.id} .dimensions=${baseline.series.dimensions}></operations-behavior-baseline>` : html`<p>选择实际可见指标的一个维度后，可评估其行为基线。样本不足时偏离保持未知。</p>`}
    </details>
    <h2>观测明细</h2>
    ${['canonical', 'extension'].map(category => html`<app-card><span slot="header">${category === 'canonical' ? '标准指标与能力' : '模板扩展指标'}</span>
      ${metrics.filter(m => m.definition.category === category).length ? html`<details><summary>查看时间桶、定义与来源（${metrics.filter(m => m.definition.category === category).length} 项）</summary>
        <app-data-table .dense=${true} .columns=${[{key:'metric',label:'指标与口径'},{key:'value',label:'观测与质量'}]}
        .rows=${metrics.filter(m => m.definition.category === category).map(m => ({metric:html`<strong>${metricName(m.definition.id)}</strong><details><summary>指标定义</summary><p>${m.definition.id} · ${m.definition.semantic_version ?? '版本未知'}</p><p>${m.definition.meaning}</p></details>`,value:m.series.length ? html`${m.series.map(series => this.renderSeries(m, series))}` : html`<span>${states[m.state] ?? m.state} · 暂无可用观测</span>`}))}></app-data-table>
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
        if (!response.ok) throw new MetricRequestError(response.status);
        const data: SemanticResult = await response.json();
        if (generation !== this.generation) return;

        for (const m of data.metrics) row[m.definition.id] = renderMetricValue(m);
      } catch (e) { row.error = metricReadError(e, '指标'); }
      rows.push(row);
    }
    if (generation === this.generation) this.rows = rows;
  }
  override render() { return html`<app-card><span slot="header">核心指标（固定产品口径）</span>
    <app-data-table .columns=${this.columns.length ? this.columns : [{ key: 'resource', label: '资源' }, { key: 'error', label: '查询状态' }]} .rows=${this.rows}></app-data-table></app-card>`; }
}
