import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import "./app-dialog.js";
import "./app-form-field.js";
type Resource = { type: string; id: number; name: string };
@customElement("maintenance-windows")
export class MaintenanceWindows extends LitElement {
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
        padding: var(--space-md);
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      input,
      select,
      textarea {
        box-sizing: border-box;
        width: 100%;
        padding: var(--space-sm);
        color: var(--text);
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      label {
        display: block;
        margin: var(--space-md) 0;
      }
      .error {
        color: var(--danger);
      }
      .actions {
        display: flex;
        gap: var(--space-sm);
        margin: var(--space-md) 0;
      }
    `,
  ];
  @state() private rows: any[] = [];
  @state() private resources: Resource[] = [];
  @state() private draft: any = null;
  @state() private error = "";
  @state() private busy = false;
  @state() private impact = false;
  @state() private pending: any = null;
  private generation = 0;
  private session = "";
  private storageKey() {
    const token = localStorage.getItem("token");
    if (!token) throw Error("请重新登录后操作");
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (!claims.userId || !claims.sessionVersion) throw Error("无法确认登录主体");
    return `slide.maintenance.${claims.userId}.${claims.sessionVersion}`;
  }
  private current(g: number, s: string) {
    return this.isConnected && g === this.generation && localStorage.getItem("token") === s;
  }
  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }
  disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }
  private async json(path: string, options?: RequestInit) {
    const r = await authFetch(path, options);
    const v = await r.json();
    if (!r.ok) {
      const error = Object.assign(Error(v.error ?? "请求失败"), { status: r.status });
      throw error;
    }
    return v;
  }
  async load() {
    const token = localStorage.getItem("token") ?? "";
    if (token !== this.session) {
      this.draft = null;
      this.pending = null;
      this.rows = [];
      this.resources = [];
    }
    const g = ++this.generation,
      s = (this.session = token);
    this.busy = true;
    this.error = "";
    try {
      const rows = await this.json("/api/maintenance-windows");
      const inventory = await this.json("/api/maintenance-windows/resources");
      if (!this.current(g, s)) return;
      this.rows = rows;
      this.resources = inventory;
      const saved = sessionStorage.getItem(this.storageKey());
      if (saved) {
        try {
          const intent = JSON.parse(saved);
          if (!intent || !intent.body || typeof intent.body.operation_key !== 'string' ||
              !Number.isSafeInteger(intent.body.expected_revision) ||
              !(intent.id === null || typeof intent.id === 'string')) throw Error('invalid intent');
          this.pending = intent;
        } catch {
          this.pending = { corrupt: true };
          this.error = '本地操作记录损坏，无法确认上次结果，已停止写入。请保留记录并联系管理员核对。';
        }
      } else this.pending = null;
    } catch (e) {
      if (this.current(g, s)) this.error = (e as Error).message;
    } finally {
      if (this.current(g, s)) this.busy = false;
    }
  }
  private edit(row?: any) {
    if (this.pending) return;
    const now = Date.now();
    this.draft = row
      ? structuredClone(row)
      : {
          name: "",
          reason: "",
          resources: [],
          timezone: "Asia/Shanghai",
          starts_at: new Date(now + 60000).toISOString(),
          ends_at: new Date(now + 3600000).toISOString(),
          revision: 0,
        };
    this.impact = false;
    this.error = "";
  }
  private field(k: string, v: any) {
    this.draft = { ...this.draft, [k]: v };
    this.impact = false;
  }
  private async save(cancel = false, row = this.draft) {
    if (localStorage.getItem("token") !== this.session) {
      this.draft = null;
      await this.load();
      this.error = "登录主体已变化，请重新选择维护范围";
      return;
    }
    if (this.busy || this.pending) return;
    if (!cancel && !this.impact) {
      this.impact = true;
      return;
    }
    const value = {
      name: row.name,
      reason: row.reason,
      resources: row.resources,
      timezone: row.timezone,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
    };
    const intent = {
      id: row.id ?? null,
      body: {
        operation_key: crypto.randomUUID(),
        expected_revision: row.revision,
        ...(cancel ? { cancel: true } : { value }),
      },
    };
    try {
      sessionStorage.setItem(this.storageKey(), JSON.stringify(intent));
      this.pending = intent;
    } catch {
      this.error = "无法保存操作标识，尚未发送。请恢复浏览器存储后重试。";
      return;
    }
    await this.send(intent);
  }
  private async send(intent: any) {
    const g = this.generation,
      s = this.session;
    this.busy = true;
    try {
      await this.json(`/api/maintenance-windows${intent.id ? `/${intent.id}` : ""}`, {
        method: intent.body.cancel ? "DELETE" : intent.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(intent.body),
      });
      if (!this.current(g, s)) return;
      sessionStorage.removeItem(this.storageKey());
      this.pending = null;
      this.draft = null;
      await this.load();
    } catch (e) {
      if (
        this.current(g, s) &&
        Number((e as any).status) >= 400 &&
        Number((e as any).status) < 500
      ) {
        sessionStorage.removeItem(this.storageKey());
        this.pending = null;
      }
      if (this.current(g, s))
        this.error = this.pending
          ? `结果待核对：${(e as Error).message}。请查询操作结果，勿重复新建。`
          : `保存未提交：${(e as Error).message}。请刷新当前权限和版本后重试。`;
    } finally {
      if (this.current(g, s)) this.busy = false;
    }
  }
  private async recover() {
    const intent = this.pending,
      g = this.generation,
      s = this.session;
    if (!intent || intent.corrupt) return;
    this.busy = true;
    try {
      const result = await this.json(
        `/api/maintenance-windows/operations/${encodeURIComponent(intent.body.operation_key)}`,
      );
      if (!this.current(g, s)) return;
      if (result.status === "committed") {
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
  render() {
    const d = this.draft;
    return html` <h3>维护窗口</h3>
      <p>
        维护期间继续采集并记录问题，仅抑制通知。结束后按当前事实重新评估，不补发维护期间的问题通知。
      </p>
      ${this.error ? html`<p role="alert" class="error">${this.error}</p>` : ""}
      <div class="actions">
        <button class="btn btn-refresh" ?disabled=${this.busy} @click=${() => this.load()}>
          刷新</button
        ><button
          class="btn-primary"
          ?disabled=${this.busy || !!this.pending}
          @click=${() => this.edit()}
        >
          新建维护窗口</button
        >${this.pending ? html`<button class="btn" ?disabled=${this.busy} @click=${() => this.recover()}>查询操作结果</button>` : ""}
      </div>
      <table>
        <thead>
          <tr>
            <th>名称 / 原因</th>
            <th>资源范围</th>
            <th>期限 / 时区</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${this.rows.map(
            (r) =>
              html`<tr>
                <td>${r.name}<br />${r.reason}</td>
                <td>
                  ${r.resources ? r.resources.map((ref: any) => this.resources.find((v) => v.type === ref.type && v.id === ref.id)?.name ?? `${ref.type}:${ref.id}`).join("、") : "全局"}
                </td>
                <td>
                  ${new Date(r.starts_at).toLocaleString("zh-CN", { timeZone: r.timezone, hour12: false })}<br />${new Date(r.ends_at).toLocaleString("zh-CN", { timeZone: r.timezone, hour12: false })}<br />${r.timezone}
                </td>
                <td>
                  ${r.cancelled_at ? "已取消" : Date.parse(r.ends_at) <= Date.now() ? "已结束" : Date.parse(r.starts_at) > Date.now() ? "待开始" : "维护中"}
                </td>
                <td>
                  <button
                    class="btn"
                    ?disabled=${this.busy || !!this.pending || !!r.cancelled_at}
                    @click=${() => this.edit(r)}
                  >
                    编辑</button
                  ><button
                    class="btn"
                    ?disabled=${this.busy || !!this.pending || !!r.cancelled_at}
                    @click=${() => {
                      this.edit(r);
                      this.draft = { ...this.draft, cancelling: true };
                      this.impact = true;
                    }}
                  >
                    取消维护
                  </button>
                </td>
              </tr>`,
          )}
        </tbody>
      </table>
      ${!this.busy && !this.rows.length ? html`<p>暂无可查看的维护窗口</p>` : ""}
      <app-dialog
        .open=${!!d}
        title=${d?.cancelling ? "确认取消维护" : d?.id ? "编辑维护窗口" : "新建维护窗口"}
        @app-dialog-close=${() => {
          if (!this.busy) {
            this.draft = null;
            this.impact = false;
          }
        }}
      >
        ${
          d
            ? html`${this.error ? html`<p role="alert" class="error">${this.error}</p>` : ""}<label
                  >名称<input
                    aria-label="名称"
                    .value=${d.name}
                    @input=${(e: any) => this.field("name", e.target.value)}
                /></label>
                <label
                  >原因<textarea
                    aria-label="原因"
                    .value=${d.reason}
                    @input=${(e: any) => this.field("reason", e.target.value)}
                  ></textarea>
                </label>
                <label
                  >资源范围<select
                    aria-label="资源范围"
                    multiple
                    @change=${(e: any) =>
                      this.field(
                        "resources",
                        Array.from(e.target.selectedOptions).map((o: any) => JSON.parse(o.value)),
                      )}
                  >
                    ${this.resources.map((r) => html`<option .selected=${d.resources?.some((v: any) => v.type === r.type && v.id === r.id) ?? false} .value=${JSON.stringify({ type: r.type, id: r.id })}>${r.name} (${r.type})</option>`)}
                  </select></label
                >
                <label
                  ><input
                    type="checkbox"
                    aria-label="全局范围"
                    style="width:auto"
                    .checked=${d.resources === null}
                    @change=${(e: any) => this.field("resources", e.target.checked ? null : [])}
                  />全局范围（需要全局管理权限）</label
                >
                <label
                  >开始时间（含 UTC 偏移）<input
                    aria-label="开始时间"
                    .value=${d.starts_at}
                    @input=${(e: any) => this.field("starts_at", e.target.value)}
                /></label>
                <label
                  >结束时间（含 UTC 偏移）<input
                    aria-label="结束时间"
                    .value=${d.ends_at}
                    @input=${(e: any) => this.field("ends_at", e.target.value)}
                /></label>
                <label
                  >时区<select
                    aria-label="时区"
                    .value=${d.timezone}
                    @change=${(e: any) => this.field("timezone", e.target.value)}
                  >
                    ${["Asia/Shanghai", "UTC", "America/New_York", "Europe/London"].map((t) => html`<option value=${t}>${t}</option>`)}
                  </select></label
                >
                ${this.impact ? html`<p role="status">影响：${d.resources?.length ?? "全部"} 个资源；继续采集并记录问题，抑制通知。${d.cancelling ? "取消后立即重新评估，原问题不会被关闭。" : "请核对以上范围和期限后确认。"}</p>` : ""}
                <div slot="footer" class="actions">
                  ${this.pending ? html`<button class="btn" ?disabled=${this.busy} @click=${() => this.recover()}>查询操作结果</button>` : ""}<button
                    class="btn"
                    ?disabled=${this.busy}
                    @click=${() => {
                      this.draft = null;
                      this.impact = false;
                    }}
                  >
                    返回</button
                  ><button
                    class="btn-primary"
                    ?disabled=${this.busy || !!this.pending}
                    @click=${() => this.save(!!d.cancelling)}
                  >
                    ${d.cancelling ? "确认取消" : this.impact ? "确认保存" : "检查影响"}
                  </button>
                </div>`
            : ""
        }
      </app-dialog>`;
  }
}
