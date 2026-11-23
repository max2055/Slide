import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import { metricRequest, metricError, MetricRequestError } from "./metric-api.js";
import { metricDisplayName, triggerRecoveryModes, type TriggerRecoveryMode } from './metric-display.js';
import { displayTime } from '../views/diagnosis-presentation.ts';
import "./app-data-table.js";
import "./template-event-close.js";
const condition = (n: any, operands: Map<string, string>): string =>
  n?.node === "compare"
    ? `${n.select.item_id ? `${operands.get(n.select.item_id) ?? n.select.item_id} · ` : ""}${n.select.aggregation}${n.select.window_ms ? `(${n.select.window_ms / 1000}秒)` : ""} ${n.operator} ${n.threshold.value ?? n.threshold.name}`
    : `(${n?.children?.map((child: unknown) => condition(child, operands)).join(n.node === "all" ? " 且 " : " 或 ") ?? "未知"})`;
@customElement("template-event-evidence")
export class TemplateEventEvidence extends LitElement {
  @property({ type: Number }) eventId = 0;
  @property({ type: Number }) alertId = 0;
  @property({ type: Boolean }) compact = false;
  @property({ type: Boolean }) allowClose = false;
  @state() private data: any = null;
  @state() private error = "";
  @state() private busy = false;
  private generation = 0;
  static styles = [
    sharedBtnStyles,
    css`
      :host {
        display: block;
        min-width: 0;
        color: var(--text);
      }
      dl {
        display: grid;
        grid-template-columns: 110px minmax(0, 1fr);
        gap: var(--space-sm);
      }
      dt {
        color: var(--muted);
      }
      dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      a {
        color: var(--accent);
      }
      .error {
        color: var(--danger);
      }
      .scroll {
        overflow: auto;
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      h4 {
        margin: var(--space-lg) 0 var(--space-sm);
      }
      .event-overview { display:grid; gap:var(--space-sm); border-top:1px solid var(--border); margin-top:var(--space-md); padding-top:var(--space-md); }
      .event-overview p { margin:0; overflow-wrap:anywhere; }
      .event-overview-actions { display:flex; align-items:center; flex-wrap:wrap; gap:var(--space-sm) var(--space-md); padding-block:var(--space-xs); }
      .event-evidence > summary { cursor:pointer; color:var(--accent-text); }
    `,
  ];
  protected updated(changes: Map<string, unknown>) {
    if (changes.has("eventId") || changes.has("alertId")) void this.load();
  }
  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }
  private openingRule(data: any) {
    const episode = data?.episode;
    return data?.snapshot?.configuration?.rules?.find((rule: any) => rule.rule_id === episode?.rule_id
      && (!this.alertId || rule.version === episode.version && rule.scope === episode.scope && rule.body_hash === episode.body_hash));
  }
  private async load(ack = false) {
    const id = this.eventId,
      alertId = this.alertId,
      g = ++this.generation;
    if (!id) return;
    this.busy = true;
    this.error = "";
    this.data = null;
    try {
      const data = await metricRequest<any>(
        `template-events/${id}${ack ? "/acknowledge" : ""}`,
        ack ? {} : undefined,
      );
      // Event facts are optional on legacy events; a successful but incompatible
      // response is unavailable evidence, never a render-time exception.
      const rule = this.openingRule(data);
      if (!data?.episode?.last || !rule?.item || !data.snapshot.configuration.templates?.some((v: any) => v.template_id === rule.item.template_id))
        throw new Error('EVENT_EVIDENCE_INVALID');
      if (alertId && (Number(data.event_id) !== id || Number(data.alert_id) !== alertId))
        throw new Error('EVENT_EVIDENCE_INVALID');
      if (g === this.generation) this.data = data;
    } catch (e) {
      if (g === this.generation && (alertId || !(e instanceof MetricRequestError && e.status === 404)))
        this.error = alertId ? '暂不可读取告警发生时的触发器。' : metricError(e);
    } finally {
      if (g === this.generation) this.busy = false;
    }
  }
  render() {
    const d = this.data;
    if (this.alertId && !d) return this.busy ? html`<span role="status">正在读取规则来源…</span>`
      : this.error ? html`<span role="alert" class="error">${this.error}</span>
        <button class="btn btn-refresh" @click=${() => this.load()}>重试读取规则来源</button>` : nothing;
    if (!d) {
      if (this.error) return html`<p role="alert" class="error">${this.error}</p>`;
      return this.compact ? html`<p role="status">${this.busy ? '正在读取监控恢复证据…' : '当前无法确认监控恢复证据。'}</p>` : nothing;
    }
    const e = d.episode,
      s = d.snapshot.configuration,
      r = this.openingRule(d),
      p = s.templates.find((v: any) => v.template_id === r.item.template_id);
    const operands = new Map<string, string>([r, ...(r.inputs ?? [])].map(input =>
      [input.item.item_id, metricDisplayName(input.metric.id)]));
    if (this.alertId) return html`
      <span>模板 ${r.item.template_id} v${p.version} · 触发器 ${r.rule_id} v${r.version}</span>
      <details class="event-evidence">
        <summary>查看触发器</summary>
        <dl>
          <dt>发生时配置</dt><dd>r${s.config_revision}</dd>
          <dt>指标</dt><dd>${metricDisplayName(r.metric.id)} · ${r.unit}</dd>
          <dt>触发条件</dt><dd>${condition(r.problem, operands)}</dd>
        </dl>
        <pre>${JSON.stringify(r, null, 2)}</pre>
      </details>`;
    const resourceUrl = `/?tab=${e.resource.type === "instance" ? "instance-detail" : e.resource.type === "server" ? "server-detail" : "network-device-detail"}&${e.resource.type === "network_device" ? "networkDeviceId" : "id"}=${e.resource.id}`;
    const evidenceQuality = e.last.quality === 'unknown' ? '证据未知' : e.last.quality === 'partial' ? '部分证据有效' : '证据有效';
    const manuallyClosed = e.state === 'closed' && !!e.manual_close;
    const recovered = e.state === 'closed' && !manuallyClosed && Number.isFinite(Date.parse(e.closed_at));
    const mode = (r.recovery_mode ?? 'recovery_expression') as TriggerRecoveryMode;
    const recoveryLabel = manuallyClosed ? '已手动关闭' : recovered ? '本次阈值已恢复' : mode === 'none' ? '事件保持打开' : '尚无恢复记录';
    const closeButton = this.allowClose && d.can_manual_close === true ? html`
      <template-event-close .eventId=${this.eventId} .disabled=${this.busy}
        @template-event-closed=${async (event: CustomEvent) => {
          this.data = event.detail;
          await this.updateComplete;
          this.renderRoot.querySelector<HTMLElement>('[data-event-summary]')?.focus();
        }}></template-event-close>` : nothing;
    const facts = html`<h4 tabindex="-1" ?data-event-summary=${!this.compact}>模板事件事实</h4>
      <dl>
        <dt>本次阈值记录</dt>
        <dd>${recoveryLabel} · ${evidenceQuality}（${e.last.reason}）</dd>
        <dt>Episode</dt>
        <dd>${e.episode_id}</dd>
        <dt>指标 / 单位</dt>
        <dd>${r.metric.id}@${r.metric.semantic_version} / ${r.unit}</dd>
        <dt>发生时值 / 判定时间</dt>
        <dd>${e.opened.value ?? "未知"} / ${e.opened.at}</dd>
        <dt>本次末次值 / 判定时间</dt>
        <dd>${e.last.value ?? "未知"} / ${e.last.at}</dd>
        <dt>问题条件</dt>
        <dd>${condition(r.problem, operands)}</dd>
        <dt>恢复方式</dt>
        <dd>${triggerRecoveryModes[mode]}</dd>
        <dt>允许手动关闭</dt>
        <dd>${r.allow_manual_close === true ? '是' : '否'}</dd>
        ${mode === 'recovery_expression' ? html`<dt>独立恢复条件</dt>
          <dd>${condition(r.recovery, operands)}</dd>` : nothing}
        <dt>窗口覆盖</dt>
        <dd>最低 ${r.quality.min_coverage * 100}%</dd>
        <dt>阈值来源</dt>
        <dd>
          ${r.parameters.map((v: any) => `${v.name}=${v.value}（${v.source === "default" ? "模板默认" : "资源覆盖"}）`).join("、") || "固定值"}
        </dd>
        <dt>发生时版本</dt>
        <dd>
          配置 r${s.config_revision} · 模板 ${r.item.template_id} v${p.version} · 规则 v${r.version}
          · 监控项 v${r.item.item_version}
        </dd>
        <dt>正式样本身份</dt>
        <dd>${d.snapshot.opening.sample_ids.join("、") || "缺测时钟，无新样本"}</dd>
        <dt>源样本值 / 时间</dt>
        <dd>
          ${(d.snapshot.opening.samples ?? []).map((v: any) => `${r.inputs && v.metric ? `${metricDisplayName(v.metric.id)} · ` : ''}${v.id} · ${v.value.value} ${v.unit} · ${v.observed_at}`).join("；") || "缺测时钟，无数值样本"}
        </dd>
        <dt>采集尝试身份</dt>
        <dd>${d.snapshot.opening.attempt_ids.join("、") || "无"}</dd>
        <dt>恢复次数 / 时间</dt>
        <dd>${e.recovery_count} / ${recovered ? e.closed_at : "尚未恢复"}</dd>
        ${manuallyClosed ? html`<dt>手动关闭</dt><dd>${displayTime(e.closed_at)} · 操作者 #${e.manual_close.actor_id}</dd>` : nothing}
        <dt>未知区段</dt>
        <dd>
          ${e.unknown_segments.map((v: any) => `${v.from} → ${v.to ?? "持续"}（${v.reason}）`).join("；") || "无"}
        </dd>
        <dt>当前评估</dt>
        <dd>${d.evaluation?.state === 'stopped' ? '停止评估：没有有效指标提供者，原问题事实和恢复状态保留' : d.evaluation?.state === 'active' ? '当前提供者有效' : '当前评估状态待确认'}</dd>
        <dt>资源现时健康</dt>
        <dd>待核对，请查看当前资源。</dd>
        <dt>处理状态</dt>
        <dd>${({ open:'开放', investigating:'调查中', handled:'已处理', resolved:'已解决', closed:'已关闭' } as Record<string,string>)[d.processing.status] ?? '未知'} · 处理确认与指标恢复分别记录</dd>
      </dl>
      <details>
        <summary>查看当时规则版本</summary>
        <pre>${JSON.stringify(r, null, 2)}</pre>
      </details>
      ${this.compact ? nothing : html`<a href=${resourceUrl}>查看当前资源配置（r${d.current?.revision ?? '未知'}）</a>`}
      <p>
        <button
          class="btn"
          ?disabled=${this.busy || Boolean(d.processing.acknowledged_at)}
          @click=${() => this.load(true)}
        >
          确认处理
        </button>
        ${this.compact ? nothing : closeButton}
        <button class="btn btn-refresh" ?disabled=${this.busy} @click=${() => this.load()}>
          刷新
        </button>
      </p>
      <h4>通知投递与回执</h4>
      <div class="scroll">
        <app-data-table
          .columns=${[
            { key: "channel_id", label: "渠道引用" },
            { key: "job_id", label: "投递任务" },
            { key: "state", label: "投递状态" },
            { key: "updated_at", label: "状态时间" },
            { key: "attempt_id", label: "尝试身份" },
            { key: "error_code", label: "错误码" },
          ]}
          .rows=${d.deliveries.map((v: any) => ({ ...v, state: v.state ?? v.job_state, error_code: v.error_code ?? "—" }))}
        ></app-data-table>
      </div>
      <p>
        ${d.receipts.length ? d.receipts.map((v: any) => `回执 ${v.id} · 渠道 ${v.channel_id} · ${v.status} · ${v.sent_at ?? "未送达"}`).join("；") : "尚无送达回执；排队不表示外部送达。"}
      </p>
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}`;
    if (!this.compact) return facts;
    return html`<div class="event-overview">
      <p tabindex="-1" data-event-summary><strong>历史监控</strong> <app-badge variant=${manuallyClosed ? 'muted' : recovered ? 'ok' : 'warn'}>${recoveryLabel}</app-badge> · ${evidenceQuality}</p>
      <p><strong>指标</strong> ${metricDisplayName(r.metric.id)} · ${r.unit}</p>
      <p>触发 ${displayTime(e.opened.at)} · ${e.opened.value ?? '未知'} ${r.unit}
        ${recovered ? html`　恢复 ${displayTime(e.closed_at)} · ${e.last.value ?? '未知'} ${r.unit}` : nothing}
        ${manuallyClosed ? html`　关闭 ${displayTime(e.closed_at)}` : nothing}</p>
      <p>${d.evaluation?.state === 'stopped' ? '当前已停止评估，' : ''}资源现时健康待确认。</p>
      <div class="event-overview-actions"><a class="btn-primary" href=${resourceUrl}>查看当前资源</a>${closeButton}</div>
    </div>
    <details class="event-evidence"><summary>查看触发与恢复证据</summary>${facts}</details>`;
  }
}
