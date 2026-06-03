/**
 * Branding Settings — configure CLI/UI branding strings at runtime.
 * Changes take effect immediately via branding.ts memory cache.
 */
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { refreshBrandingCache } from "../../src/branding.js";

const CLI_NAME_REGEX = /^[a-z][a-z0-9-]*$/;
const ENV_PREFIX_REGEX = /^[A-Z][A-Z0-9_]*$/;

@customElement("branding-settings")
export class BrandingSettings extends LitElement {
  @state() private cliName: string = "";
  @state() private productName: string = "";
  @state() private envPrefix: string = "";
  @state() private stateDir: string = "";
  @state() private saving: boolean = false;
  @state() private message: string = "";
  @state() private messageType: "success" | "error" = "success";

  static styles = css`
    :host { display: block; max-width: 640px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 20px;
      margin-bottom: 16px;
    }
    .card h3 {
      margin: 0 0 6px;
      font-size: 15px;
      font-weight: 600;
      color: var(--text-strong);
    }
    .card .desc {
      margin: 0 0 14px;
      font-size: 12px;
      color: var(--muted);
    }
    .text-input {
      width: 100%;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--card);
      color: var(--text);
      font-size: 13px;
      box-sizing: border-box;
    }
    .text-input:focus {
      outline: none;
      border-color: var(--accent);
    }
    .text-input.input-error {
      border-color: var(--danger);
    }
    .field-error {
      font-size: 11px;
      color: var(--danger);
      margin-top: 4px;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 20px;
    }
    .btn-save {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: var(--radius-sm);
      padding: 8px 20px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn-save:hover { opacity: 0.9; }
    .btn-save:disabled { opacity: 0.5; cursor: not-allowed; }
    .msg {
      font-size: 12px;
      padding: 6px 12px;
      border-radius: var(--radius-sm);
    }
    .msg.success {
      background: color-mix(in srgb, var(--success) 15%, transparent);
      color: var(--success);
    }
    .msg.error {
      background: color-mix(in srgb, var(--danger) 15%, transparent);
      color: var(--danger);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._loadFromApi();
  }

  private _getAuthHeaders(): Record<string, string> {
    const token = localStorage.getItem("token");
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async _loadFromApi() {
    try {
      const resp = await fetch("/api/branding/config", {
        headers: this._getAuthHeaders(),
      });
      if (resp.ok) {
        const data = await resp.json();
        this.cliName = data.cli_name ?? "";
        this.productName = data.product_name ?? "";
        this.envPrefix = data.env_prefix ?? "";
        this.stateDir = data.state_dir ?? "";
      }
    } catch {
      // API unavailable — fields stay empty
    }
  }

  private _validate(): string | null {
    if (!this.cliName.trim()) return "CLI 名称不能为空";
    if (!this.productName.trim()) return "产品名称不能为空";
    if (!this.envPrefix.trim()) return "环境变量前缀不能为空";
    if (!this.stateDir.trim()) return "数据目录名称不能为空";
    if (!CLI_NAME_REGEX.test(this.cliName)) {
      return "CLI 名称只允许小写字母开头，包含小写字母、数字和连字符";
    }
    if (!ENV_PREFIX_REGEX.test(this.envPrefix)) {
      return "环境变量前缀只允许大写字母开头，包含大写字母、数字和下划线";
    }
    return null;
  }

  private async _save() {
    const validationError = this._validate();
    if (validationError) {
      this.message = validationError;
      this.messageType = "error";
      return;
    }

    this.saving = true;
    this.message = "";

    try {
      const resp = await fetch("/api/branding/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...this._getAuthHeaders() },
        body: JSON.stringify({
          cli_name: this.cliName.trim(),
          product_name: this.productName.trim(),
          env_prefix: this.envPrefix.trim(),
          state_dir: this.stateDir.trim(),
        }),
      });

      if (resp.ok) {
        await refreshBrandingCache();
        this.message = "品牌配置已保存，已即时生效";
        this.messageType = "success";
      } else {
        const err = await resp.json().catch(() => ({ error: "保存失败" }));
        this.message = err.error || "保存失败";
        this.messageType = "error";
      }
    } catch {
      this.message = "网络错误，请稍后重试";
      this.messageType = "error";
    } finally {
      this.saving = false;
    }
  }

  render() {
    const cliError = this.cliName && !CLI_NAME_REGEX.test(this.cliName)
      ? "仅允许小写字母开头，包含小写字母、数字和连字符"
      : "";
    const prefixError = this.envPrefix && !ENV_PREFIX_REGEX.test(this.envPrefix)
      ? "仅允许大写字母开头，包含大写字母、数字和下划线"
      : "";

    return html`
      <!-- CLI Name -->
      <div class="card">
        <h3>CLI 命令名称</h3>
        <p class="desc">终端命令名称，如 slide</p>
        <input
          type="text"
          class="text-input ${cliError ? "input-error" : ""}"
          .value=${this.cliName}
          @input=${(e: Event) => { this.cliName = (e.target as HTMLInputElement).value; this.message = ""; }}
          placeholder="slide"
        />
        ${cliError ? html`<div class="field-error">${cliError}</div>` : ""}
      </div>

      <!-- Product Name -->
      <div class="card">
        <h3>产品名称</h3>
        <p class="desc">产品显示名称，如 Slide</p>
        <input
          type="text"
          class="text-input"
          .value=${this.productName}
          @input=${(e: Event) => { this.productName = (e.target as HTMLInputElement).value; this.message = ""; }}
          placeholder="Slide"
        />
      </div>

      <!-- Env Prefix -->
      <div class="card">
        <h3>环境变量前缀</h3>
        <p class="desc">环境变量前缀，如 SLIDE</p>
        <input
          type="text"
          class="text-input ${prefixError ? "input-error" : ""}"
          .value=${this.envPrefix}
          @input=${(e: Event) => { this.envPrefix = (e.target as HTMLInputElement).value; this.message = ""; }}
          placeholder="SLIDE"
        />
        ${prefixError ? html`<div class="field-error">${prefixError}</div>` : ""}
      </div>

      <!-- State Dir -->
      <div class="card">
        <h3>数据目录名称</h3>
        <p class="desc">数据目录名称，如 .slide</p>
        <input
          type="text"
          class="text-input"
          .value=${this.stateDir}
          @input=${(e: Event) => { this.stateDir = (e.target as HTMLInputElement).value; this.message = ""; }}
          placeholder=".slide"
        />
      </div>

      <!-- Actions -->
      <div class="actions">
        <button
          class="btn-save"
          ?disabled=${this.saving}
          @click=${this._save}
        >
          ${this.saving ? "保存中..." : "保存"}
        </button>
        ${this.message ? html`
          <span class="msg ${this.messageType}">${this.message}</span>
        ` : ""}
      </div>
    `;
  }
}
