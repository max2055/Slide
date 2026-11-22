import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import {
  eventDetailUrl, eventDisplayTitle, eventReadDenied, eventStatusLabels, linkedInvestigationLabels,
  readEventId, readEventInvestigation, type LinkedInvestigation, type QueueEvent,
} from '../controllers/event-investigation-api.ts';
import { investigationEntryHref } from '../controllers/investigation-entry.ts';
import { openWorkbenchRecord } from '../workbench-position.ts';
import { displayTime } from '../views/diagnosis-presentation.ts';
import type { TemplateEventEvidence } from '../../../api/generated/public-api.ts';
import { metricDisplayName } from './metric-display.ts';
import { resourceDetailUrl, type ResourceType } from './resource-investigation-links.ts';
import { metricRequest } from './metric-api.ts';
import './app-dialog.ts';
import './app-badge.ts';
import './template-event-close.js';

interface Condition {
  node: string;
  operator?: '>' | '>=' | '<' | '<=' | '=' | '!=';
  threshold?: {value?: number; name?: string};
  select?: {aggregation: string; window_ms?: number};
  children?: Condition[];
}
interface Rule {
  rule_id: string;
  metric: {id: string; semantic_version: string};
  unit: string;
  problem: Condition;
  recovery?: Condition;
  recovery_mode?: 'problem_expression' | 'recovery_expression' | 'none';
  version?: number;
  body_hash?: string;
  scope?: string;
  inputs?: Array<{metric: Rule['metric']}>;
  parameters?: Array<{name:string; value:unknown}>;
}
interface Telemetry {
  can_manual_close?: boolean;
  episode: {
    resource: {type: ResourceType; id: number | string};
    rule_id: string;
    version?: number;
    body_hash?: string;
    scope?: string;
    state: 'open' | 'closed';
    opened: {at: string; value: number | null};
    closed_at: string | null;
    manual_close?: { actor_id: number };
    last: {at: string; value: number | null; quality: string; dimensions?: Record<string,string> | null};
  };
  snapshot: {
    configuration: {rules: Rule[]};
    opening: {dimensions?: Record<string,string>; sample_ids?: string[]; samples?: TemplateEventEvidence['snapshot']['opening']['samples']};
  };
  evaluation?: {state: string};
}
type Drawer = 'trigger' | 'recovery' | 'recommendation';
const operators: Record<string,string> = {'>=':'≥','<=':'≤','!=':'≠'};
const qualityLabels: Record<string,string> = {good:'有效',partial:'部分有效',unknown:'待确认'};
function describeRule(condition: Condition | undefined, parameters: Rule['parameters']): string {
  if (!condition) return '规则不可用';
  if (condition.node === 'compare' && condition.operator) {
    const threshold = condition.threshold?.value ?? parameters?.find(p => p.name === condition.threshold?.name)?.value ?? condition.threshold?.name;
    const operator = operators[condition.operator] ?? condition.operator;
    const aggregate = condition.select?.aggregation;
    const label = aggregate && aggregate !== 'last' ? aggregate + (condition.select?.window_ms ? `（${condition.select.window_ms / 1000} 秒）` : '') + ' ' : '';
    return `${label}${operator} ${typeof threshold === 'number' ? formatNumber(threshold) : threshold ?? '未知阈值'}`;
  }
  const children = condition.children?.map(child => describeRule(child, parameters));
  return children?.length ? `(${children.join(condition.node === 'all' ? ' 且 ' : ' 或 ')})` : '规则不可用';
}
const formatNumber = (value: number) => new Intl.NumberFormat('zh-CN', {maximumSignificantDigits:17}).format(value);
const formattedValue = (value: number | null, unit: string) => value == null ? '观测值未知' : `${formatNumber(value)} ${unit === 'By' ? '字节' : unit}`;


@customElement('event-investigation-record')
export class EventInvestigationRecord extends LitElement {
  @property({attribute:false}) event?: QueueEvent;
  @property({attribute:false}) link?: LinkedInvestigation | null;
  @property({type:Boolean}) lookup = false;
  @property({type:Boolean}) full = false;
  @property({type:Boolean}) allowStart = false;
  @property() source = '';
  @state() private loadedLink?: LinkedInvestigation | null;
  @state() private linkError = '';
  @state() private linkLoading = false;
  @state() private telemetry?: Telemetry;
  @state() private telemetryLoading = false;
  @state() private telemetryError = '';
  @state() private tab: 'overview' | 'evidence' | 'timeline' = 'overview';
  @state() private drawer?: Drawer;
  private request?: AbortController;
  private linkRequest?: AbortController;
  private invalidated = false;
  private poll?: ReturnType<typeof setTimeout>;

  static styles = [sharedBtnStyles, css`
    :host { display:block; min-width:0; color:var(--text); }
    h3,h4,p,ol,dl,dd { margin:0; }
    h3,h4,strong { color:var(--text-strong); }
    a { color:var(--accent-text); }
    header { padding:var(--space-lg); }
    .topline { display:flex; justify-content:space-between; align-items:baseline; gap:var(--space-sm); flex-wrap:wrap; }
    .record-id { font:600 var(--text-sm)/1.5 var(--mono); color:var(--accent-text); }
    .record-title { margin:var(--space-xs) 0; font-size:var(--text-2xl); line-height:1.35; overflow-wrap:anywhere; }
    .meta { color:var(--muted); font-size:var(--text-base); }
    .states { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); border-block:1px solid var(--border); background:var(--bg); }
    .states > div { min-width:0; padding:var(--space-sm) var(--space-md); }
    .states > div + div { border-left:1px solid var(--border); }
    dt { color:var(--muted); font-size:var(--text-sm); }
    .states dd { font-weight:600; overflow-wrap:anywhere; }
    .ok { color:var(--ok); }.warn { color:var(--warn); }.info { color:var(--accent-text); }
    .tabs { display:flex; gap:var(--space-lg); padding-inline:var(--space-lg); border-bottom:1px solid var(--border); }
    .tabs button { background:transparent; border:0; padding:var(--space-sm) 0; border-bottom:2px solid transparent; color:var(--muted); cursor:pointer; font:inherit; }
    .tabs button[aria-pressed=true] { border-color:var(--accent); color:var(--accent-text); font-weight:600; }
    .body { padding:var(--space-lg); }
    .overview { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(186px,1fr); gap:var(--space-lg); align-items:start; }
    .label,.limit { color:var(--muted); font-size:var(--text-sm); }
    .finding { font-size:var(--text-xl); margin:var(--space-xs) 0 var(--space-sm); line-height:1.4; }
    .limit { margin-top:var(--space-sm); }
    p { overflow-wrap:anywhere; line-height:1.55; }
    .suggestion { padding:var(--space-md); background:var(--accent-subtle); border:1px solid var(--border); border-radius:var(--radius-sm); }
    .suggestion .label { color:var(--accent-text); }
    .suggestion :is(h4,p) { margin-block:var(--space-xs); }
    .actions { display:flex; flex-wrap:wrap; gap:var(--space-sm); margin-top:var(--space-sm); }
    .sources { margin-top:var(--space-lg); }
    .sourceheading { display:flex; justify-content:space-between; gap:var(--space-sm); padding-bottom:var(--space-xs); }
    .sample { border:0; border-top:1px solid var(--border); background:none; display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:var(--space-md); align-items:center; width:100%; padding:var(--space-sm) var(--space-xs); text-align:left; color:var(--text); cursor:pointer; font:inherit; }
    .sample:hover { background:var(--bg); }
    .sample time { color:var(--muted); font-variant-numeric:tabular-nums; }
    .sample .value { color:var(--muted-strong); font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
    .sample .arrow { color:var(--accent-text); }
    details { margin-top:var(--space-md); overflow-wrap:anywhere; }
    summary { color:var(--accent-text); cursor:pointer; }
    details p { margin-top:var(--space-sm); }
    .timeline { padding-left:var(--space-xl); }
    .timeline li { padding:var(--space-sm) 0; border-bottom:1px solid var(--border); overflow-wrap:anywhere; }
    .timeline small { display:block; color:var(--muted); }
    .drawer-facts { display:grid; grid-template-columns:105px minmax(0,1fr); gap:var(--space-md); }
    .drawer-facts dd { overflow-wrap:anywhere; }
    .drawer-note { margin-top:var(--space-md); }
    .timeline-status { margin-bottom:var(--space-md); }
    .original { white-space:pre-wrap; }
    .sample-value { font-variant-numeric:tabular-nums; }
    .subtle-error { color:var(--danger); }
    button:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
    @media(max-width:1050px) { .overview { grid-template-columns:minmax(0,1fr); } }
  `];

  protected updated(changes: Map<string, unknown>) {
    if (changes.has('event')) {
      const previous = changes.get('event') as QueueEvent | undefined;
      if (readEventId(previous?.id ?? null) !== readEventId(this.event?.id ?? null)) {
        this.tab = 'overview';
        this.drawer = undefined;
        void this.loadTelemetry();
        void this.loadLink();
      }
    }
    if (changes.has('lookup') && !changes.has('event')) void this.loadLink();
  }
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-session-expired',this.invalidate);
    window.addEventListener('slide-permissions-loaded',this.invalidate);
  }
  override disconnectedCallback() {
    this.stopRequests();
    window.removeEventListener('slide-session-expired',this.invalidate);
    window.removeEventListener('slide-permissions-loaded',this.invalidate);
    super.disconnectedCallback();
  }
  private stopLink() {
    this.linkRequest?.abort();
    clearTimeout(this.poll);
  }
  private stopRequests() { this.stopLink(); this.request?.abort(); }
  private invalidate = () => {
    this.stopRequests();
    this.invalidated = true;
    this.loadedLink = undefined;
    this.telemetry = undefined;
    this.drawer = undefined;
    this.requestUpdate();
  };
  private async loadLink(polling = false) {
    this.stopLink();
    if (!this.lookup || !this.event || this.invalidated) return;
    if (!polling) {
      this.loadedLink = undefined;
      this.linkError = '';
      this.linkLoading = true;
    }
    const id = readEventId(this.event.id);
    const abort = this.linkRequest = new AbortController();
    try {
      const link = await readEventInvestigation(id, abort.signal);
      if (abort.signal.aborted) return;
      this.loadedLink = link;
      this.linkError = '';
      if (link?.state === 'running') this.poll = setTimeout(() => void this.loadLink(true), 5000);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (eventReadDenied(error)) {
        this.invalidate();
        this.dispatchEvent(new CustomEvent('event-investigation-denied',{bubbles:true,composed:true}));
        return;
      }
      this.loadedLink = undefined;
      this.linkError = '关联调查暂时无法读取。';
    } finally { if (!abort.signal.aborted) this.linkLoading = false; }
  }
  private async loadTelemetry() {
    this.request?.abort();
    this.telemetry = undefined;
    this.telemetryError = '';
    this.telemetryLoading = false;
    const event = this.event;
    if (event?.source_type !== 'template-trigger' || this.invalidated) return;
    const abort = this.request = new AbortController();
    this.telemetryLoading = true;
    try {
      const data = await metricRequest<Telemetry>(`template-events/${readEventId(event.id)}`, undefined, abort.signal);
      if (!data?.episode?.opened || !data.episode.last || !data.episode.resource
        || !data.snapshot?.configuration?.rules?.some(rule => rule.rule_id === data.episode.rule_id && rule.metric)) throw new Error('INVALID_EVENT_EVIDENCE');
      if (!abort.signal.aborted) this.telemetry = data;
    } catch { if (!abort.signal.aborted) this.telemetryError = '正式监控证据暂不可用。'; }
    finally { if (!abort.signal.aborted) this.telemetryLoading = false; }
  }
  private get recovered() {
    return this.telemetry?.episode.state === 'closed' && !this.telemetry.episode.manual_close
      && Number.isFinite(Date.parse(this.telemetry.episode.closed_at ?? ''));
  }
  private get rule() {
    const telemetry = this.telemetry;
    if (!telemetry) return;
    const { episode, snapshot } = telemetry;
    return snapshot.configuration.rules.find(rule => rule.rule_id === episode.rule_id
      && (episode.version === undefined || rule.version === episode.version)
      && (episode.scope === undefined || rule.scope === episode.scope)
      && (episode.body_hash === undefined || rule.body_hash === episode.body_hash));
  }
  focusHeading() {
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('.record-title')?.focus({preventScroll:true}));
  }
  private investigationHref(link: LinkedInvestigation) {
    const query = new URLSearchParams({investigation:link.id});
    const origin = !this.full && this.source ? this.source : eventDetailUrl(readEventId(this.event?.id ?? null));
    query.set('returnTo',origin);
    return '/workbench?' + query;
  }
  private draftHref() {
    if (!this.allowStart || !this.event || !this.telemetry || !this.rule) return undefined;
    const {resource, opened, last, closed_at} = this.telemetry.episode;
    const id = readEventId(resource.id);
    const eventId = readEventId(this.event.id);
    const started = Date.parse(opened.at);
    const ended = Date.parse(closed_at ?? opened.at);
    const from = started - 2000;
    const to = Math.min(ended + 2001, Date.now());
    if (!id || !eventId || !['instance','server','network_device'].includes(resource.type)
      || !Number.isFinite(started) || !Number.isFinite(ended) || from >= to || to - from > 31 * 86400000) return undefined;
    return investigationEntryHref({
      schemaVersion:1, resourceRefs:[{type:resource.type,id,role:'primary'}], from:new Date(from).toISOString(), to:new Date(to).toISOString(),
      ...(last.dimensions ? {metric:this.rule.metric,dimensions:last.dimensions} : {}),
      sourceEventIds:[eventId], returnTo:eventDetailUrl(eventId),
    });
  }
  private entryLink(link: LinkedInvestigation) {
    const href = this.investigationHref(link);
    const key = `source-event-${readEventId(this.event?.id ?? null)}`;
    return html`<a href=${href} @click=${(event:MouseEvent) => openWorkbenchRecord(event,href,key)} data-workbench-key=${key}>打开原调查</a>`;
  }
  private samples() {
    const episode = this.telemetry?.episode;
    if (!episode || !this.rule) return [];
    return [
      {key:'trigger' as const,label:'触发样本',at:episode.opened.at,value:episode.opened.value,rule:this.rule.problem},
      ...(this.recovered ? [{key:'recovery' as const,label:'恢复样本',at:episode.closed_at,value:episode.last.value,rule:this.rule.recovery_mode === 'problem_expression' ? this.rule.problem : this.rule.recovery}] : []),
    ];
  }
  private summarySamples() {
    const samples = this.samples();
    if (!samples.length) return nothing;
    return html`<section class="sources" aria-label="关键证据">
      <div class="sourceheading"><h4>关键证据</h4><span class="label">正式历史观测</span></div>
      ${samples.map(sample => html`<button class="sample" type="button" @click=${() => {this.drawer = sample.key;}}>
        <span><strong>${sample.label}</strong> <time>${displayTime(sample.at)}</time></span>
        <span class="value">${formattedValue(sample.value,this.rule!.unit)}</span><span aria-hidden="true" class="arrow">›</span>
      </button>`)}
    </section>`;
  }
  private timeline(link: LinkedInvestigation | null | undefined) {
    const samples = this.samples();
    const episode = this.telemetry?.episode;
    const nodes = samples.length ? samples.map(sample => ({
      at: sample.at, label: sample.label, note: formattedValue(sample.value, this.rule!.unit),
    })) : [{ at: this.event?.created_at, label: '记录事件', note: '' }];
    if (episode?.manual_close) nodes.push({ at: episode.closed_at, label: '手动关闭', note: `操作者 #${episode.manual_close.actor_id}` });
    if (link) nodes.push({ at: link.updatedAt, label: '关联调查更新', note: linkedInvestigationLabels[link.state] });
    const dated = nodes.flatMap(node => node.at && Number.isFinite(Date.parse(node.at)) ? [{ ...node, at: node.at }] : [])
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return html`
      ${this.telemetry?.evaluation?.state === 'stopped' ? html`<p class="timeline-status"><strong>当前评估已停止。</strong>资源现时健康待确认。</p>` : nothing}
      ${dated.length ? html`<ol class="timeline" aria-label="事件时间线">${dated.map(node => html`
        <li><strong>${node.label}</strong> · <time datetime=${node.at}>${displayTime(node.at)}</time>
          ${node.note ? html`<small>${node.note}</small>` : nothing}</li>`)}</ol>`
        : html`<p>暂无带时间戳的事件记录。</p>`}`;
  }
  private metricCheck() {
    const episode = this.telemetry?.episode;
    const rule = this.rule;
    if (!episode || !rule?.metric.id || !readEventId(episode.resource.id) || !Number.isFinite(Date.parse(episode.opened.at))) return;
    const matchingSample = this.telemetry?.snapshot.opening.samples?.find(sample =>
      sample.metric.id === rule.metric.id && sample.metric.semantic_version === rule.metric.semantic_version
      && sample.window && Number.isFinite(Date.parse(sample.window.from)) && Number.isFinite(Date.parse(sample.window.to)));
    return {
      metric: metricDisplayName(rule.metric.id),
      from: matchingSample?.window?.from ?? episode.opened.at,
      to: matchingSample?.window?.to ?? episode.opened.at,
    };
  }
  private overview(link: LinkedInvestigation | null | undefined) {
    const check = this.metricCheck();
    const specific = check && this.recovered && link?.state !== 'running';
    const start = link === null ? this.draftHref() : undefined;
    const fact = this.recovered ? '本次告警已恢复，资源现时健康待确认'
      : this.telemetry?.episode.manual_close ? '告警已手动关闭'
      : this.telemetry?.episode.state === 'open' ? '告警尚未记录恢复'
      : this.event?.source_type === 'template-trigger' ? '告警的触发与恢复证据待核对' : '已记录事件';
    const gap = this.recovered ? '已记录触发与恢复样本，现有记录未确认恢复后的资源状态。'
      : link?.state === 'running' ? '本次调查尚未结束，当前结论待确认。'
      : link?.state === 'insufficient' ? '关联调查的证据不足，具体缺口需查原记录。'
      : link === null ? '当前无可见的关联调查。'
      : link?.conclusion ? '历史结论已保存，具体证据缺口需查原记录。'
      : link ? '关联调查尚无可展示的结论。' : '关联调查状态待确认。';
    const next = specific ? `核对触发时的${check.metric}采集记录，再看恢复后是否有新样本。`
      : link?.state === 'running' ? '查看原调查的执行进度。'
      : link ? '打开原调查，核对现有证据和待确认问题。'
      : start ? '打开只读调查草稿，核对目标和时间范围。'
      : this.samples().length ? '先核对告警样本及当时的判定规则。' : '先核对事件详情和关联告警。';
    return html`<div class="overview">
      <section aria-label="告警事实与证据缺口">
        <h4 class="finding">${fact}</h4>
        <p><strong>证据缺口</strong> ${gap}</p>
        ${this.telemetry?.evaluation?.state === 'stopped' ? html`<p class="limit">当前评估已停止。</p>` : nothing}
        ${this.linkLoading ? html`<p role="status">正在读取关联调查…</p>` : this.linkError ? html`<p role="alert" class="subtle-error">${this.linkError}</p>` : nothing}
      </section>
      <aside class="suggestion" aria-label="建议下一步">
        <span class="label">建议下一步</span>
        <h4>${next}</h4>
        <div class="actions">
          ${link || check ? html`<button class="btn-primary btn-sm" type="button" @click=${() => {this.drawer = 'recommendation';}}>查看建议详情</button>` : nothing}
          ${start ? html`<a class="btn btn-sm" href=${start}>进入只读调查</a>` : nothing}
          ${this.linkError && this.lookup ? html`<button class="btn btn-sm btn-refresh" type="button" @click=${() => void this.loadLink()}>重试读取调查</button>` : nothing}
        </div>
      </aside>
    </div>
    ${this.telemetryLoading ? html`<p class="limit" role="status">正在读取正式监控证据…</p>` : this.telemetryError ? html`<p class="limit">${this.telemetryError}</p>` : nothing}
    ${this.summarySamples()}`;
  }
  private renderDrawer(link: LinkedInvestigation | null | undefined) {
    if (!this.drawer) return nothing;
    const sample = this.samples().find(item => item.key === this.drawer);
    const title = sample?.label ?? '调查处理建议';
    const resource = this.telemetry?.episode.resource;
    const check = this.metricCheck();
    const rule = this.rule;
    return html`<app-dialog .open=${true} placement="end" title=${title} @app-dialog-close=${() => {this.drawer = undefined;}}>
      ${sample && rule ? html`<dl class="drawer-facts">
        <dt>判定时间</dt><dd>${displayTime(sample.at)}</dd><dt>观测值</dt><dd class="sample-value">${formattedValue(sample.value,rule.unit)}</dd>
        <dt>当时规则</dt><dd>${sample.key === 'recovery' && rule.recovery_mode === 'problem_expression' ? '问题条件转假：' : ''}${describeRule(sample.rule,rule.parameters)}</dd>
        <dt>指标</dt><dd>${metricDisplayName(rule.metric.id)}</dd>
        ${sample.key === 'recovery' ? html`<dt>证据质量</dt><dd>${qualityLabels[this.telemetry?.episode.last.quality ?? ''] ?? '待确认'}</dd>` : nothing}
        </dl>
        <details><summary>原始时间、规则版本与样本</summary>
          <dl class="drawer-facts">
            <dt>原始时间（UTC）</dt><dd>${sample.at}</dd><dt>原始观测值</dt><dd>${sample.value ?? '未提供'} ${rule.unit}</dd>
            <dt>指标标识与版本</dt><dd>${rule.metric.id} · ${rule.metric.semantic_version}</dd>
            <dt>规则标识与版本</dt><dd>${rule.rule_id} · ${rule.version ?? '未提供'}</dd>
            ${rule.body_hash ? html`<dt>规则哈希</dt><dd>${rule.body_hash}</dd>` : nothing}
            ${sample.key === 'trigger' ? html`<dt>正式样本引用</dt><dd>${this.telemetry?.snapshot.opening.sample_ids?.join('、') || '未提供样本引用'}</dd>` : nothing}
          </dl>
          ${sample.key === 'trigger' ? this.telemetry?.snapshot.opening.samples?.map(item => html`
            <p class="original">${item.id} · ${item.metric.id} · ${item.observed_at}<br>
            ${item.value.value} ${item.unit}${item.window ? html`<br>${item.window.from} — ${item.window.to}` : nothing}</p>`) : nothing}
        </details><p class="drawer-note">此处展示事件时点的证据。资源现时健康待确认。</p>`
       : html`
        ${check ? html`<dl class="drawer-facts">
          <dt>关联指标</dt><dd>${[...new Set([check.metric, ...(rule?.inputs ?? []).map(input => metricDisplayName(input.metric.id))])].join('、')}</dd>
          <dt>${check.from === check.to ? '触发时点' : '触发样本窗口'}</dt><dd>${displayTime(check.from)}${check.from === check.to ? '' : ` — ${displayTime(check.to)}`}（本地时间）</dd>
          ${this.recovered ? html`<dt>恢复时点</dt><dd>${displayTime(this.telemetry?.episode.closed_at)}（本地时间）</dd>` : nothing}
        </dl>
        <p class="drawer-note"><button class="btn" type="button" @click=${() => {
          this.tab = 'evidence'; this.drawer = undefined;
          void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLButtonElement>('.tabs [aria-pressed=true]')?.focus());
        }}>${this.recovered ? '查看触发与恢复证据' : '查看触发证据'}</button></p>
        <details><summary>指标标识与原始时间</summary><p>${rule?.metric.id} · ${rule?.metric.semantic_version}</p>
          <p>${check.from}${check.from === check.to ? '' : ` — ${check.to}`}${this.recovered ? html`<br>${this.telemetry?.episode.closed_at}` : nothing}</p></details>`
          : html`<p>当前记录未提供可关联的指标和时间范围。</p>`}
        ${link ? html`<p class="drawer-note">${this.entryLink(link)}</p>` : nothing}
        ${link?.conclusion?.trim() || link?.recommendation?.trim() ? html`<details>
          <summary>展开已保存的调查原文</summary>
          ${link.conclusion?.trim() ? html`<h4>原始结论</h4><p class="original">${link.conclusion}</p>` : nothing}
          ${link.recommendation?.trim() ? html`<h4>原始建议</h4><p class="original">${link.recommendation}</p>` : nothing}
        </details>` : nothing}`}
      ${resource ? html`<a slot="footer" class="btn" href=${resourceDetailUrl(resource.type,readEventId(resource.id))}>查看当前资源</a>` : nothing}
    </app-dialog>`;
  }
  render() {
    if (this.invalidated || !this.event) return nothing;
    const event = this.event;
    const id = readEventId(event.id);
    const link = this.lookup ? this.loadedLink : this.link;
    const resource = this.telemetry?.episode.resource;
    const isTemplate = event.source_type === 'template-trigger';
    const mount = this.telemetry?.snapshot.opening.dimensions?.mount ?? this.telemetry?.episode.last.dimensions?.mount;
    const monitorStatus = this.telemetry?.episode.manual_close ? '已手动关闭' : this.recovered ? '本次告警已恢复' : this.telemetry?.episode.state === 'open' ? '尚无恢复记录'
      : isTemplate ? this.telemetryLoading ? '读取中' : '待确认' : eventStatusLabels[event.status] ?? '待确认';
    const tabs = [
      {id:'overview' as const,label:'概览'},
      ...(event.source_type === 'template-trigger' ? [{id:'evidence' as const,label:`证据${this.samples().length ? `（${this.samples().length}）` : ''}`}] : []),
      {id:'timeline' as const,label:'时间线'},
    ];
    return html`<header><div class="topline"><span class="record-id">事件 #${id}</span>
      ${this.full ? html`${link ? this.entryLink(link) : nothing}
        ${this.telemetry?.can_manual_close === true ? html`<template-event-close .eventId=${id}
          @template-event-closed=${(event: CustomEvent<Telemetry>) => { this.telemetry = event.detail; this.focusHeading(); }}></template-event-close>` : nothing}`
        : html`<a href=${eventDetailUrl(id,this.source)}>打开事件详情</a>`}
      </div><h3 class="record-title" tabindex="-1">${eventDisplayTitle(event)}</h3>
      <p class="meta">${event.instance_name ? `${event.instance_name} · ` : resource ? html`<a href=${resourceDetailUrl(resource.type,readEventId(resource.id))}>${({instance:'数据库',server:'服务器',network_device:'网络设备'})[resource.type]} #${resource.id}</a> · ` : nothing}${mount ? `挂载点 ${mount} · ` : ''}${displayTime(event.created_at)}</p></header>
      <dl class="states">
        <div><dt>${isTemplate ? '告警状态' : '事件处理'}</dt><dd class=${this.recovered ? 'ok' : ''}>${monitorStatus}</dd></div>
        <div><dt>资源现时健康</dt><dd class="warn">待确认</dd></div>
        <div><dt>AI 调查</dt><dd class="info">${link ? linkedInvestigationLabels[link.state] : this.linkLoading ? '读取中' : link === null ? '暂无可见调查' : '待确认'}</dd></div>
      </dl>
      <nav aria-label="调查内容" class="tabs">
      ${tabs.map(tab => html`<button type="button" aria-pressed=${String(this.tab === tab.id)} @click=${() => {this.tab = tab.id;}}>${tab.label}</button>`)}
      </nav>
      <div class="body">${this.tab === 'timeline' ? this.timeline(link) : this.tab === 'evidence'
        ? this.samples().length ? this.summarySamples() : html`<p role="status">${this.telemetryLoading ? '正在读取正式监控证据…' : '正式监控证据暂不可用。'}</p>`
        : this.overview(link)}</div>
      ${this.renderDrawer(link)}`;
  }
}
