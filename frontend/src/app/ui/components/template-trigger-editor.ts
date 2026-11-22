import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import { sharedFieldStyles } from "../../styles/shared-field-styles.js";
import { metricRequest, metricError, MetricRequestError, type TemplateVersionDetail } from "./metric-api.js";
import "./app-form-field.js";
import "./app-data-table.js";
import { metricDisplayName, triggerRecoveryModes, type TriggerRecoveryMode } from "./metric-display.js";

type Leaf = {
  node: "compare";
  select: { aggregation: string; window_ms?: number; item_id?: string };
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
  recovery_mode: 'recovery_expression' as TriggerRecoveryMode,
  allow_manual_close: false,
  recovery: leaf("<", "recovery_threshold") as Expression,
  quality: { accepted_quality: ["good", "partial"], min_coverage: 1, allow_estimated: false },
  clock: {
    stale_after_ms: 120000,
    nodata: { enabled: false } as { enabled: boolean; after_ms?: number },
  },
});
type Severity = 'warning' | 'critical';
const severityName = (severity: Severity | undefined) => severity === 'critical' ? '严重' : '预警';
const itemName = (item: TemplateVersionDetail['items'][number]) => item.display_name === item.canonical_metric?.id
  ? metricDisplayName(item.canonical_metric.id) : item.display_name;

function defaultsFor(metricId: string | undefined, severity: Severity) {
  const defaults = fresh();
  const inode = metricId === 'linux.filesystem.discovered_inode_available_percent';
  if (!inode && metricId !== 'linux.filesystem.discovered_used_percent') return defaults;
  const threshold = inode ? (severity === 'critical' ? 10 : 20) : (severity === 'critical' ? 90 : 80);
  const window = { aggregation: 'min' as const, window_ms: 300_000 };
  return {
    ...defaults,
    parameters: { ...defaults.parameters, defaults: { problem_threshold: threshold, recovery_threshold: threshold } },
    problem: { ...leaf(inode ? '<' : '>', 'problem_threshold'), select: window } as Expression,
    recovery: { ...leaf(inode ? '>=' : '<=', 'recovery_threshold'), select: window } as Expression,
  };
}

@customElement("template-trigger-editor")
export class TemplateTriggerEditor extends LitElement {
  @property({ attribute: false }) template: TemplateVersionDetail | null = null;
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) readOnly = false;
  @state() private item = "";
  @state() private severity: Severity = 'warning';
  @state() private value = fresh();
  @state() private busy = false;
  @state() private error = "";
  @state() private rules: any[] = [];
  @state() private ready = false;
  private generation = 0;
  private baseline = JSON.stringify(this.value);
  static styles = [
    sharedBtnStyles,
    sharedFieldStyles,
    css`
      :host {
        display: block;
        margin-top: var(--space-lg);
        color: var(--text);
      }
      .surface { border: 1px solid var(--border); border-radius: var(--radius-md); overflow: auto; background: var(--bg); }
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
      if (!this.template?.items.some(item => item.item_id === this.item)) {
        this.item = this.template?.items[0]?.item_id ?? "";
        this.severity = 'warning';
      }
      void this.load();
    }
    if (changes.has("readOnly") && this.readOnly && this.ready) this.selectItem(this.item);
    if (changes.has("value") && this.ready && !this.readOnly) {
      this.dispatchEvent(new CustomEvent('trigger-dirty', { detail: JSON.stringify(this.value) !== this.baseline }));
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
  private selectItem(id: string, severity = this.severity) {
    this.item = id;
    this.severity = severity;
    this.error = '';
    const rule = this.rules.find((r) => r.scope === `item:${id}` && (r.severity ?? 'warning') === severity);
    const defaults = defaultsFor(this.template?.items.find(item => item.item_id === id)?.canonical_metric?.id, severity);
    const recovery: Leaf = {
      ...(defaults.recovery as Leaf),
      threshold: { kind: 'constant', value: defaults.parameters.defaults.recovery_threshold },
    };
    this.value = rule
      ? structuredClone({
          parameters: rule.parameters,
          problem: rule.problem,
          recovery_mode: rule.recovery_mode ?? 'recovery_expression',
          allow_manual_close: rule.allow_manual_close === true,
          recovery: rule.recovery ?? recovery,
          quality: rule.quality,
          clock: rule.clock,
        })
      : defaults;
    this.baseline = JSON.stringify(this.value);
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
                      children: n.node === "compare" ? [n, {
                        ...structuredClone(n), threshold: { kind: 'constant', value: n.threshold.kind === 'constant'
                          ? n.threshold.value : Number((this.value.parameters.defaults as Record<string, unknown>)[n.threshold.name] ?? 0) },
                      }] : n.children,
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
                    @change=${(e: Event) => {
                      const aggregation = (e.target as HTMLSelectElement).value;
                      change(n => {
                        const { item_id } = (n as Leaf).select;
                        return { ...n, select: { aggregation, ...(item_id ? { item_id } : {}),
                          ...(aggregation === 'last' ? {} : { window_ms: 60000 }) } } as Leaf;
                      });
                    }}
                  >
                    ${["last", "avg", "min", "max"].map((v) => html`<option value=${v} .selected=${v === node.select.aggregation}>${v === "last" ? "最新值" : v === "avg" ? "平均值" : v === "min" ? "最小值" : "最大值"}</option>`)}
                  </select></label
                >
                ${(this.template?.items.length ?? 0) > 1 ? html`<label>条件监控项<select
                  aria-label="条件监控项" .value=${node.select.item_id ?? ''} ?disabled=${this.disabled || this.busy}
                  @change=${(event: Event) => {
                    const item = (event.target as HTMLSelectElement).value;
                    change(n => {
                      const { item_id: _previous, ...select } = (n as Leaf).select;
                      return { ...n, select: item ? { ...select, item_id: item } : select } as Leaf;
                    });
                  }}>
                  <option value="" .selected=${!node.select.item_id}>当前触发器监控项</option>
                  ${this.template?.items.filter(item => item.item_id !== this.item && (!item.dimensions || !Object.keys(item.dimensions).length))
                    .map(item => html`<option value=${item.item_id} .selected=${item.item_id === node.select.item_id}>${itemName(item)}</option>`)}
                </select></label>` : nothing}
                ${node.select.aggregation !== "last" ? html`<label>窗口（秒）<input type="number" min="1" max="86400" .value=${String((node.select.window_ms ?? 60000) / 1000)} ?disabled=${this.disabled || this.busy} @change=${(e: Event) => change((n) => ({ ...n, select: { ...(n as Leaf).select, window_ms: Number((e.target as HTMLInputElement).value) * 1000 } }) as Leaf)} /></label>` : nothing}
                <label
                  >比较<select
                    .value=${node.operator}
                    ?disabled=${this.disabled || this.busy}
                    @change=${(e: Event) => change((n) => ({ ...n, operator: (e.target as HTMLSelectElement).value }) as Leaf)}
                  >
                    ${[">", ">=", "<", "<=", "=", "!="].map((v) => html`<option value=${v} .selected=${v === node.operator}>${v}</option>`)}
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
    if (!t || this.busy || this.disabled || this.readOnly || !this.ready) return;
    this.busy = true;
    this.error = "";
    try {
      const { recovery, allow_manual_close, ...body } = this.value;
      const result = await metricRequest<any>(`templates/${t.template_id}/triggers`, {
        expected_version: t.version,
        expected_content_hash: t.content_hash,
        item_id: this.item,
        ...(this.severity === 'critical' ? { severity: this.severity } : {}),
        ...body,
        ...(allow_manual_close ? { allow_manual_close } : {}),
        ...(body.recovery_mode === 'recovery_expression' ? { recovery } : {}),
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
      this.error = e instanceof MetricRequestError && e.code === 'TRIGGER_COMPOSITE_SCALAR_REQUIRED'
        ? '组合条件只能引用当前模板中无维度的数值监控项。' : metricError(e);
    } finally {
      this.busy = false;
    }
  }
  private describeExpression(node: Expression | undefined, defaults: Record<string, unknown>): string {
    if (!node) return '—';
    if (node.node !== 'compare') {
      return `(${node.children.map(child => this.describeExpression(child, defaults)).join(node.node === 'all' ? ' 且 ' : ' 或 ')})`;
    }
    const operators: Record<string, string> = { last: '最新值', avg: '平均值', min: '最小值', max: '最大值' };
    const threshold = node.threshold.kind === 'constant' ? node.threshold.value : defaults[node.threshold.name] ?? node.threshold.name;
    const window = node.select.window_ms ? `（${node.select.window_ms / 1000} 秒内）` : '';
    const operand = node.select.item_id && this.template?.items.find(item => item.item_id === node.select.item_id);
    const label = operand ? `${itemName(operand)} · ` : node.select.item_id ? `${node.select.item_id} · ` : '';
    return `${label}${operators[node.select.aggregation] ?? node.select.aggregation}${window} ${node.operator} ${threshold}`;
  }

  render() {
    if (!this.template) return nothing;
    if (this.readOnly) {
      return html`${this.error ? html`<p class="error" role="alert">${this.error}
        <button class="btn btn-refresh" @click=${this.load}>重新读取</button></p>`
        : html`<div class="surface"><app-data-table .loading=${this.busy} .striped=${false}
          .columns=${[{key:'item',label:'监控项'}, {key:'severity',label:'级别'}, {key:'problem',label:'触发条件'}, {key:'recovery',label:'恢复条件'}, {key:'manual',label:'允许手动关闭'}]}
          emptyMessage="还没有触发器" .rows=${this.rules.map(rule => ({
            item: this.template?.items.find(item => rule.scope === `item:${item.item_id}` && item.display_name !== rule.metric?.id)?.display_name
              ?? metricDisplayName(rule.metric?.id ?? ''),
            severity: severityName(rule.severity),
            problem: this.describeExpression(rule.problem, rule.parameters?.defaults ?? {}),
            recovery: rule.recovery_mode === 'problem_expression' || rule.recovery_mode === 'none'
              ? triggerRecoveryModes[rule.recovery_mode as TriggerRecoveryMode]
              : this.describeExpression(rule.recovery, rule.parameters?.defaults ?? {}),
            manual: rule.allow_manual_close === true ? '是' : '否',
          }))}></app-data-table>`}`;
    }
    return html`<div class="row"><label
        >监控项<select
          aria-label="触发器监控项"
          .value=${this.item}
          ?disabled=${this.disabled || this.busy}
          @change=${(e: Event) => {
            const select = e.target as HTMLSelectElement;
            if (JSON.stringify(this.value) !== this.baseline) {
              select.value = this.item;
              this.error = '请先发布当前修改，或取消编辑后再选择其他监控项。';
              return;
            }
            this.selectItem(select.value);
          }}
        >
          ${this.template.items.map((i) => html`<option value=${i.item_id} .selected=${this.item === i.item_id}>${itemName(i)}（${i.unit}）</option>`)}
        </select></label
      >
      <label>级别<select aria-label="触发器级别" .value=${this.severity} ?disabled=${this.disabled || this.busy} @change=${(event: Event) => {
        const select = event.target as HTMLSelectElement;
        if (JSON.stringify(this.value) !== this.baseline) {
          select.value = this.severity;
          this.error = '请先发布当前修改，或取消编辑后再切换级别。';
          return;
        }
        this.selectItem(this.item, select.value as Severity);
      }}><option value="warning">预警</option><option value="critical">严重</option></select></label>
      <label>恢复方式<select aria-label="恢复方式" .value=${this.value.recovery_mode} ?disabled=${this.disabled || this.busy}
        @change=${(event: Event) => {
          const recovery_mode = (event.target as HTMLSelectElement).value as TriggerRecoveryMode;
          this.value = { ...this.value, recovery_mode };
        }}>
        ${Object.entries(triggerRecoveryModes).map(([mode, label]) => html`<option value=${mode} .selected=${mode === this.value.recovery_mode}>${label}</option>`)}
      </select></label>
      <label><input type="checkbox" .checked=${this.value.allow_manual_close} ?disabled=${this.disabled || this.busy}
        @change=${(event: Event) => {
          this.value = { ...this.value, allow_manual_close: (event.target as HTMLInputElement).checked };
        }} />允许手动关闭</label></div>
      ${this.expression("problem", this.value.problem)}
      ${this.value.recovery_mode === 'recovery_expression' ? this.expression("recovery", this.value.recovery) : nothing}
      ${this.value.recovery_mode === 'none' ? html`<p>问题条件转假后，事件仍保持打开。${this.value.allow_manual_close ? '有权限的人员可以在事件详情手动关闭。' : ''}</p>` : nothing}
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
        ${this.busy ? "处理中…" : "发布触发器"}
      </button>`;
  }
}
