import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import { metricRequest, metricError, MetricRequestError } from "./metric-api.js";
import "./app-data-table.js";
const condition = (n: any): string =>
  n?.node === "compare"
    ? `${n.select.aggregation}${n.select.window_ms ? `(${n.select.window_ms / 1000}秒)` : ""} ${n.operator} ${n.threshold.value ?? n.threshold.name}`
    : `(${n?.children?.map(condition).join(n.node === "all" ? " 且 " : " 或 ") ?? "未知"})`;
@customElement("template-event-evidence")
export class TemplateEventEvidence extends LitElement {
  @property({ type: Number }) eventId = 0;
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
    `,
  ];
  protected updated(changes: Map<string, unknown>) {
    if (changes.has("eventId")) void this.load();
  }
  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }
  private async load(ack = false) {
    const id = this.eventId,
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
      if (g === this.generation) this.data = data;
    } catch (e) {
      if (g === this.generation && !(e instanceof MetricRequestError && e.status === 404))
        this.error = metricError(e);
    } finally {
      if (g === this.generation) this.busy = false;
    }
  }
  render() {
    const d = this.data;
    if (!d) return this.error ? html`<p role="alert" class="error">${this.error}</p>` : nothing;
    const e = d.episode,
      s = d.snapshot.configuration,
      r = s.rules.find((v: any) => v.rule_id === e.rule_id),
      p = s.templates.find((v: any) => v.template_id === r.item.template_id);
    return html`<h4>模板事件事实</h4>
      <dl>
        <dt>业务状态</dt>
        <dd>
          ${e.state === "open" ? "问题持续" : "已恢复"} ·
          证据${e.last.quality === "unknown" ? "未知" : e.last.quality === "partial" ? "部分有效" : "有效"}（${e.last.reason}）
        </dd>
        <dt>Episode</dt>
        <dd>${e.episode_id}</dd>
        <dt>指标 / 单位</dt>
        <dd>${r.metric.id}@${r.metric.semantic_version} / ${r.unit}</dd>
        <dt>发生时值 / 判定时间</dt>
        <dd>${e.opened.value ?? "未知"} / ${e.opened.at}</dd>
        <dt>最新值 / 判定时间</dt>
        <dd>${e.last.value ?? "未知"} / ${e.last.at}</dd>
        <dt>问题条件</dt>
        <dd>${condition(r.problem)}</dd>
        <dt>独立恢复条件</dt>
        <dd>${condition(r.recovery)}</dd>
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
          ${(d.snapshot.opening.samples ?? []).map((v: any) => `${v.id} · ${v.value.value} ${v.unit} · ${v.observed_at}`).join("；") || "缺测时钟，无数值样本"}
        </dd>
        <dt>采集尝试身份</dt>
        <dd>${d.snapshot.opening.attempt_ids.join("、") || "无"}</dd>
        <dt>恢复次数 / 时间</dt>
        <dd>${e.recovery_count} / ${e.closed_at ?? "尚未恢复"}</dd>
        <dt>未知区段</dt>
        <dd>
          ${e.unknown_segments.map((v: any) => `${v.from} → ${v.to ?? "持续"}（${v.reason}）`).join("；") || "无"}
        </dd>
        <dt>处理状态</dt>
        <dd>${d.processing.status} · 确认不表示恢复，不执行运维操作</dd>
      </dl>
      <details>
        <summary>查看当时规则版本</summary>
        <pre>${JSON.stringify(r, null, 2)}</pre>
      </details>
      <a
        href=${`/?tab=${e.resource.type === "instance" ? "instance-detail" : e.resource.type === "server" ? "server-detail" : "network-device-detail"}&${e.resource.type === "network_device" ? "networkDeviceId" : "id"}=${e.resource.id}`}
        >查看当前资源配置（r${d.current?.revision ?? "未知"}）</a
      >
      <p>
        <button
          class="btn"
          ?disabled=${this.busy || Boolean(d.processing.acknowledged_at)}
          @click=${() => this.load(true)}
        >
          确认处理
        </button>
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
  }
}
