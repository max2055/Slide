import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  MetricBulkResult,
  MetricBulkList,
  MetricBulkPreview,
} from "../../../api/generated/public-api.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import { collectionLayoutStyles } from "./collection-layout-styles.js";
import { metricError, metricRequest, statusLabel, type Pin } from "./metric-api.js";
import type { BulkResource } from "./metric-bulk-selection.js";
import { numericFields, type NumberKey, type Overrides } from "./metric-policy-fields.js";
import { metricName, packageName } from "./resource-metric-summary.js";
import "./app-dialog.js";
import "./app-card.js";
import "./app-badge.js";
import "./app-data-table.js";
import "./app-form-field.js";

type Item = MetricBulkResult["items"][number];
const resourceKey = (ref: { type: string; id: number }) => `${ref.type}:${ref.id}`;
const stateLabel: Record<string, string> = {
  eligible: "可匹配",
  unsupported: "不支持 / 能力未确认",
  skipped: "已跳过",
  queued: "排队中",
  running: "检查与试采中",
  succeeded: "正式就绪",
  pending_takeover: "配置已发布 · 待正式就绪",
  failed: "失败",
  cancelled: "已取消",
};
const fieldLabel = (key: string) =>
  ({ package: "采集模板", enabled: "策略开关", metrics: "单项指标覆盖", ...numericFields })[key] ??
  key;
const overrideValue = (key: string, value: unknown): string => {
  if (value === undefined || value === "inherit") return "继承";
  if (value === "enable") return "启用";
  if (value === "disable") return "停用";
  if (value && typeof value === "object" && "mode" in value) {
    if (value.mode === "inherit") return "继承";
    if ("value" in value && typeof value.value === "number")
      return String(value.value / (key.endsWith("_ms") ? 1000 : 1));
  }
  return "待确认";
};
const codes: Record<string, string> = {
  BULK_NO_COMPATIBLE_PACKAGE: "没有兼容模板，保留当前设置",
  BULK_CAPABILITY_UNKNOWN: "引擎、版本或能力未知，保留当前设置",
  POLICY_FORBIDDEN: "没有此对象的管理权限",
  POLICY_REVISION_CONFLICT: "配置或继承策略已变化，请重新预览",
  POLICY_PACKAGE_SWITCH_ID: "当前绑定不支持直接替换模板系列，请单独配置",
  CONFIGURATION_TRIAL_FAILED: "试采未通过，未发布配置",
  BULK_CANCELLED: "已停止未发布操作；已发布配置保留",
  POLICY_RESOURCE_NOT_FOUND: "资源不存在",
  BULK_STATUS_UNAVAILABLE: "已发布，正式状态暂不可读取",
  POLICY_REVISION_CHANGED: "资源已有后续配置，请查看当前详情",
  BULK_OPERATION_FAILED: "操作失败，未确认发布",
  BULK_PREVIEW_EXPIRED: "预览已过期，请重新匹配",
  BULK_QUEUE_LIMIT: "批量任务已达上限，请等待已有任务完成",
};
const reason = (item: Item) =>
  item.code
    ? (codes[item.code] ?? "暂时无法完成，请重新检查此对象")
    : item.status?.blockers.length
      ? item.status.blockers.map(statusLabel).join("；")
      : item.state === "pending_takeover"
        ? "等待正式采集证据"
        : "";
function result(data: MetricBulkResult): MetricBulkResult {
  if (
    !data ||
    typeof data.id !== "string" ||
    !["draft", "queued", "running", "completed", "cancelled"].includes(data.state) ||
    !Array.isArray(data.items) ||
    !data.items.every((i) => i.resource && stateLabel[i.state] && Array.isArray(i.choices))
  )
    throw new Error("BULK_CONTRACT");
  return data;
}

@customElement("metric-bulk-dialog")
export class MetricBulkDialog extends LitElement {
  @property({ attribute: false }) resources: BulkResource[] = [];
  @state() private open = false;
  @state() private job: MetricBulkResult | null = null;
  @state() private step = 0;
  @state() private busy = false;
  @state() private dirty = false;
  @state() private error = "";
  @state() private history: MetricBulkList["jobs"] = [];
  @state() private historyError = "";
  @state() private overrides: Overrides = {};
  private selections = new Map<string, Pin>();
  private generation = 0;
  private poll?: ReturnType<typeof setTimeout>;
  private polls = 0;
  private submissionKey = "";
  private retryKey = "";
  private readonly accessChanged = () => {
    this.generation++;
    clearTimeout(this.poll);
    this.job = null;
    this.history = [];
    this.resources = [];
    this.busy = false;
    this.selections.clear();
    this.error = "权限或登录状态已变更，请关闭后重新选择资源";
  };
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("slide-permissions-loaded", this.accessChanged);
    window.addEventListener("slide-session-expired", this.accessChanged);
  }
  override disconnectedCallback() {
    this.generation++;
    clearTimeout(this.poll);
    window.removeEventListener("slide-permissions-loaded", this.accessChanged);
    window.removeEventListener("slide-session-expired", this.accessChanged);
    super.disconnectedCallback();
  }
  override updated(changed: PropertyValues) {
    if (changed.has("step")) {
      const body = this.renderRoot
        .querySelector("app-dialog")
        ?.shadowRoot?.querySelector(".dialog-body");
      if (body) body.scrollTop = 0;
    }
  }
  show(resources: BulkResource[]) {
    this.generation++;
    clearTimeout(this.poll);
    this.resources = resources;
    this.open = true;
    this.job = null;
    this.step = 0;
    this.overrides = {};
    this.selections.clear();
    this.dirty = false;
    this.submissionKey = "";
    this.retryKey = "";
    this.polls = 0;
    if (resources.length) void this.start().finally(() => this.loadHistory());
    else void this.loadHistory();
  }
  private close() {
    this.generation++;
    clearTimeout(this.poll);
    this.open = false;
    this.busy = false;
  }
  private async loadHistory() {
    const generation = this.generation;
    this.historyError = "";
    try {
      const data = await metricRequest<MetricBulkList>("config/bulk");
      if (generation === this.generation) this.history = data.jobs;
    } catch {
      if (generation === this.generation) this.historyError = "历史任务暂不可读取";
    }
  }
  private describe(error: unknown) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return codes[code] ?? metricError(error);
  }
  async start() {
    if (this.busy || !this.resources.length) return;
    const generation = ++this.generation;
    this.busy = true;
    this.error = "";
    clearTimeout(this.poll);
    this.submissionKey ||= crypto.randomUUID();
    const packages = [...this.selections]
      .map(([key, pack]) => ({
        resources: this.resources
          .filter((r) => resourceKey(r) === key)
          .map(({ type, id }) => ({ type, id })),
        package: pack,
      }))
      .filter((g) => g.resources.length);
    const input: MetricBulkPreview = {
      key: this.submissionKey,
      resources: this.resources.map(({ type, id }) => ({ type, id })),
      overrides: this.overrides,
      ...(packages.length ? { packages } : {}),
    };
    try {
      const data = result(await metricRequest<MetricBulkResult>("config/bulk/preview", input));
      if (generation !== this.generation) return;
      this.job = data;
      this.dirty = false;
      if (data.state !== "draft") {
        this.step = 2;
        this.schedulePoll();
      }
    } catch (e) {
      if (generation === this.generation) this.error = this.describe(e);
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
  private invalidate() {
    this.dirty = true;
    this.submissionKey = "";
    this.retryKey = "";
    this.error = "";
  }
  async confirm() {
    if (this.busy || this.dirty || !this.job || this.job.state !== "draft") return;
    const generation = this.generation;
    this.busy = true;
    this.error = "";
    try {
      const data = result(
        await metricRequest<MetricBulkResult>(`config/bulk/${this.job.id}/confirm`, {
          digest: this.job.digest,
        }),
      );
      if (generation !== this.generation) return;
      this.job = data;
      this.step = 2;
      this.polls = 0;
      this.schedulePoll();
      void this.loadHistory();
    } catch (e) {
      if (generation === this.generation) this.error = this.describe(e);
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
  private schedulePoll() {
    clearTimeout(this.poll);
    if (!this.open || !this.job || ++this.polls > 30) return;
    if (
      ["queued", "running"].includes(this.job.state) ||
      this.job.items.some((i) => i.state === "pending_takeover")
    )
      this.poll = setTimeout(() => void this.refresh(), 2000);
  }
  private restoreDraft(data: MetricBulkResult) {
    const labels = new Map(this.resources.map((r) => [resourceKey(r), r.label]));
    this.resources = data.items.map((i) => ({
      ...i.resource,
      label: labels.get(resourceKey(i.resource)) ?? this.label(i),
    }));
    this.overrides = data.requested_overrides ?? {};
    this.selections.clear();
    data.items.forEach((i) => {
      if (i.change?.package) this.selections.set(resourceKey(i.resource), i.change.package);
    });
    this.submissionKey = "";
    this.retryKey = "";
    this.dirty = false;
  }
  async refresh(id = this.job?.id) {
    if (!id || this.busy) return;
    const generation = this.generation;
    this.busy = true;
    this.error = "";
    try {
      const data = result(await metricRequest<MetricBulkResult>(`config/bulk/${id}`));
      if (generation !== this.generation) return;
      this.job = data;
      this.step = data.state === "draft" ? 1 : 2;
      if (data.state === "draft") this.restoreDraft(data);
      this.dirty = false;
      this.schedulePoll();
    } catch (e) {
      if (generation === this.generation) {
        this.error = this.describe(e);
        clearTimeout(this.poll);
      }
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
  async cancel() {
    if (!this.job || this.busy) return;
    const generation = this.generation;
    this.busy = true;
    this.error = "";
    try {
      await metricRequest(`config/bulk/${this.job.id}/cancel`, {});
      if (generation === this.generation) {
        this.job = { ...this.job, cancel_requested: true };
      }
    } catch (e) {
      if (generation === this.generation) this.error = this.describe(e);
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
  async retry() {
    if (!this.job || this.busy) return;
    const generation = this.generation;
    this.busy = true;
    this.error = "";
    this.retryKey ||= crypto.randomUUID();
    try {
      const data = result(
        await metricRequest<MetricBulkResult>(`config/bulk/${this.job.id}/retry`, {
          key: this.retryKey,
        }),
      );
      if (generation !== this.generation) return;
      this.job = data;
      this.step = 1;
      this.restoreDraft(data);
      clearTimeout(this.poll);
    } catch (e) {
      if (generation === this.generation) this.error = this.describe(e);
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
  private label(item: Item) {
    return (
      this.resources.find((r) => resourceKey(r) === resourceKey(item.resource))?.label ??
      `${{ instance: "数据库实例", server: "服务器", network_device: "网络设备" }[item.resource.type]} #${item.resource.id}`
    );
  }
  private fields() {
    return html`<details class="advanced">
      <summary>修改字段（可选） · 默认保留每个对象原值</summary>
      <p class="muted">只修改明确选择的字段。资产采集开关、策略组和未选中的高级覆盖保持原值。</p>
      <div class="fields">
        <app-form-field label="策略采集开关"
          ><select
            aria-label="批量策略采集开关"
            .disabled=${this.busy}
            .value=${this.overrides.enabled ?? "preserve"}
            @change=${(e: Event) => {
              const value = (e.target as HTMLSelectElement).value;
              const { enabled: _, ...rest } = this.overrides;
              this.overrides =
                value === "preserve" ? rest : { ...rest, enabled: value as Overrides["enabled"] };
              this.invalidate();
            }}
          >
            <option value="preserve">保持每个对象原值</option>
            <option value="inherit">恢复继承</option>
            <option value="enable">启用策略（资产停用仍优先）</option>
            <option value="disable">停用策略</option>
          </select></app-form-field
        >
        ${Object.entries(numericFields).map(([field, label]) => {
          const key = field as NumberKey,
            value = this.overrides[key];
          return html`<app-form-field label=${label}
            ><select
              aria-label=${`批量${label}修改方式`}
              .disabled=${this.busy}
              .value=${value?.mode ?? "preserve"}
              @change=${(e: Event) => {
                const mode = (e.target as HTMLSelectElement).value;
                const { [key]: _, ...rest } = this.overrides;
                const defaults: Record<NumberKey, number> = {
                  interval_ms: 60000,
                  timeout_ms: 5000,
                  stale_after_ms: 120000,
                  max_counter_gap_ms: 300000,
                  max_rows: 100,
                  max_concurrency: 1,
                  max_series_per_resource: 100,
                };
                this.overrides =
                  mode === "preserve"
                    ? rest
                    : {
                        ...rest,
                        [key]:
                          mode === "inherit"
                            ? { mode: "inherit" }
                            : { mode: "set", value: defaults[key] },
                      };
                this.invalidate();
              }}
            >
              <option value="preserve">保持每个对象原值</option>
              <option value="inherit">恢复继承</option>
              <option value="set">设定值</option>
            </select>
            ${
              value?.mode === "set"
                ? html`<input
                    type="number"
                    min="0.001"
                    aria-label=${`批量${label}`}
                    .disabled=${this.busy}
                    .value=${String(value.value / (key.endsWith("_ms") ? 1000 : 1))}
                    @input=${(e: Event) => {
                      this.overrides = {
                        ...this.overrides,
                        [key]: {
                          mode: "set",
                          value: Math.round(
                            Number((e.target as HTMLInputElement).value) *
                              (key.endsWith("_ms") ? 1000 : 1),
                          ),
                        },
                      };
                      this.invalidate();
                    }}
                  />`
                : nothing
            }</app-form-field
          >`;
        })}
      </div>
    </details>`;
  }
  private match() {
    const items = this.job?.items ?? [],
      eligible = items.filter((i) => i.state === "eligible");
    const groups = new Map<string, Item[]>();
    for (const item of items) {
      const list = groups.get(item.group) ?? [];
      list.push(item);
      groups.set(item.group, list);
    }
    return html`<div class="edit-grid">
      <section class="stack">
        ${[...groups].map(([group, members]) => {
          const first = members[0];
          if (!members.some((i) => i.choices.some((c) => c.compatibility === "compatible")))
            return html`<div class="notice">
              <strong>${members.length} 个对象将跳过</strong>
              <p>${members.map((i) => `${this.label(i)}：${reason(i)}`).join("；")}</p>
            </div>`;
          return html`<app-card
            ><div class="section-title">
              <div>
                <h2>
                  ${{ instance: "数据库", server: "服务器", network_device: "网络设备" }[first.resource.type]}
                  ${first.checks.map((check) => String(check.value ?? "能力未知")).join(" · ")}
                </h2>
                <p class="muted">
                  ${members.map((i) => this.label(i)).join("、")} · ${members.length} 个对象
                </p>
              </div>
              <app-badge variant=${members.every((i) => i.state === "eligible") ? "ok" : "muted"}
                >${members.filter((i) => i.state === "eligible").length} 个可匹配</app-badge
              >
            </div>
            <label class="field-label"
              >为此组选择模板<select
                aria-label=${`${group} 模板`}
                .disabled=${this.busy || !first.choices.some((c) => c.compatibility === "compatible")}
                .value=${this.selections.get(resourceKey(first.resource))?.digest ?? first.change?.package?.digest ?? ""}
                @change=${(e: Event) => {
                  const choice = first.choices.find(
                    (c) => c.package.digest === (e.target as HTMLSelectElement).value,
                  );
                  if (!choice) return;
                  members.forEach((i) =>
                    this.selections.set(resourceKey(i.resource), choice.package),
                  );
                  this.invalidate();
                }}
              >
                <option value="" disabled>没有可自动匹配的模板</option>
                ${first.choices.map((c) => html`<option value=${c.package.digest} ?disabled=${c.compatibility !== "compatible"}>${packageName(c.package.id)} · ${c.package.version}${c.recommended ? "（推荐）" : ""}${c.compatibility !== "compatible" ? " · 不兼容或能力未知" : ""}</option>`)}
              </select></label
            >
            <p class="field-help">
              ${first.coverage.length ? `覆盖 ${first.coverage.length} 项指标：${first.coverage.slice(0, 3).map(metricName).join("、")}${first.coverage.length > 3 ? "等" : ""}` : reason(first) || "选择兼容模板后重新匹配"}
            </p>
            ${first.missing.length ? html`<p class="muted">核心指标缺口：${first.missing.map(metricName).join("、")}</p>` : nothing}
            ${
              members.some((i) => i.state !== "eligible")
                ? html`<p class="muted">
                    ${members
                      .filter((i) => i.state !== "eligible")
                      .map((i) => `${this.label(i)}：${reason(i)}`)
                      .join("；")}
                  </p>`
                : nothing
            }</app-card
          >`;
        })}${this.fields()}
      </section>
      <aside>
        <app-card
          ><span class="eyebrow">本次范围</span>
          <div class="big-number">${items.length}<small>个已选对象</small></div>
          <dl class="key-values">
            <div>
              <dt>可匹配</dt>
              <dd>${eligible.length} 个</dd>
            </div>
            <div>
              <dt>跳过 / 不支持 / 无权限</dt>
              <dd>${items.length - eligible.length} 个</dd>
            </div>
          </dl>
          <p class="muted">保留对象停用、原有高级覆盖；不静默覆盖冲突配置。</p>
          <div class="section-actions">
            ${
              this.dirty
                ? html`<button class="btn-primary" .disabled=${this.busy} @click=${this.start}>
                    重新匹配与预览 →
                  </button>`
                : html`<button
                    class="btn-primary"
                    .disabled=${this.busy || !eligible.length}
                    @click=${() => {
                      this.step = 1;
                    }}
                  >
                    预览变更 →
                  </button>`
            }
          </div></app-card
        >
      </aside>
    </div>`;
  }
  private preview() {
    const items = this.job?.items ?? [];
    return html`<div class="notice">
        <strong>确认后执行检查、试采与应用</strong>
        <p>
          保留资产采集开关和策略组。下表列明实际修改字段；配置冲突的对象单独失败，不影响其他对象。
        </p>
      </div>
      <app-card .compact=${true}
        ><div class="table-scroll">
          <app-data-table
            .dense=${true}
            .columns=${[
              { key: "name", label: "对象" },
              { key: "pack", label: "当前 → 目标" },
              { key: "fields", label: "修改 / 保留字段" },
              { key: "cost", label: "预计读取成本" },
              { key: "result", label: "预计操作" },
            ]}
            .rows=${items.map((i) => ({
              name: this.label(i),
              pack: html`${i.before ? `${packageName(i.before.package.id)} · ${i.before.package.version}` : "尚未绑定"}<small
                  >→
                  ${i.change?.package ? `${packageName(i.change.package.id)} · ${i.change.package.version}` : "保留当前模板"}</small
                >`,
              fields: html`${i.changed.length ? i.changed.map(fieldLabel).join("、") : "核验当前绑定并补齐应用"}<small
                  >保留：资产开关 /
                  策略组${i.retained.length ? " / " + i.retained.map(fieldLabel).join("、") : ""}</small
                >${
                  i.change && Object.keys(i.change.overrides ?? {}).length
                    ? html`<details>
                        <summary>覆盖字段详情</summary>
                        <dl class="override-diff">
                          ${Object.entries(i.change.overrides ?? {}).flatMap(([key, value]) => {
                            const before = i.before?.overrides;
                            if (key === "metrics")
                              return Object.entries(value as Record<string, unknown>).map(
                                ([metric, next]) =>
                                  html`<div>
                                    <dt>${metricName(metric.split("@")[0])}</dt>
                                    <dd>
                                      ${overrideValue(metric, before?.metrics?.[metric])} →
                                      ${overrideValue(metric, next)}${i.retained.includes(`metrics.${metric}`) || i.retained.includes("metrics") ? "（保留）" : ""}
                                    </dd>
                                  </div>`,
                              );
                            return [
                              html`<div>
                                <dt>${fieldLabel(key)}</dt>
                                <dd>
                                  ${overrideValue(key, before?.[key as keyof Overrides])} →
                                  ${overrideValue(key, value)}${i.retained.includes(key) ? "（保留）" : ""}
                                </dd>
                              </div>`,
                            ];
                          })}
                        </dl>
                      </details>`
                    : nothing
                }`,
              cost: i.cost
                ? `${i.cost.before} → ${i.cost.after} 次逻辑读取/小时（估算）`
                : "不执行采集",
              result:
                i.state === "eligible" ? "检查、试采、发布配置" : reason(i) || stateLabel[i.state],
            }))}
          ></app-data-table></div
      ></app-card>
      <p class="muted">
        ${items.filter((i) => i.state === "eligible").length}
        个对象将独立处理；试采成功和配置发布均不表示正式数据已就绪。预览有效期 30 分钟。
      </p>
      <div class="page-actions">
        <button
          class="btn"
          .disabled=${this.busy}
          @click=${() => {
            this.step = 0;
          }}
        >
          上一步</button
        ><button
          class="btn-primary"
          .disabled=${this.busy || this.dirty || !items.some((i) => i.state === "eligible")}
          @click=${this.confirm}
        >
          确认并应用 ${items.filter((i) => i.state === "eligible").length} 个对象
        </button>
      </div>`;
  }
  private results() {
    const job = this.job!,
      items = job.items,
      counts = (state: string) => items.filter((i) => i.state === state).length;
    return html`<div class="notice" role="status">
        <strong
          >${["queued", "running"].includes(job.state) ? "批量处理中" : job.state === "cancelled" ? "批量处理已取消" : "批量处理结束"}</strong
        >
        <p>
          正式就绪 ${counts("succeeded")} · 待正式就绪 ${counts("pending_takeover")} · 失败
          ${counts("failed")} · 跳过 / 不支持 ${counts("unsupported") + counts("skipped")} · 已取消
          ${counts("cancelled")} · 排队 / 在途 ${counts("queued") + counts("running")}
        </p>
        <p>
          配置已发布的对象保留实际结果；正式数据状态单独读取。${job.cancel_requested ? "已请求取消，等待在途读取结束。" : ""}
        </p>
      </div>
      <app-card .compact=${true}
        ><div class="table-scroll">
          <app-data-table
            .dense=${true}
            .columns=${[
              { key: "name", label: "对象" },
              { key: "state", label: "处理结果" },
              { key: "reason", label: "说明" },
              { key: "action", label: "下一步" },
            ]}
            .rows=${items.map((i) => ({
              name: this.label(i),
              state: html`<app-badge
                  variant=${i.state === "failed" ? "danger" : i.state === "succeeded" ? "ok" : "muted"}
                  >${stateLabel[i.state]}</app-badge
                >${i.revision ? html`<small>已发布配置版本 ${i.revision}</small>` : nothing}`,
              reason: reason(i),
              action: html`<button
                class="btn-ghost"
                @click=${() => {
                  const tab = {
                    instance: "instance-detail",
                    server: "server-detail",
                    network_device: "network-device-detail",
                  }[i.resource.type];
                  const detail =
                    i.resource.type === "instance"
                      ? { tab, instanceId: i.resource.id }
                      : i.resource.type === "server"
                        ? { tab, serverId: i.resource.id }
                        : { tab, deviceId: i.resource.id };
                  this.close();
                  window.dispatchEvent(new CustomEvent("slide-navigate", { detail }));
                }}
              >
                查看对象证据 →
              </button>`,
            }))}
          ></app-data-table></div
      ></app-card>
      <div class="page-actions">
        <button
          class="btn btn-refresh"
          .disabled=${this.busy}
          @click=${() => {
            this.polls = 0;
            void this.refresh();
          }}
        >
          刷新逐对象状态
        </button>
        ${["queued", "running"].includes(job.state) ? html`<button class="btn" .disabled=${this.busy || job.cancel_requested} @click=${this.cancel}>取消未发布操作</button>` : items.some((i) => i.state === "failed") ? html`<button class="btn-primary" .disabled=${this.busy} @click=${this.retry}>仅重新预览失败项</button>` : nothing}
      </div>`;
  }
  render() {
    return html`<style>
        ${sharedBtnStyles}${collectionLayoutStyles} .flow-steps {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-lg);
          margin: var(--space-xl) 0;
          font-size: 12px;
          color: var(--muted);
        }
        .flow-steps span {
          display: flex;
          align-items: center;
          gap: var(--space-sm);
        }
        .flow-steps b {
          width: 24px;
          height: 24px;
          border-radius: var(--radius-full);
          background: var(--bg-accent);
          display: grid;
          place-items: center;
        }
        .flow-steps .active {
          color: var(--accent-text);
        }
        .flow-steps .active b {
          background: var(--accent);
          color: var(--accent-foreground);
        }
        .big-number {
          font-size: 38px;
          font-weight: 600;
          color: var(--text-strong);
        }
        .big-number small {
          font-weight: 400;
          font-size: 12px;
        }
        .field-label {
          display: block;
          font-size: 12px;
          margin-top: var(--space-lg);
        }
        select {
          margin-top: var(--space-sm);
        }
        .field-help {
          font-size: 12px;
          color: var(--muted);
        }
        .section-actions,
        .page-actions {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: var(--space-sm);
          margin-top: var(--space-xl);
        }
        .table-scroll {
          max-width: 100%;
          overflow: auto;
        }
        app-data-table {
          display: block;
          min-width: 680px;
        }
        .override-diff {
          min-width: 12rem;
          font-size: 12px;
        }
        .override-diff div {
          margin-block: var(--space-sm);
        }
        .override-diff dd {
          margin: 0;
          color: var(--muted);
        }
        .history {
          margin-top: var(--space-xl);
        }
        .history button {
          margin: var(--space-xs);
        }
        .skeleton {
          padding: var(--space-xl);
        }</style
      ><app-dialog
        .open=${this.open}
        title="批量绑定采集模板"
        size="wide"
        @app-dialog-close=${this.close}
      >
        <p class="section-description">先按兼容范围分组，再确认差异；每个对象独立返回结果。</p>
        <nav class="flow-steps" aria-label="批量步骤">
          ${["匹配模板", "预览变更", "查看结果"].map((label, index) => html`<span class=${index === this.step ? "active" : ""} aria-current=${index === this.step ? "step" : nothing}><b>${index < this.step ? "✓" : index + 1}</b>${label}</span>`)}
        </nav>
        ${this.error ? html`<div class="notice error" role="alert">${this.error}${!this.job && this.resources.length ? html`<button class="btn" .disabled=${this.busy} @click=${this.start}>重新读取</button>` : nothing}</div>` : nothing}
        ${this.busy && !this.job ? html`<div class="skeleton" role="status">正在读取每个对象的绑定、引擎版本和兼容模板…</div>` : this.job ? (this.step === 0 ? this.match() : this.step === 1 ? this.preview() : this.results()) : html`<p>选择资源后开始匹配，或打开已有任务继续查看。最多选择 100 个对象。</p>`}
        <details class="history">
          <summary>最近的批量任务（刷新页面后可继续查看）</summary>
          ${this.historyError ? html`<p role="alert">${this.historyError}</p>` : nothing}<button
            class="btn btn-refresh"
            .disabled=${this.busy}
            @click=${this.loadHistory}
          >
            刷新任务列表</button
          >${this.history.map((j) => html`<button class="btn" .disabled=${this.busy} @click=${() => this.refresh(j.id)}>${new Date(j.created_at).toLocaleString("zh-CN")} · ${j.count} 个对象 · ${{ draft: "待确认", queued: "排队中", running: "处理中", completed: "处理结束", cancelled: "已取消" }[j.state] ?? "状态待确认"}</button>`)}
        </details>
        <div slot="footer"><button class="btn" @click=${this.close}>关闭</button></div>
      </app-dialog>`;
  }
}
