/**
 * AI 分析配置页面
 * 管理 AI 自动分析的启用开关、分析级别、实例白名单和时间窗口
 */
import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";

interface AiAnalysisConfig {
  enabled: boolean;
  cronExpression: string;
  severityLevels: string[];
  instanceWhitelist: number[];
  timeWindowStart: string;
  timeWindowEnd: string;
}

@customElement("ai-settings-page")
export class AiSettingsPage extends LitElement {
  @state() private config: AiAnalysisConfig | null = null;
  @state() private loading = true;
  @state() private saving = false;
  @state() private error: string | null = null;
  @state() private successMessage: string | null = null;
  @state() private _instances: { id: number; name: string }[] = [];
  @state() private _instanceDropdownOpen = false;
  @state() private _instanceSearch = "";
  static styles = [sharedBtnStyles, css`

    :host { display: block; }
    .header { margin-bottom: 20px; }
    .header h1 { font-size: 20px; font-weight: 600; margin: 0; color: var(--text); }
    .header p { font-size: 13px; color: var(--muted); margin: 4px 0 0; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); }
    .card-body { padding: 20px; }
    .card-footer { padding: 14px 20px; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
    .form-group { margin-bottom: 18px; }
    .form-label { display: block; font-size: 13px; font-weight: 500; color: var(--text); margin-bottom: 6px; }
    .help-text { font-size: 11px; color: var(--muted); margin-top: 4px; }

    /* Toggle switch */
    .cfg-toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; }
    .cfg-toggle-row span { font-size: 13px; color: var(--text); }
    .cfg-toggle { position: relative; display: inline-block; width: 40px; height: 22px; cursor: pointer; }
    .cfg-toggle input { opacity: 0; width: 0; height: 0; }
    .cfg-toggle .slider { position: absolute; inset: 0; background: var(--bg-elevated); border-radius: 11px; transition: 0.2s; border: 1px solid var(--border); }
    .cfg-toggle .slider::before { content: ""; position: absolute; height: 16px; width: 16px; left: 2px; bottom: 2px; background: var(--text); border-radius: 50%; transition: 0.2s; }
    .cfg-toggle input:checked + .slider { background: var(--accent); border-color: var(--accent); }
    .cfg-toggle input:checked + .slider::before { transform: translateX(18px); background: var(--accent-foreground, #fff); }

    /* Severity pills */
    .checkbox-group { display: flex; gap: 8px; flex-wrap: wrap; }
    .checkbox-label { padding: 6px 14px; border-radius: 999px; font-size: 12px; font-weight: 500; cursor: pointer; border: 1px solid var(--border); background: var(--bg-elevated); color: var(--muted); transition: 0.15s; }
    .checkbox-label.active { background: var(--accent-subtle); color: var(--accent); border-color: var(--accent); }

    /* Form input */
    .form-input { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; background: var(--card); color: var(--text); box-sizing: border-box; }
    .form-input:focus { outline: none; border-color: var(--accent); }

    /* Tags */
    .cfg-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .cfg-tag { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: var(--radius-sm); font-size: 12px; background: var(--accent-subtle); color: var(--accent); }
    .cfg-tag button { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--accent); padding: 0; margin: 0; line-height: 1; opacity: 0.7; }
    .cfg-tag button:hover { opacity: 1; }

    /* Time window row */
    .cfg-time-row { display: flex; align-items: center; gap: 8px; }
    .cfg-time-row .form-input { width: 140px; }

    /* Feedback messages */
    .msg { font-size: 12px; padding: 8px 12px; border-radius: var(--radius-sm); margin-bottom: 12px; }
    .msg-ok { background: rgba(21,128,61,0.1); color: #15803d; }
    .msg-err { background: rgba(220,38,38,0.1); color: #dc2626; }

    /* Instance dropdown */
    .inst-dropdown { position: relative; }
    .inst-dropdown-toggle { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; background: var(--card); color: var(--text); cursor: pointer; text-align: left; display: flex; align-items: center; justify-content: space-between; box-sizing: border-box; }
    .inst-dropdown-toggle:hover { border-color: var(--accent); }
    .inst-dropdown-toggle .arrow { font-size: 10px; color: var(--muted); transition: 0.15s; }
    .inst-dropdown-toggle .arrow.open { transform: rotate(180deg); }
    .inst-dropdown-menu { position: absolute; top: 100%; left: 0; right: 0; z-index: 100; max-height: 200px; overflow-y: auto; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-sm); margin-top: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .inst-dropdown-search { padding: 6px 8px; border-bottom: 1px solid var(--border); }
    .inst-dropdown-search input { width: 100%; padding: 5px 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; background: var(--bg-elevated); color: var(--text); box-sizing: border-box; }
    .inst-dropdown-item { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; color: var(--text); }
    .inst-dropdown-item:hover { background: var(--bg-elevated); }
    .inst-dropdown-item input[type="checkbox"] { margin: 0; accent-color: var(--accent); }
    .inst-dropdown-empty { padding: 12px; text-align: center; color: var(--muted); font-size: 12px; }

    /* Loading state */
    .loading { padding: 40px; text-align: center; color: var(--muted); font-size: 13px; }
  `];

  private _boundClickOutside = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!this.shadowRoot?.contains(target)) {
      this._instanceDropdownOpen = false;
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this._loadConfig();
    this._loadInstances();
    document.addEventListener("mousedown", this._boundClickOutside);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("mousedown", this._boundClickOutside);
  }

  private async _loadInstances() {
    try {
      const res = await authFetch("/api/database/instances");
      if (res.ok) {
        const data: any[] = await res.json();
        this._instances = data.map((i: any) => ({ id: i.id, name: i.name || `实例 #${i.id}` }));
      }
    } catch { /* non-critical */ }
  }

  private async _loadConfig() {
    this.loading = true;
    this.error = null;
    try {
      const res = await authFetch("/api/ai/config");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `加载失败 (${res.status})`);
      }
      this.config = await res.json();
    } catch (e: any) {
      this.error = e.message;
    } finally {
      this.loading = false;
    }
  }

  private async _save() {
    if (!this.config) return;
    this.saving = true;
    this.error = null;
    this.successMessage = null;
    try {
      const res = await authFetch("/api/ai/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.config),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `保存失败 (${res.status})`);
      }
      this.successMessage = "配置已保存";
      setTimeout(() => { this.successMessage = null; }, 3000);
    } catch (e: any) {
      this.error = e.message;
    } finally {
      this.saving = false;
    }
  }

  private _toggleEnabled() {
    if (!this.config) return;
    this.config = { ...this.config, enabled: !this.config.enabled };
  }

  private _toggleSeverity(level: string) {
    if (!this.config) return;
    const levels = this.config.severityLevels;
    if (levels.includes(level)) {
      if (levels.length <= 1) return; // at least one required
      this.config = { ...this.config, severityLevels: levels.filter(l => l !== level) };
    } else {
      this.config = { ...this.config, severityLevels: [...levels, level] };
    }
  }

  private _toggleWhitelistInstance(id: number) {
    if (!this.config) return;
    const wl = this.config.instanceWhitelist;
    this.config = { ...this.config, instanceWhitelist: wl.includes(id) ? wl.filter(i => i !== id) : [...wl, id] };
  }

  private get _filteredInstances() {
    const q = this._instanceSearch.toLowerCase().trim();
    if (!q) return this._instances;
    return this._instances.filter(i => i.name.toLowerCase().includes(q) || String(i.id).includes(q));
  }

  private _removeWhitelistInstance(id: number) {
    if (!this.config) return;
    this.config = { ...this.config, instanceWhitelist: this.config.instanceWhitelist.filter(i => i !== id) };
  }

  override render() {
    if (this.loading) return html`<div class="loading">加载中...</div>`;
    if (this.error && !this.config) return html`<div class="loading" style="color:var(--destructive)">${this.error}</div>`;
    if (!this.config) return html`<div class="loading" style="color:var(--destructive)">无法加载配置</div>`;

    const { enabled, severityLevels, instanceWhitelist, timeWindowStart, timeWindowEnd } = this.config;
    const allSeverities = ["critical", "error", "warning", "info"];

    return html`
      <div class="page">
        ${this.successMessage ? html`<div class="msg msg-ok">${this.successMessage}</div>` : ""}
        ${this.error ? html`<div class="msg msg-err">${this.error}</div>` : ""}

        <div class="card">
          <div class="card-body">
            <!-- Master toggle -->
            <div class="cfg-toggle-row">
              <span>启用自动分析</span>
              <label class="cfg-toggle">
                <input type="checkbox" .checked=${enabled} @change=${this._toggleEnabled} />
                <span class="slider"></span>
              </label>
            </div>

            <!-- Severity Levels -->
            <div class="form-group">
              <label class="form-label">分析级别</label>
              <div class="checkbox-group">
                ${allSeverities.map(level => html`
                  <button class="checkbox-label ${severityLevels.includes(level) ? "active" : ""}" @click=${() => this._toggleSeverity(level)}>
                    ${level === "critical" ? "严重" : level === "error" ? "错误" : level === "warning" ? "警告" : "提示"}
                  </button>
                `)}
              </div>
              <div class="help-text">至少选择一项</div>
            </div>

            <!-- Instance Whitelist -->
            <div class="form-group">
              <label class="form-label">实例白名单</label>
              <div class="inst-dropdown">
                <button type="button" class="inst-dropdown-toggle" @click=${() => { this._instanceDropdownOpen = !this._instanceDropdownOpen; this._instanceSearch = ""; }}>
                  ${instanceWhitelist.length > 0
                    ? html`已选 <strong>${instanceWhitelist.length}</strong> 个实例`
                    : "全部实例参与分析"}
                  <span class="arrow ${this._instanceDropdownOpen ? "open" : ""}">▾</span>
                </button>
                ${this._instanceDropdownOpen ? html`
                  <div class="inst-dropdown-menu">
                    <div class="inst-dropdown-search">
                      <input type="text" .value=${this._instanceSearch} @input=${(e: Event) => { this._instanceSearch = (e.target as HTMLInputElement).value; }} placeholder="搜索实例名称或 ID..." />
                    </div>
                    ${this._filteredInstances.length > 0
                      ? this._filteredInstances.map(inst => html`
                        <label class="inst-dropdown-item" @click=${(e: Event) => { e.preventDefault(); this._toggleWhitelistInstance(inst.id); }}>
                          <input type="checkbox" .checked=${instanceWhitelist.includes(inst.id)} @change=${() => this._toggleWhitelistInstance(inst.id)} />
                          <span>${inst.name}</span>
                          <span style="color:var(--muted);font-size:11px;">#${inst.id}</span>
                        </label>
                      `)
                      : html`<div class="inst-dropdown-empty">${this._instances.length === 0 ? "加载实例中..." : "无匹配实例"}</div>`
                    }
                  </div>
                ` : ""}
              </div>
              <div class="cfg-tags">
                ${instanceWhitelist.map(id => {
                  const inst = this._instances.find(i => i.id === id);
                  return html`
                    <span class="cfg-tag">
                      ${inst ? inst.name : `#${id}`}
                      <button @click=${() => this._removeWhitelistInstance(id)}>×</button>
                    </span>
                  `;
                })}
              </div>
              <div class="help-text">${instanceWhitelist.length > 0 ? "点击 × 移除实例" : "留空表示全部实例参与分析"}</div>
            </div>

            <!-- Time Window -->
            <div class="form-group">
              <label class="form-label">时间窗口</label>
              <div class="cfg-time-row">
                <input class="form-input" type="time" .value=${timeWindowStart} @change=${(e: any) => this.config = { ...this.config!, timeWindowStart: e.target.value }} />
                <span style="color:var(--muted);">~</span>
                <input class="form-input" type="time" .value=${timeWindowEnd} @change=${(e: any) => this.config = { ...this.config!, timeWindowEnd: e.target.value }} />
              </div>
              <div class="help-text">在此时间段内执行自动分析</div>
            </div>
          </div>

          <div class="card-footer">
            <button class="btn btn-primary" @click=${this._save} ?disabled=${this.saving}>
              ${this.saving ? "保存中..." : "保存配置"}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-settings-page": AiSettingsPage;
  }
}
