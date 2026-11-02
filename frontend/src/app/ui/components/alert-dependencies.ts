import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import "./app-dialog.js";
@customElement("alert-dependencies")
export class AlertDependencies extends LitElement {
  static styles = [
    sharedBtnStyles,
    css`
      :host {
        display: block;
        color: var(--text);
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      td,
      th {
        text-align: left;
        padding: var(--space-md);
        border-bottom: 1px solid var(--border);
      }
      .scroll {
        overflow: auto;
      }
      .actions {
        display: flex;
        gap: var(--space-sm);
        margin: var(--space-md) 0;
      }
      label {
        display: block;
        margin: var(--space-md) 0;
      }
      input,
      select {
        width: 100%;
        box-sizing: border-box;
        padding: var(--space-sm);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg);
        color: var(--text);
      }
      .error {
        color: var(--danger);
      }
    `,
  ];
  @state() private rows: any[] = [];
  @state() private resources: any[] = [];
  @state() private draft: any = null;
  @state() private pending: any = null;
  @state() private busy = false;
  @state() private error = "";
  private generation = 0;
  private session = "";
  private storageKey() {
    const c = JSON.parse(atob(this.session.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (!c.userId) throw Error("无法确定主体");
    return `slide.dependencies.${c.userId}.${c.sessionVersion}`;
  }
  private current(g: number, s: string) {
    return this.isConnected && g === this.generation && localStorage.getItem("token") === s;
  }
  private onStorage = (e: StorageEvent) => {
    if (e.key === "token") void this.load();
  };
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("storage", this.onStorage);
    void this.load();
  }
  disconnectedCallback() {
    window.removeEventListener("storage", this.onStorage);
    this.generation++;
    super.disconnectedCallback();
  }
  private async json(path: string, options?: RequestInit) {
    const r = await authFetch("/api/alerts/dependencies" + path, options);
    const v = await r.json();
    if (!r.ok)
      throw Object.assign(
        Error(
          (
            {
              DEPENDENCY_CYCLE: "依赖将形成环，无法保存",
              DEPENDENCY_FORBIDDEN: "资源权限已变化，请刷新后重新选择",
              DEPENDENCY_REVISION: "配置已更新，请刷新后重试",
              DEPENDENCY_RULE_MISSING: "所选规则不再可用，请重新选择",
              DEPENDENCY_STATE_UNKNOWN: "依赖状态暂时无法查询，请重试",
            } as Record<string, string>
          )[v.error] ?? "依赖操作失败，请刷新后重试",
        ),
        { status: r.status },
      );
    return v;
  }
  async load() {
    const token = localStorage.getItem("token") ?? "";
    if (token !== this.session) {
      this.rows = [];
      this.resources = [];
      this.draft = null;
      this.pending = null;
    }
    const g = ++this.generation,
      s = (this.session = token);
    this.busy = true;
    this.error = "";
    this.rows = [];
    this.resources = [];
    try {
      const [rows, resources] = await Promise.all([this.json(""), this.json("/resources")]);
      if (!this.current(g, s)) return;
      this.rows = rows;
      this.resources = resources;
      const saved = sessionStorage.getItem(this.storageKey());
      this.pending = null;
      if (saved) {
        try {
          const v = JSON.parse(saved);
          if (
            !v.body?.operation_key ||
            !Number.isSafeInteger(v.body.expected_revision) ||
            !(v.id === null || typeof v.id === "string")
          )
            throw Error();
          this.pending = v;
        } catch {
          this.pending = { corrupt: true };
          this.error = "操作记录损坏，请保留记录并联系管理员核对。";
        }
      }
    } catch (e) {
      if (this.current(g, s)) this.error = (e as Error).message;
    } finally {
      if (this.current(g, s)) this.busy = false;
    }
  }
  private edit(row?: any) {
    if (localStorage.getItem("token") !== this.session) {
      void this.load();
      return;
    }
    if (this.busy || this.pending) return;
    this.draft = row
      ? structuredClone(row)
      : {
          revision: 0,
          name: "",
          upstream: { resource: null, rule_id: "*" },
          downstream: { resource: null, rule_id: "*" },
        };
    this.error = "";
  }
  private endpoint(side: string, value: string) {
    const r = this.resources.find((r) => `${r.type}:${r.id}` === value);
    this.draft = {
      ...this.draft,
      [side]: { resource: r ? { type: r.type, id: r.id } : null, rule_id: "*" },
    };
  }
  private async save(row = this.draft, disabled = false) {
    if (this.busy || this.pending) return;
    if (localStorage.getItem("token") !== this.session) {
      await this.load();
      this.error = "登录主体已变化，请重新选择";
      return;
    }
    if (!disabled && (!row.name.trim() || !row.upstream.resource || !row.downstream.resource)) {
      this.error = "请选择上下游授权资源并填写名称";
      return;
    }
    const intent = {
      id: row.id ?? null,
      body: {
        operation_key: crypto.randomUUID(),
        expected_revision: row.revision,
        ...(disabled
          ? { disabled: true }
          : { value: { name: row.name, upstream: row.upstream, downstream: row.downstream } }),
      },
    };
    try {
      sessionStorage.setItem(this.storageKey(), JSON.stringify(intent));
      this.pending = intent;
      await this.send(intent);
    } catch (e) {
      this.error = (e as Error).message;
    }
  }
  private async send(intent: any) {
    const g = this.generation,
      s = this.session;
    this.busy = true;
    try {
      await this.json(intent.id ? `/${intent.id}` : "", {
        method: intent.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(intent.body),
      });
      if (!this.current(g, s)) return;
      sessionStorage.removeItem(this.storageKey());
      this.pending = null;
      this.draft = null;
      await this.load();
    } catch (e) {
      if (!this.current(g, s)) return;
      const status = (e as any).status;
      if (status >= 400 && status < 500) {
        sessionStorage.removeItem(this.storageKey());
        this.pending = null;
      }
      if (this.pending) this.draft = null;
      this.error = this.pending
        ? "结果未知，请核对原操作，勿重复新建。"
        : `未保存：${(e as Error).message}。请刷新权限和版本。`;
    } finally {
      if (this.current(g, s)) this.busy = false;
    }
  }
  private async recover() {
    const g = this.generation,
      s = this.session,
      intent = this.pending;
    if (!intent || intent.corrupt || this.busy) return;
    this.busy = true;
    try {
      const v = await this.json("/operations/" + encodeURIComponent(intent.body.operation_key));
      if (!this.current(g, s)) return;
      if (v.status === "committed") {
        sessionStorage.removeItem(this.storageKey());
        this.pending = null;
        this.draft = null;
        await this.load();
      } else {
        this.busy = false;
        await this.send(intent);
      }
    } catch (e) {
      if (this.current(g, s)) this.error = (e as Error).message;
    } finally {
      if (this.current(g, s)) this.busy = false;
    }
  }
  private label(e: any) {
    const r = this.resources.find((r) => r.type === e.resource?.type && r.id === e.resource?.id);
    return `${r?.name ?? e.resource?.type + ":" + e.resource?.id} / ${e.rule_id === "*" ? "全部规则" : e.rule_id}`;
  }
  render() {
    const d = this.draft;
    return html` <p>
        上游存在问题时，仅阻止新下游问题。保留采样和已有问题；确认、维护、恢复各自独立。依赖表示抑制关系，不代表根因。
      </p>
      <div class="actions">
        <button
          class="btn-primary"
          .disabled=${this.busy || !!this.pending}
          @click=${() => this.edit()}
        >
          新增依赖</button
        ><button class="btn btn-refresh" .disabled=${this.busy} @click=${this.load}>
          刷新依赖
        </button>
      </div>
      ${this.busy ? html`<p role="status">加载或保存中…</p>` : ""}${this.error ? html`<p role="alert" class="error">${this.error}</p>` : ""}
      ${this.pending ? html`<button class="btn" .disabled=${this.busy || this.pending.corrupt} @click=${this.recover}>核对操作结果</button>` : ""}
      ${!this.busy && !this.error && !this.rows.length ? html`<p>暂无依赖，请选择有管理权限的上下游资源。</p>` : ""}
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>名称 / 来源</th>
              <th>上游范围</th>
              <th>下游范围</th>
              <th>状态 / 版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${this.rows.map(
              (v) =>
                html`<tr>
                  <td>${v.name}<br />资源规则配置 · 主体 ${v.actor_id}</td>
                  <td>${this.label(v.upstream)}</td>
                  <td>${this.label(v.downstream)}</td>
                  <td>${v.disabled ? "已禁用" : "启用"} / ${v.revision}</td>
                  <td>
                    <button
                      class="btn-ghost"
                      .disabled=${this.busy || !!this.pending}
                      @click=${() => this.edit(v)}
                    >
                      修改</button
                    ><button
                      class="btn-ghost"
                      .disabled=${v.disabled || this.busy || !!this.pending}
                      @click=${() => this.save(v, true)}
                    >
                      禁用
                    </button>
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <app-dialog
        .open=${!!d}
        title="配置依赖"
        @app-dialog-close=${() => {
          if (!this.busy) this.draft = null;
        }}
      >
        ${
          d
            ? html`${this.error ? html`<p role="alert" class="error">${this.error}</p>` : ""}<label
                  >依赖名称<input
                    aria-label="依赖名称"
                    .value=${d.name}
                    @input=${(e: Event) => (this.draft = { ...d, name: (e.target as HTMLInputElement).value })}
                /></label>
                ${["upstream", "downstream"].map((side) => {
                  const r = this.resources.find(
                      (r) => r.type === d[side].resource?.type && r.id === d[side].resource?.id,
                    ),
                    name = side === "upstream" ? "上游" : "下游";
                  return html`<label
                      >${name}资源<select
                        aria-label="${name}资源"
                        .value=${r ? `${r.type}:${r.id}` : ""}
                        @change=${(e: Event) => this.endpoint(side, (e.target as HTMLSelectElement).value)}
                      >
                        <option value="">选择授权资源</option>
                        ${this.resources.map((r) => html`<option value="${r.type}:${r.id}">${r.name} (${r.type}:${r.id})</option>`)}
                      </select></label
                    ><label
                      >${name}规则<select
                        aria-label="${name}规则"
                        .value=${d[side].rule_id}
                        @change=${(e: Event) => (this.draft = { ...d, [side]: { ...d[side], rule_id: (e.target as HTMLSelectElement).value } })}
                      >
                        ${(r?.rules ?? [{ id: "*", source: "全部规则" }]).map((v: any) => html`<option value="${v.id}">${v.id} · ${v.source}</option>`)}
                      </select></label
                    >`;
                })}
                <p>保存后仅影响新问题。禁用不会关闭既有问题或补发历史通知。</p>
                <div slot="footer">
                  <button class="btn" .disabled=${this.busy} @click=${() => (this.draft = null)}>
                    取消</button
                  ><button
                    class="btn-primary"
                    .disabled=${this.busy || !!this.pending}
                    @click=${() => this.save()}
                  >
                    保存依赖
                  </button>
                </div>`
            : ""
        }
      </app-dialog>`;
  }
}
