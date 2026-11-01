import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import { sharedFieldStyles } from "../../styles/shared-field-styles.js";
import { metricRequest, metricError, type TemplateVersionDetail } from "./metric-api.js";
import "./app-form-field.js";

type Leaf = {
  node: "compare";
  select: { aggregation: string; window_ms?: number };
  operator: string;
  threshold: { kind: "constant"; value: number } | { kind: "parameter"; name: string };
};
type Expression = Leaf | { node: "all" | "any"; children: Expression[] };
const leaf = (operator: string, name: string): Leaf => ({
  node: "compare",
  select: { aggregation: "last" },
  operator,
  threshold: { kind: "parameter", name },
});
const fresh = () => ({
  parameters: {
    schema: { problem_threshold: { type: "number" }, recovery_threshold: { type: "number" } },
    defaults: { problem_threshold: 90, recovery_threshold: 70 },
  },
  problem: leaf(">", "problem_threshold") as Expression,
  recovery: leaf("<", "recovery_threshold") as Expression,
  quality: { accepted_quality: ["good", "partial"], min_coverage: 1, allow_estimated: false },
  clock: {
    stale_after_ms: 120000,
    nodata: { enabled: false } as { enabled: boolean; after_ms?: number },
  },
});

@customElement("template-trigger-editor")
export class TemplateTriggerEditor extends LitElement {
  @property({ attribute: false }) template: TemplateVersionDetail | null = null;
  @property({ type: Boolean }) disabled = false;
  @state() private item = "";
  @state() private value = fresh();
  @state() private busy = false;
  @state() private error = "";
  @state() private rules: any[] = [];
  @state() private ready = false;
  private generation = 0;
  static styles = [
    sharedBtnStyles,
    sharedFieldStyles,
    css`
      :host {
        display: block;
        margin-top: var(--space-lg);
        color: var(--text);
      }
      fieldset {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-md);
        margin: var(--space-sm) 0;
        min-width: 0;
      }
      .row {
        display: flex;
        gap: var(--space-sm);
        flex-wrap: wrap;
        align-items: end;
      }
      .row > * {
        min-width: 100px;
      }
      label {
        display: grid;
        gap: var(--space-xs);
      }
      select,
      input {
        max-width: 100%;
        font: inherit;
      }
      p {
        color: var(--muted);
      }
      .error {
        color: var(--danger);
      }
      button:focus-visible,
      select:focus-visible,
      input:focus-visible {
        outline: 2px solid var(--accent);
      }
    `,
  ];
  protected updated(changes: Map<string, unknown>) {
    if (changes.has("template")) {
      this.item = this.template?.items[0]?.item_id ?? "";
      void this.load();
    }
  }
  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }
  private async load() {
    const t = this.template,
      g = ++this.generation;
    this.ready = false;
    this.rules = [];
    this.value = fresh();
    if (!t) return;
    this.error = "";
    this.busy = true;
    try {
      const result = await metricRequest<{ rules: any[] }>(
        `templates/${t.template_id}/versions/${t.version}/triggers`,
      );
      if (g !== this.generation) return;
      this.rules = result.rules.filter(Boolean);
      this.selectItem(this.item);
      this.ready = true;
    } catch (e) {
      if (g === this.generation) this.error = metricError(e);
    } finally {
      if (g === this.generation) this.busy = false;
    }
  }
  private selectItem(id: string) {
    this.item = id;
    const rule = this.rules.find((r) => r.scope === `item:${id}`);
    this.value = rule
      ? structuredClone({
          parameters: rule.parameters,
          problem: rule.problem,
          recovery: rule.recovery,
          quality: rule.quality,
          clock: rule.clock,
        })
      : fresh();
  }
  private edit(
    kind: "problem" | "recovery",
    path: number[],
    update: (node: Expression) => Expression,
  ) {
    const value = structuredClone(this.value);
    let parent: any = value,
      key: string | number = kind;
    for (const index of path) {
      parent = parent[key].children;
      key = index;
    }
    parent[key] = update(parent[key]);
    this.value = value;
  }
  private expression(kind: "problem" | "recovery", node: Expression, path: number[] = []): any {
    const change = (fn: (n: Expression) => Expression) => this.edit(kind, path, fn);
    return html`<fieldset>
      <legend>
        ${kind === "problem" ? "问题条件" : "独立恢复条件"}${path.length ? ` · ${path.map((i) => i + 1).join(".")}` : ""}
      </legend>
      <div class="row">
        <label
          >组合方式<select
            aria-label=${`${kind}组合${path.join(".")}`}
            .value=${node.node}
            ?disabled=${this.disabled || this.busy}
            @change=${(e: Event) => {
              const mode = (e.target as HTMLSelectElement).value;
              change((n) =>
                mode === "compare"
                  ? n.node === "compare"
                    ? n
                    : n.children[0]
                  : {
                      node: mode as "all" | "any",
                      children: n.node === "compare" ? [n, structuredClone(n)] : n.children,
                    },
              );
            }}
          >
            <option value="compare" ?disabled=${node.node !== "compare"}>单项比较</option>
            <option value="all">全部满足 AND</option>
            <option value="any">任一满足 OR</option>
          </select></label
        >
        ${
          node.node === "compare"
            ? html` <label
                  >计算<select
                    .value=${node.select.aggregation}
                    ?disabled=${this.disabled || this.busy}
                    @change=${(e: Event) => change((n) => ({ ...n, select: (e.target as HTMLSelectElement).value === "last" ? { aggregation: "last" } : { aggregation: (e.target as HTMLSelectElement).value, window_ms: 60000 } }) as Leaf)}
                  >
                    ${["last", "avg", "min", "max"].map((v) => html`<option value=${v}>${v === "last" ? "最新值" : v === "avg" ? "平均值" : v === "min" ? "最小值" : "最大值"}</option>`)}
                  </select></label
                >
                ${node.select.aggregation !== "last" ? html`<label>窗口（秒）<input type="number" min="1" max="86400" .value=${String((node.select.window_ms ?? 60000) / 1000)} ?disabled=${this.disabled || this.busy} @change=${(e: Event) => change((n) => ({ ...n, select: { ...(n as Leaf).select, window_ms: Number((e.target as HTMLInputElement).value) * 1000 } }) as Leaf)} /></label>` : nothing}
                <label
                  >比较<select
                    .value=${node.operator}
                    ?disabled=${this.disabled || this.busy}
                    @change=${(e: Event) => change((n) => ({ ...n, operator: (e.target as HTMLSelectElement).value }) as Leaf)}
                  >
                    ${[">", ">=", "<", "<=", "=", "!="].map((v) => html`<option value=${v}>${v}</option>`)}
                  </select></label
                >
                <label
                  >阈值<input
                    type="number"
                    step="any"
                    .value=${String(node.threshold.kind === "constant" ? node.threshold.value : ((this.value.parameters.defaults as any)[node.threshold.name] ?? ""))}
                    ?disabled=${this.disabled || this.busy}
                    @change=${(e: Event) => {
                      const v = Number((e.target as HTMLInputElement).value);
                      if (node.threshold.kind === "parameter") {
                        this.value = {
                          ...this.value,
                          parameters: {
                            ...this.value.parameters,
                            defaults: {
                              ...this.value.parameters.defaults,
                              [node.threshold.name]: v,
                            },
                          },
                        };
                      } else
                        change(
                          (n) => ({ ...n, threshold: { kind: "constant", value: v } }) as Leaf,
                        );
                    }}
                /></label>
                <span
                  >${node.threshold.kind === "parameter" ? `模板参数默认值：${node.threshold.name}` : "固定值"}</span
                >`
            : html`${node.children.map((child, i) => this.expression(kind, child, [...path, i]))}<button
                  class="btn btn-sm"
                  ?disabled=${this.disabled || this.busy || node.children.length >= 8}
                  @click=${() => change((n) => ({ ...n, children: [...(n as any).children, { node: "compare", select: { aggregation: "last" }, operator: kind === "problem" ? ">" : "<", threshold: { kind: "constant", value: kind === "problem" ? 90 : 70 } }] }) as Expression)}
                >
                  添加条件
                </button>`
        }
      </div>
    </fieldset>`;
  }
  private async publish() {
    const t = this.template,
      g = this.generation;
    if (!t || this.busy || this.disabled || !this.ready) return;
    this.busy = true;
    this.error = "";
    try {
      const result = await metricRequest<any>(`templates/${t.template_id}/triggers`, {
        expected_version: t.version,
        expected_content_hash: t.content_hash,
        item_id: this.item,
        ...this.value,
      });
      if (!this.isConnected || g !== this.generation) return;
      this.dispatchEvent(
        new CustomEvent("trigger-published", {
          detail: {
            pin: {
              template_id: result.template_id,
              version: result.version,
              content_hash: result.content_hash,
            },
          },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (e) {
      this.error = metricError(e);
    } finally {
      this.busy = false;
    }
  }
  render() {
    if (!this.template) return nothing;
    return html`<h3>模板触发器</h3>
      <p>发布新模板版本后，使用本页检查、试采和应用。已发生事件保留原规则快照。</p>
      <label
        >监控项<select
          .value=${this.item}
          ?disabled=${this.disabled || this.busy}
          @change=${(e: Event) => this.selectItem((e.target as HTMLSelectElement).value)}
        >
          ${this.template.items.map((i) => html`<option value=${i.item_id}>${i.display_name}（${i.unit}）</option>`)}
        </select></label
      >
      ${this.expression("problem", this.value.problem)}${this.expression("recovery", this.value.recovery)}
      <div class="row">
        <label
          >过期时间（秒）<input
            type="number"
            min="1"
            .value=${String(this.value.clock.stale_after_ms / 1000)}
            ?disabled=${this.disabled || this.busy}
            @change=${(e: Event) => (this.value = { ...this.value, clock: { ...this.value.clock, stale_after_ms: Number((e.target as HTMLInputElement).value) * 1000 } })}
        /></label>
        <label
          >最低窗口覆盖率<input
            type="number"
            min="0"
            max="1"
            step="0.1"
            .value=${String(this.value.quality.min_coverage)}
            ?disabled=${this.disabled || this.busy}
            @change=${(e: Event) => (this.value = { ...this.value, quality: { ...this.value.quality, min_coverage: Number((e.target as HTMLInputElement).value) } })}
        /></label>
        <label
          ><input
            type="checkbox"
            .checked=${this.value.clock.nodata.enabled}
            ?disabled=${this.disabled || this.busy}
            @change=${(e: Event) => (this.value = { ...this.value, clock: { ...this.value.clock, nodata: (e.target as HTMLInputElement).checked ? { enabled: true, after_ms: 300000 } : { enabled: false } } })}
          />独立缺测触发</label
        >
        ${this.value.clock.nodata.enabled ? html`<label>缺测持续（秒）<input type="number" min="1" .value=${String((this.value.clock.nodata.after_ms ?? 300000) / 1000)} ?disabled=${this.disabled || this.busy} @change=${(e: Event) => (this.value = { ...this.value, clock: { ...this.value.clock, nodata: { enabled: true, after_ms: Number((e.target as HTMLInputElement).value) * 1000 } } })} /></label>` : nothing}
      </div>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}<button
        class="btn-primary"
        ?disabled=${this.disabled || this.busy || !this.item || !this.ready}
        @click=${() => this.publish()}
      >
        ${this.busy ? "处理中…" : "发布新模板版本"}
      </button>`;
  }
}
