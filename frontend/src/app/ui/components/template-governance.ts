import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import "./app-dialog.js";
import "./app-form-field.js";
/** Governance consumes the same authoring and binding services as resource configuration. */
@customElement("template-governance")
export class TemplateGovernanceView extends LitElement {
  static styles = [
    sharedBtnStyles,
    css`
      :host {
        display: block;
        color: var(--text);
        margin-block: var(--space-xl);
      }
      .toolbar {
        display: flex;
        gap: var(--space-md);
        align-items: end;
        flex-wrap: wrap;
      }
      label {
        display: block;
        margin-block: var(--space-sm);
      }
      select,
      input {
        padding: var(--space-sm);
        max-width: 100%;
        color: var(--text);
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .scroll {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      td,
      th {
        text-align: left;
        padding: var(--space-sm);
        border-bottom: 1px solid var(--border);
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      button {
        margin: var(--space-xs);
      }
      .error {
        color: var(--danger);
      }
      :focus-visible {
        outline: 2px solid var(--accent);
      }
    `,
  ];
  @state() private catalog: any[] = [];
  @state() private inventory: any[] = [];
  @state() private template = "";
  @state() private editor: any = null;
  @state() private inherited: any = null;
  @state() private base = "";
  @state() private parameter = "interval_ms";
  @state() private parameterValue = "60000";
  @state() private from = "";
  @state() private to = "";
  @state() private difference: any = null;
  @state() private selected = new Set<string>();
  @state() private batch: any = null;
  @state() private busy = false;
  @state() private error = "";
  @state() private notice = "";
  @state() private confirmation = false;
  @state() private review: any = null;
  @state() private pending: any = null;
  private generation = 0;
  private token = "";
  private key() {
    const claims = JSON.parse(
      atob(
        (localStorage.getItem("token") ?? "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/"),
      ),
    );
    if (!claims.userId || !claims.sessionVersion) throw Error("请重新登录");
    return `slide.governance.${claims.userId}.${claims.sessionVersion}`;
  }
  private current(g: number, t: string) {
    return this.isConnected && g === this.generation && t === localStorage.getItem("token");
  }
  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }
  disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }
  private async json(url: string, body?: unknown) {
    const response = await authFetch(
      url,
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const value = await response.json();
    if (!response.ok)
      throw Object.assign(Error(value.error ?? "请求失败"), { status: response.status });
    return value;
  }
  private async work(fn: () => Promise<void>) {
    if (this.busy) return;
    if (localStorage.getItem("token") !== this.token) {
      await this.load();
      return;
    }
    const g = this.generation,
      t = this.token;
    this.busy = true;
    this.error = "";
    try {
      await fn();
    } catch (e) {
      if (this.current(g, t)) this.error = (e as Error).message;
    } finally {
      if (this.current(g, t)) this.busy = false;
    }
  }
  async load() {
    const g = ++this.generation,
      t = (this.token = localStorage.getItem("token") ?? "");
    this.busy = true;
    this.error = "";
    this.catalog = [];
    this.inventory = [];
    this.editor = null;
    this.batch = null;
    this.selected = new Set();
    this.difference = null;
    this.inherited = null;
    this.pending = null;
    try {
      const catalogRequest = async () => {
        const templates: any[] = [];
        let cursor = "";
        do {
          const page = await this.json(
            "/api/metrics/templates?limit=50" +
              (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
          );
          templates.push(...page.templates);
          cursor = page.next_cursor ?? "";
        } while (cursor);
        return { templates };
      };
      const [catalog, inventory] = await Promise.all([
        catalogRequest(),
        this.json("/api/metrics/template-governance/resources"),
      ]);
      const pending = sessionStorage.getItem(this.key());
      if (!this.current(g, t)) return;
      this.catalog = catalog.templates;
      this.inventory = inventory;
      if (pending) {
        try {
          this.pending = JSON.parse(pending);
          if (
            typeof this.pending.url !== "string" ||
            !/^\/api\/metrics\/(templates|template-governance)\//.test(this.pending.url) ||
            !this.pending.body ||
            typeof this.pending.body !== "object"
          )
            throw Error("invalid");
        } catch {
          this.pending = { corrupt: true };
          this.error = "操作恢复记录损坏，已停止写入，请保留记录并核对结果。";
        }
      }
      const saved = sessionStorage.getItem(this.key() + ".batch");
      if (saved) {
        const batch = await this.json("/api/metrics/template-governance/batches/" + saved);
        if (this.current(g, t)) {
          this.batch = batch;
          this.inventory = this.inventory.map((r) => ({
            ...r,
            revision:
              batch.items.find((i: any) => i.resource.type === r.type && i.resource.id === r.id)
                ?.status.revision ?? r.revision,
          }));
        }
      }
    } catch (e) {
      if (this.current(g, t)) this.error = (e as Error).message;
    } finally {
      if (this.current(g, t)) this.busy = false;
    }
  }
  private async open() {
    await this.work(async () => {
      const g = this.generation,
        t = this.token,
        id = this.template;
      const editor = await this.json(`/api/metrics/templates/${id}/editor`);
      if (!this.current(g, t)) return;
      this.editor = editor;
      this.base = editor.draft.aggregate.base ? JSON.stringify(editor.draft.aggregate.base) : "";
      this.inherited = null;
      const inherited = await this.json(
        `/api/metrics/template-governance/templates/${id}/inheritance`,
      );
      if (!this.current(g, t)) return;
      this.editor = editor;
      this.inherited = inherited;
      this.base = editor.draft.aggregate.base ? JSON.stringify(editor.draft.aggregate.base) : "";
      this.from = String(editor.versions[0]?.version ?? "");
      this.to = String(editor.versions.at(-1)?.version ?? "");
      this.difference = null;
    });
  }
  private async mutate(url: string, body: any) {
    if (this.pending) throw Error("请先核对待恢复操作");
    const intent = { url, body };
    sessionStorage.setItem(this.key(), JSON.stringify(intent));
    this.pending = intent;
    await this.send(intent);
  }
  private async send(intent: any) {
    const g = this.generation,
      t = this.token;
    try {
      const result = await this.json(intent.url, intent.body);
      if (!this.current(g, t)) return;
      sessionStorage.removeItem(this.key());
      this.pending = null;
      if (intent.url.endsWith("/batches")) {
        sessionStorage.setItem(this.key() + ".batch", result.id);
        const batch = await this.json("/api/metrics/template-governance/batches/" + result.id);
        if (this.current(g, t)) {
          this.batch = batch;
          this.inventory = this.inventory.map((r) => ({
            ...r,
            revision:
              batch.items.find((i: any) => i.resource.type === r.type && i.resource.id === r.id)
                ?.status.revision ?? r.revision,
          }));
        }
      } else if (intent.url.includes("/batches/")) {
        const batch = await this.json(
          "/api/metrics/template-governance/batches/" +
            intent.url.split("/batches/")[1].split("/")[0],
        );
        if (this.current(g, t)) {
          this.batch = batch;
          this.inventory = this.inventory.map((r) => ({
            ...r,
            revision:
              batch.items.find((i: any) => i.resource.type === r.type && i.resource.id === r.id)
                ?.status.revision ?? r.revision,
          }));
        }
      } else {
        const id = intent.url.split("/templates/")[1].split("/")[0];
        const editor = await this.json(`/api/metrics/templates/${id}/editor`);
        if (!this.current(g, t)) return;
        this.editor = editor;
        this.base = editor.draft.aggregate.base ? JSON.stringify(editor.draft.aggregate.base) : "";
        this.inherited = null;
        const inherited = await this.json(
          `/api/metrics/template-governance/templates/${id}/inheritance`,
        );
        if (!this.current(g, t)) return;
        this.editor = editor;
        this.inherited = inherited;
        this.base = editor.draft.aggregate.base ? JSON.stringify(editor.draft.aggregate.base) : "";
        this.from = String(editor.versions[0]?.version ?? "");
        this.to = String(result.published?.version ?? editor.versions.at(-1)?.version ?? "");
        this.notice = "模板操作已保存；发布不会自动升级资源。";
      }
    } catch (e) {
      if (this.current(g, t)) {
        if (Number((e as any).status) >= 400 && Number((e as any).status) < 500) {
          sessionStorage.removeItem(this.key());
          this.pending = null;
        }
        throw Error(
          this.pending ? `结果未知，请按原操作恢复：${(e as Error).message}` : (e as Error).message,
        );
      }
    }
  }
  private async saveInheritance(restore = false, override = false) {
    await this.work(async () => {
      const aggregate = structuredClone(this.editor.draft.aggregate);
      aggregate.base = this.base ? JSON.parse(this.base) : null;
      if (restore) {
        aggregate.items = [];
        aggregate.triggers = [];
        aggregate.parameters = { schema: {}, defaults: {} };
      }
      if (override) {
        const spec = this.inherited.aggregate.parameters.schema[this.parameter];
        if (!spec) throw Error("请先选择参数");
        if (spec.type === "boolean" && !["true", "false"].includes(this.parameterValue))
          throw Error("布尔参数仅接受 true 或 false");
        aggregate.parameters.schema[this.parameter] = spec;
        aggregate.parameters.defaults[this.parameter] =
          spec.type === "string"
            ? this.parameterValue
            : spec.type === "boolean"
              ? this.parameterValue === "true"
              : Number(this.parameterValue);
      }
      await this.mutate(`/api/metrics/templates/${this.template}/draft`, {
        operation_key: crypto.randomUUID(),
        expected_draft_revision: this.editor.draft.revision,
        aggregate,
      });
    });
  }
  private async compare() {
    await this.work(async () => {
      const g = this.generation,
        t = this.token;
      const result = await this.json(
        `/api/metrics/template-governance/templates/${this.template}/diff?from=${this.from}&to=${this.to}`,
      );
      if (this.current(g, t)) this.difference = result;
    });
  }
  private input() {
    const version = this.editor.versions.find((v: any) => String(v.version) === this.to);
    if (!version) throw Error("请选择已发布目标版本");
    return {
      operation_key: crypto.randomUUID(),
      pins: [
        {
          template_id: this.template,
          version: version.version,
          content_hash: version.content_hash,
        },
      ],
      resources: this.inventory
        .filter((r) => this.selected.has(`${r.type}:${r.id}`))
        .map((r) => ({ resource: { type: r.type, id: r.id }, expected_revision: r.revision })),
    };
  }
  private async checkImpact() {
    const g = this.generation,
      t = this.token;
    this.review = null;
    await this.work(async () => {
      const input = this.input();
      const result = await this.json("/api/metrics/template-governance/preview", input);
      if (this.current(g, t)) this.review = { input, ...result };
    });
    await this.updateComplete;
    if (this.review && this.current(g, t)) {
      (this.renderRoot.querySelector("[data-impact]") as HTMLElement)?.focus();
      this.confirmation = true;
    }
  }
  private async closeConfirmation() {
    const g = this.generation,
      t = this.token;
    this.confirmation = false;
    await this.updateComplete;
    await (this.renderRoot.querySelector("app-dialog") as LitElement)?.updateComplete;
    if (this.current(g, t))
      (this.renderRoot.querySelector("[data-impact]") as HTMLElement)?.focus();
  }
  private async createBatch() {
    this.confirmation = false;
    await this.work(async () => {
      await this.mutate("/api/metrics/template-governance/batches", this.review.input);
    });
  }
  private async step(item: any, action = "apply") {
    await this.work(async () => {
      await this.mutate(
        `/api/metrics/template-governance/batches/${this.batch.id}/${item.resource.type}/${item.resource.id}`,
        { action, operation_key: crypto.randomUUID() },
      );
    });
  }
  private async bulk() {
    await this.work(async () => {
      const id = this.batch.id;
      for (const item of this.batch.items) {
        if (this.pending) break;
        if (!["ready", "failed"].includes(item.state)) continue;
        await this.mutate(
          `/api/metrics/template-governance/batches/${id}/${item.resource.type}/${item.resource.id}`,
          {
            action: item.state === "failed" ? "retry" : "apply",
            operation_key: crypto.randomUUID(),
          },
        );
        if (this.batch.items.some((i: any) => i.state === "unknown")) break;
      }
    });
  }
  private async refreshBatch() {
    await this.work(async () => {
      const g = this.generation,
        t = this.token;
      const batch = await this.json("/api/metrics/template-governance/batches/" + this.batch.id);
      if (this.current(g, t)) {
        this.batch = batch;
        this.inventory = this.inventory.map((r) => ({
          ...r,
          revision:
            batch.items.find((i: any) => i.resource.type === r.type && i.resource.id === r.id)
              ?.status.revision ?? r.revision,
        }));
      }
    });
  }
  private differenceView() {
    const d = this.difference;
    if (!d) return nothing;
    const keys = [
      ...new Set([
        ...Object.keys(d.parameters.before.defaults),
        ...Object.keys(d.parameters.after.defaults),
      ]),
    ];
    return html`<section aria-label="版本差异">
      <h4>不可变差异与授权影响资源</h4>
      <p>
        v${d.from.version} → v${d.to.version}；${d.changes.length} 项采集定义变化，阈值规则
        ${d.triggers.before.length} → ${d.triggers.after.length}；${d.affected.length}
        个授权资源仍绑定起始版本。
      </p>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>参数</th>
              <th>起始版本默认值</th>
              <th>目标版本默认值</th>
            </tr>
          </thead>
          <tbody>
            ${keys.map(
              (k) =>
                html`<tr>
                  <td>${k}</td>
                  <td>${String(d.parameters.before.defaults[k] ?? "未配置")}</td>
                  <td>${String(d.parameters.after.defaults[k] ?? "未配置")}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      ${d.changes.map((v: any) => html`<p>${{ added: "新增", deleted: "移除", changed: "修改" }[v.kind as "added" | "deleted" | "changed"]}：${v.after?.display_name ?? v.before?.display_name}（${v.after?.canonical_metric.id ?? v.before?.canonical_metric.id}），单位 ${v.before?.unit ?? "无"} → ${v.after?.unit ?? "无"}</p>`)}
      <p>
        采集发布组合 ${d.load.before.length} →
        ${d.load.after.length}；具体读取量、参数来源和组合冲突在灰度影响确认中按资源校验。
      </p>
      <details>
        <summary>查看不可变版本、阈值与绑定证据</summary>
        <pre>${JSON.stringify(d, null, 2)}</pre>
      </details>
    </section>`;
  }
  private sourceName(source: any) {
    if (!source) return "未配置";
    return `${this.catalog.find((t) => t.template_id === source.template_id)?.name ?? source.template_id} · ${source.version === null ? "本地草稿" : "v" + source.version}`;
  }
  render() {
    const e = this.editor;
    return html`<h2>模板继承与灰度治理</h2>
      <p>
        发布固定版本不自动升级资源。先选灰度资源，核对差异；逐项提交后等待真实应用回执，失败保留前版。回退同样需要试采与应用。
      </p>
      ${this.error ? html`<p role="alert" class="error">${this.error}</p>` : nothing}${this.notice ? html`<p role="status">${this.notice}</p>` : nothing}${this.busy ? html`<p role="status">正在读取或处理，请稍候…</p>` : nothing}
      <button class="btn btn-refresh" ?disabled=${this.busy} @click=${() => this.load()}>
        刷新治理
      </button>
      ${this.pending ? html`<button class="btn" ?disabled=${this.busy || this.pending.corrupt} @click=${() => this.work(() => this.send(this.pending))}>按原操作恢复结果</button>` : nothing}
      <div class="toolbar">
        <label
          >治理模板<select
            aria-label="治理模板"
            .value=${this.template}
            ?disabled=${this.busy}
            @change=${(ev: any) => {
              this.template = ev.target.value;
              this.editor = null;
              this.difference = null;
            }}
          >
            <option value="">请选择模板</option>
            ${this.catalog.map((t) => html`<option value=${t.template_id}>${t.name}</option>`)}
          </select></label
        ><button class="btn" ?disabled=${this.busy || !this.template} @click=${() => this.open()}>
          读取模板
        </button>
      </div>
      ${
        e
          ? html`<h3>${e.template.name} · 草稿 ${e.draft.revision}</h3>
              <label
                >固定基础版本<select
                  aria-label="固定基础版本"
                  .value=${this.base}
                  ?disabled=${this.busy || !!this.pending || e.builtin || !e.can_manage}
                  @change=${(ev: any) => (this.base = ev.target.value)}
                >
                  <option value="">无基础版本</option>
                  ${this.catalog.filter((t) => t.template_id !== this.template).flatMap((t) => t.versions.map((v: any) => html`<option value=${JSON.stringify({ template_id: t.template_id, version: v.version })}>${t.name} v${v.version}</option>`))}
                </select></label
              >
              <button
                class="btn"
                ?disabled=${this.busy || !!this.pending || e.builtin || !e.can_manage}
                @click=${() => this.saveInheritance()}
              >
                保存基础版本
              </button>
              <button
                class="btn"
                ?disabled=${this.busy || !!this.pending || !this.base || e.builtin || !e.can_manage}
                @click=${() => this.saveInheritance(true)}
              >
                恢复基础项和参数
              </button>
              <details>
                <summary>参数与项来源（当前保存草稿）</summary>
                <div class="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>参数 / 采集项</th>
                        <th>默认值</th>
                        <th>来源</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${Object.entries(this.inherited?.origins.parameters ?? {}).map(
                        ([name, source]) =>
                          html`<tr>
                            <td>${name}</td>
                            <td>
                              ${String(this.inherited.aggregate.parameters.defaults[name] ?? "未配置（需资源覆盖）")}
                            </td>
                            <td>${this.sourceName(source)}</td>
                          </tr>`,
                      )}${Object.entries(this.inherited?.origins.items ?? {}).map(
                        ([name, source]) =>
                          html`<tr>
                            <td>${name}</td>
                            <td>采集项</td>
                            <td>${this.sourceName(source)}</td>
                          </tr>`,
                      )}
                    </tbody>
                  </table>
                </div>
              </details>
              <div class="toolbar">
                <label
                  >覆盖参数<select
                    aria-label="覆盖参数"
                    .value=${this.parameter}
                    @change=${(ev: any) => (this.parameter = ev.target.value)}
                  >
                    ${Object.keys(this.inherited?.aggregate.parameters.schema ?? {}).map((k) => html`<option>${k}</option>`)}
                  </select></label
                ><label
                  >参数值<input
                    aria-label="参数值"
                    .value=${this.parameterValue}
                    @input=${(ev: any) => (this.parameterValue = ev.target.value)} /></label
                ><button
                  class="btn"
                  ?disabled=${this.busy || !!this.pending || !this.inherited || e.builtin || !e.can_manage}
                  @click=${() => this.saveInheritance(false, true)}
                >
                  保存参数覆盖
                </button>
              </div>
              <button
                class="btn-primary"
                ?disabled=${this.busy || !!this.pending || e.builtin || !e.can_manage}
                @click=${() => this.work(() => this.mutate(`/api/metrics/templates/${this.template}/publish`, { operation_key: crypto.randomUUID(), expected_revision: e.template.revision, expected_draft_revision: e.draft.revision }))}
              >
                发布治理版本
              </button>
              <div class="toolbar">
                ${(["from", "to"] as const).map(
                  (k) =>
                    html`<label
                      >${k === "from" ? "比较起始版本" : "灰度目标版本"}<select
                        aria-label=${k === "from" ? "比较起始版本" : "灰度目标版本"}
                        .value=${this[k]}
                        @change=${(ev: any) => (this[k] = ev.target.value)}
                      >
                        ${e.versions.map((v: any) => html`<option value=${v.version}>v${v.version}</option>`)}
                      </select></label
                    >`,
                )}<button
                  class="btn"
                  ?disabled=${this.busy || !this.from || !this.to}
                  @click=${() => this.compare()}
                >
                  比较版本与影响
                </button>
              </div>
              ${this.differenceView()}
              <h3>灰度资源选择</h3>
              ${
                !this.inventory.length
                  ? html`<p>暂无可管理资源</p>`
                  : this.inventory.map(
                      (r) =>
                        html`<label
                          ><input
                            type="checkbox"
                            aria-label=${`灰度 ${r.name}`}
                            .checked=${this.selected.has(`${r.type}:${r.id}`)}
                            ?disabled=${this.busy}
                            @change=${(ev: any) => {
                              const next = new Set(this.selected);
                              ev.target.checked
                                ? next.add(`${r.type}:${r.id}`)
                                : next.delete(`${r.type}:${r.id}`);
                              this.selected = next;
                            }}
                          />
                          ${r.name} · revision ${r.revision}</label
                        >`,
                    )
              }
              <button
                data-impact
                class="btn-primary"
                ?disabled=${this.busy || !!this.pending || !this.selected.size || !this.to}
                @click=${() => this.checkImpact()}
              >
                检查灰度影响
              </button>`
          : nothing
      }
      ${
        this.batch
          ? html`<h3>逐资源应用回执</h3>
              <button
                class="btn-primary"
                ?disabled=${this.busy || !!this.pending}
                @click=${() => this.bulk()}
              >
                批量应用待处理资源</button
              ><button class="btn" ?disabled=${this.busy} @click=${() => this.refreshBatch()}>
                查询真实回执
              </button>
              <p>“submitted / pending”只表示已提交，applied才是正式采集生效。unknown先恢复结果。</p>
              <div class="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>资源</th>
                      <th>状态 / 回执</th>
                      <th>目标 / 有效 revision</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.batch.items.map(
                      (i: any) =>
                        html`<tr>
                          <td>
                            ${this.inventory.find((r) => r.type === i.resource.type && r.id === i.resource.id)?.name ?? `${i.resource.type}:${i.resource.id}`}
                          </td>
                          <td>${i.state} / ${i.receipt}<br />${i.error ?? ""}</td>
                          <td>
                            ${i.target_revision ?? "未提交"} /
                            ${i.status.effective?.revision ?? "无"}
                          </td>
                          <td>
                            ${["apply", "retry", "rollback"].map((action) => html`<button class="btn" ?disabled=${this.busy || !!this.pending} @click=${() => this.step(i, action)}>${action === "apply" ? "应用 / 核对" : action === "retry" ? "重试失败项" : "回退前版"}</button>`)}
                          </td>
                        </tr>`,
                    )}
                  </tbody>
                </table>
              </div>`
          : nothing
      }
      <app-dialog
        .open=${this.confirmation}
        title="确认灰度范围"
        @app-dialog-close=${() => this.closeConfirmation()}
        ><p>
          将仅修改所选 ${this.selected.size} 个资源，目标
          v${this.to}；每项单独校验权限、版本和试采。其他资源不自动升级。应用与生效分开显示。
        </p>
        ${this.review?.resources.map(
          (r: any) =>
            html`<p>
                ${this.inventory.find((v) => v.type === r.resource.type && v.id === r.resource.id)?.name}：${r.error ? `预览拒绝：${r.error}` : `估计读取/小时 ${r.before?.budget.requests_per_hour_estimate ?? "无模板基线"} → ${r.after?.budget.requests_per_hour_estimate}；可执行 ${r.after?.executable ? "是" : "待探测"}`}
              </p>
              <details>
                <summary>生效参数与来源</summary>
                <pre>
${JSON.stringify(r.conflicts?.length ? r.conflicts : (r.after?.parameters ?? null), null, 2)}</pre>
              </details>`,
        )}<button slot="footer" class="btn" @click=${() => this.closeConfirmation()}>
          返回选择</button
        ><button slot="footer" class="btn-primary" @click=${() => this.createBatch()}>
          确认创建灰度批次
        </button></app-dialog
      >`;
  }
}
