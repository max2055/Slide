import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import "../components/app-card.js";
import "../components/app-badge.js";
import "../components/app-data-table.js";
import "../components/app-dialog.js";
import "../components/app-empty-state.js";

interface LogGroup {
  count?: number;
  failures?: number;
  lastObservedAt?: string;
}
interface Evidence {
  quality?: string;
  gaps?: string[];
  groups?: LogGroup[];
  generatedAt?: string;
  persistence?: string;
  types?: unknown[];
}
interface ComponentEvidence extends Evidence {
  component: string;
}
interface Observations {
  schemaVersion?: number;
  generatedAt?: string;
  releaseId?: string | null;
  commitSha?: string | null;
  uptimeSeconds?: number;
  components?: ComponentEvidence[];
  logs?: Evidence;
  queue?: { quality?: string; generatedAt?: string; gaps?: string[]; types?: unknown[] };
}
const COMPONENT_LABELS: Record<string, string> = {
  api: "API 服务",
  agent: "Agent 运行时",
  ws: "WebSocket",
  collector: "采集器",
  queue: "任务队列",
  frontend: "前端运行时",
};
const GAP_LABELS: Record<string, string> = {
  LOG_EVIDENCE_MISSING: "当前窗口无日志信号",
  LOG_WINDOW_PRECEDES_PROCESS: "查询窗口早于进程启动，证据不完整",
  LOG_BUFFER_TRUNCATED: "日志缓冲已截断",
  LOG_GROUPS_TRUNCATED: "日志分类已截断",
  LOG_STATUS_UNKNOWN: "部分日志状态未知",
  LOG_EVIDENCE_STALE: "日志证据已过期",
  QUEUE_STORE_UNAVAILABLE: "队列存储暂不可读取",
};
const time = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN") : "未知";
const validCount = (value?: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

@customElement("platform-observations-page")
export class PlatformObservationsPage extends LitElement {
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private details: Observations | null = null;
  @state() private readAt: string | null = null;
  @state() private selected: string | null = null;
  @state() private denied = false;
  @state() private page = 0;
  private requestId = 0;
  private permissionsChanged = (event: Event) => {
    const permissions = (event as CustomEvent<{ permissions?: string[] }>).detail?.permissions;
    if (
      !Array.isArray(permissions) ||
      !permissions.some((p) => ["*", "config:*", "config:view"].includes(p))
    )
      this.invalidate("权限已撤回，观测证据已清理。");
    else if (this.denied) {
      this.denied = false;
      void this.load();
    }
  };
  private expired = () => this.invalidate("会话已失效，观测证据已清理。");

  static styles = [
    sharedBtnStyles,
    css`
      :host {
        display: block;
        max-width: 1200px;
        min-width: 0;
        color: var(--text);
        font-size: 14px;
      }
      * {
        box-sizing: border-box;
      }
      .page-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-md);
        margin-bottom: var(--space-xl);
      }
      h1 {
        margin: 0 0 var(--space-xs);
        color: var(--text-strong);
        font-size: 24px;
        line-height: 1.35;
      }
      h2 {
        margin: 0;
        font-size: 16px;
        color: var(--text-strong);
      }
      p {
        margin: var(--space-xs) 0 0;
        line-height: 1.6;
      }
      .caption {
        color: var(--muted);
        font-size: 12px;
      }
      .status-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--space-lg);
        margin-bottom: var(--space-xl);
      }
      .status-block {
        min-width: 0;
        border-right: 1px solid var(--border);
        padding-right: var(--space-lg);
      }
      .status-block:last-child {
        border: 0;
      }
      .entity {
        display: block;
        margin: var(--space-sm) 0;
        color: var(--text-strong);
        font-size: 17px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .notice {
        border-left: 3px solid var(--warn);
        background: var(--warn-subtle);
        padding: var(--space-md) var(--space-lg);
        border-radius: var(--radius-sm);
        margin-bottom: var(--space-lg);
        font-size: 12px;
        line-height: 1.7;
      }
      .notice strong {
        display: block;
        font-size: 14px;
        color: var(--text-strong);
      }
      .table-scroll {
        overflow: auto;
        max-width: 100%;
      }
      .table-scroll:focus-visible,
      summary:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      app-card::part(footer) {
        display: none;
      }
      app-data-table {
        min-width: 650px;
      }
      .table-scroll .data-table {
        table-layout: fixed;
      }
      .table-scroll .data-table td {
        overflow-wrap: anywhere;
        vertical-align: middle;
        font-size: 14px;
      }
      .link {
        color: var(--accent-text);
      }
      .section-title {
        margin-bottom: var(--space-md);
      }
      .pagination {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-sm);
        padding: var(--space-md);
        font-size: 12px;
      }
      .page-actions {
        display: flex;
        align-items: center;
        gap: var(--space-sm);
      }
      .definition {
        margin: 0 0 var(--space-lg);
      }
      .definition > div {
        display: grid;
        grid-template-columns: 110px minmax(0, 1fr);
        gap: var(--space-md);
        padding: var(--space-sm) 0;
        border-bottom: 1px solid var(--border);
      }
      dt {
        color: var(--muted);
        font-size: 12px;
      }
      dd {
        margin: 0;
      }
      dd,
      .caption,
      .entity {
        overflow-wrap: anywhere;
      }
      pre {
        margin-top: var(--space-md);
        background: var(--bg-accent);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-md);
        max-width: 100%;
        max-height: 320px;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font: 12px/1.7 var(--mono);
      }
      summary {
        cursor: pointer;
        color: var(--text-strong);
      }
      .state {
        padding: var(--space-xl) 0;
      }
      @media (max-width: 850px) {
        .status-grid {
          grid-template-columns: minmax(0, 1fr);
        }
        .status-block {
          border-right: 0;
          border-bottom: 1px solid var(--border);
          padding: 0 0 var(--space-md);
        }
      }
      @media (max-width: 600px) {
        h1 {
          font-size: 22px;
        }
        .page-header {
          flex-wrap: wrap;
        }
        .definition > div {
          grid-template-columns: minmax(0, 1fr);
          gap: var(--space-xs);
        }
      }
    `,
  ];

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("slide-permissions-loaded", this.permissionsChanged);
    window.addEventListener("slide-session-expired", this.expired);
    void this.load();
  }
  override disconnectedCallback() {
    this.requestId++;
    this.details = null;
    this.selected = null;
    this.readAt = null;
    window.removeEventListener("slide-permissions-loaded", this.permissionsChanged);
    window.removeEventListener("slide-session-expired", this.expired);
    super.disconnectedCallback();
  }
  private invalidate(message: string) {
    this.requestId++;
    this.details = null;
    this.selected = null;
    this.readAt = null;
    this.loading = false;
    this.denied = true;
    this.error = message;
  }
  private async load() {
    if (this.denied) return;
    const id = ++this.requestId;
    this.loading = true;
    this.error = null;
    this.details = null;
    this.selected = null;
    this.readAt = null;
    this.page = 0;
    try {
      const response = await authFetch("/api/platform/observations");
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          if (id === this.requestId) this.invalidate("无权读取平台观测，证据已清理。");
          return;
        }
        throw new Error(`读取失败（HTTP ${response.status}），无法判断当前平台状态。`);
      }
      const data: Observations = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data) || data.schemaVersion !== 1)
        throw new Error("观测响应不完整，无法读取证据。");
      if (id !== this.requestId) return;
      this.details = data;
      this.readAt = new Date().toISOString();
    } catch (error) {
      if (id === this.requestId)
        this.error = error instanceof Error ? error.message : "读取失败，请重试。";
    } finally {
      if (id === this.requestId) this.loading = false;
    }
  }
  private evidenceState(evidence?: Evidence) {
    if (!evidence) return { label: "未知", variant: "muted", description: "接口未提供证据" };
    const gaps = evidence.gaps ?? [];
    const groups = evidence.groups ?? [];
    if (gaps.includes("LOG_EVIDENCE_STALE"))
      return { label: "已过期", variant: "warn", description: "已有信号超过有效窗口" };
    if (groups.some((g) => validCount(g.failures) && g.failures! > 0))
      return { label: "有失败信号", variant: "danger", description: "请核对日志与关联标识" };
    if (gaps.includes("LOG_EVIDENCE_MISSING") || (Array.isArray(evidence.groups) && !groups.length))
      return { label: "无信号", variant: "muted", description: "当前窗口未取得信号，不能判断健康" };
    if (evidence.quality === "degraded" || gaps.length)
      return { label: "部分证据", variant: "warn", description: "证据存在缺口，请查看详情" };
    if (evidence.quality === "good" && Array.isArray(evidence.types))
      return {
        label: "已读取",
        variant: "info",
        description: `已读取 ${evidence.types.length} 类队列存储快照，不代表日志覆盖完整`,
      };
    if (evidence.quality === "good" && groups.length)
      return { label: "有观测", variant: "info", description: "已取得运行信号，不等于整体健康" };
    return { label: "未知", variant: "muted", description: "尚无足够证据判断状态" };
  }
  private get components() {
    return this.details?.components ?? [];
  }
  private latestLogTime(evidence: Array<Evidence | undefined>) {
    const values = evidence
      .flatMap((e) => e?.groups ?? [])
      .map((g) => g.lastObservedAt)
      .filter((v): v is string => !!v && Number.isFinite(Date.parse(v)));
    return values.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  }
  private get lastObservedAt() {
    return this.latestLogTime([this.details?.logs, ...this.components]);
  }
  private get coverage() {
    const available = this.components.filter(
      (c) => (c.groups ?? []).length > 0 && c.quality === "good" && !c.gaps?.length,
    );
    const hasSignal = this.components.some((c) => (c.groups ?? []).length > 0);
    return {
      label: !this.components.length
        ? "未知"
        : available.length === this.components.length
          ? "已取得信号"
          : hasSignal
            ? "部分可用"
            : "尚无信号",
      count: available.length,
    };
  }
  private openEvidence(key: string) {
    this.selected = key;
  }
  private renderDialog() {
    const d = this.details;
    if (!d || this.selected === null) return nothing;
    const component = this.selected.startsWith("component:")
      ? this.components[Number(this.selected.slice(10))]
      : undefined;
    const title = component
      ? (COMPONENT_LABELS[component.component] ?? component.component)
      : this.selected === "release"
        ? "版本与部署缺口"
        : this.selected === "queue"
          ? "队列存储证据"
          : "结构化日志证据";
    const evidence =
      component ??
      (this.selected === "release"
        ? { releaseId: d.releaseId, commitSha: d.commitSha, uptimeSeconds: d.uptimeSeconds }
        : this.selected === "queue"
          ? d.queue
          : d.logs);
    const gaps =
      component?.gaps ??
      (this.selected === "queue"
        ? d.queue?.gaps
        : this.selected === "logs"
          ? d.logs?.gaps
          : undefined);
    return html`<app-dialog
      .open=${true}
      size="lg"
      .title=${title}
      @app-dialog-close=${() => {
        this.selected = null;
      }}
    >
      <dl class="definition">
        <div>
          <dt>最近日志观测</dt>
          <dd>
            ${time(this.latestLogTime(component ? [component] : this.selected === "logs" ? [d.logs] : [d.logs, ...this.components]))}
          </dd>
        </div>
        <div>
          <dt>响应生成时间</dt>
          <dd>${time(d.generatedAt)}</dd>
        </div>
        <div>
          <dt>页面读取时间</dt>
          <dd>${time(this.readAt)}</dd>
        </div>
        <div>
          <dt>限制</dt>
          <dd>
            信号和自检通过均不能证明平台整体健康。部署一致性未知；接口未提供部署清单与采集开关，不能确认未开启。
          </dd>
        </div>
      </dl>
      ${
        gaps?.length
          ? html`<h2>证据缺口</h2>
              <ul>
                ${gaps.map((g) => html`<li>${GAP_LABELS[g] ?? "未识别的证据缺口"} <code>${g}</code></li>`)}
              </ul>`
          : nothing
      }
      <details>
        <summary>原始证据与版本标识</summary>
        <pre>
${JSON.stringify({ generatedAt: d.generatedAt, readAt: this.readAt, evidence: evidence ?? null }, null, 2)}</pre>
      </details>
      <button
        slot="footer"
        class="btn"
        @click=${() => {
          this.selected = null;
        }}
      >
        关闭
      </button>
    </app-dialog>`;
  }
  override render() {
    const d = this.details;
    const rows = d
      ? [
          ...this.components.map((c, i) => {
            const s = this.evidenceState(c);
            return {
              name: COMPONENT_LABELS[c.component] ?? c.component,
              state: html`<app-badge variant=${s.variant}>${s.label}</app-badge>`,
              description: s.description,
              action: html`<button
                class="btn-ghost link"
                @click=${() => this.openEvidence(`component:${i}`)}
              >
                查看详情
              </button>`,
            };
          }),
          ...[
            ["logs", "结构化日志", d.logs],
            ["queue", "队列存储", d.queue],
          ].map(([key, label, value]) => {
            const e = value as Evidence | undefined;
            const s = this.evidenceState(e);
            return {
              name: label,
              state: html`<app-badge variant=${s.variant}>${s.label}</app-badge>`,
              description:
                key === "logs" && e?.persistence === "process-local"
                  ? "仅当前进程内保留，重启不保留日志"
                  : s.description,
              action: html`<button
                class="btn-ghost link"
                @click=${() => this.openEvidence(key as string)}
              >
                查看详情
              </button>`,
            };
          }),
          {
            name: "版本与部署",
            state: html`<app-badge variant="muted">未知</app-badge>`,
            description: html`运行
            ${validCount(d.uptimeSeconds) ? `${d.uptimeSeconds} 秒` : "时长未知"}；部署一致性尚无法确认`,
            action: html`<button
              class="btn-ghost link"
              @click=${() => this.openEvidence("release")}
            >
              查看缺口
            </button>`,
          },
        ]
      : [];
    return html`<header class="page-header">
        <div>
          <h1>平台观测</h1>
          <p class="caption">先核对运行信号与证据缺口；平台自检另行展示一致性检查。</p>
        </div>
        <button class="btn" @click=${this.load} ?disabled=${this.loading || this.denied}>
          ${this.loading ? "读取中…" : "刷新"}
        </button>
      </header>
      ${
        this.loading
          ? html`<p class="state" role="status">正在读取平台观测…</p>`
          : this.error
            ? html`<div class="notice" role="alert">
                <strong>${this.error}</strong
                >${this.denied ? "请重新登录或联系管理员核对权限。" : html`<button class="btn" @click=${this.load}>重试</button>`}
              </div>`
            : d
              ? html` <section class="status-grid" aria-label="平台观测摘要">
                    <div class="status-block">
                      <span class="caption">信号覆盖</span
                      ><strong class="entity">${this.coverage.label}</strong
                      ><span class="caption"
                        >${this.components.length ? `${this.components.length} 类运行信号中，${this.coverage.count} 类证据完整` : "接口未提供组件覆盖数据"}</span
                      >
                    </div>
                    <div class="status-block">
                      <span class="caption">最近日志观测</span
                      ><strong class="entity">${time(this.lastObservedAt)}</strong
                      ><span class="caption">页面读取于 ${time(this.readAt)}</span>
                    </div>
                    <div class="status-block">
                      <span class="caption">部署一致性</span><strong class="entity">未知</strong
                      ><span class="caption">缺少运行部署清单，无法比较版本</span>
                    </div>
                  </section>
                  <div class="notice">
                    <strong>尚不能判断平台整体健康</strong
                    >仅展示当前响应中的运行证据。采集是否开启未知；未开启、无信号与读取失败不能等同。响应生成于
                    ${time(d.generatedAt)}。
                  </div>
                  <h2 class="section-title">可用信号与证据</h2>
                  <app-card .compact=${true}
                    ><div
                      class="table-scroll"
                      tabindex="0"
                      role="region"
                      aria-label="平台观测证据，可横向滚动"
                    >
                      <app-data-table
                        .striped=${false}
                        .columns=${[
                          { key: "name", label: "观测类别", width: "25%" },
                          { key: "state", label: "当前状态", width: "20%" },
                          { key: "description", label: "说明", width: "37%" },
                          { key: "action", label: "证据", width: "18%" },
                        ]}
                        .rows=${rows.slice(this.page * 6, (this.page + 1) * 6)}
                      ></app-data-table>
                    </div>
                    <div class="pagination">
                      <span>共 ${rows.length} 类 · 每页 6 类</span>
                      <div class="page-actions">
                        <button
                          class="btn"
                          ?disabled=${this.page === 0}
                          @click=${() => {
                            this.page--;
                          }}
                        >
                          上一页</button
                        ><span>第 ${this.page + 1} / ${Math.ceil(rows.length / 6)} 页</span
                        ><button
                          class="btn"
                          ?disabled=${(this.page + 1) * 6 >= rows.length}
                          @click=${() => {
                            this.page++;
                          }}
                        >
                          下一页
                        </button>
                      </div>
                    </div></app-card
                  >${!this.components.length ? html`<p class="caption">尚无组件观测，不能据此判断无异常。</p>` : nothing}${this.renderDialog()}`
              : html`<app-empty-state
                  title="尚无观测响应"
                  description="没有证据不能判断健康。"
                ></app-empty-state>`
      }`;
  }
}
if (!customElements.get("platform-observations"))
  customElements.define("platform-observations", class extends PlatformObservationsPage {});
