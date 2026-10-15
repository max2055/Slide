/** Runtime branding configuration; all four fields are saved together. */
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { refreshBrandingCache, type BrandingConfig } from "../../src/branding.js";
import { authFetch } from "../../../api/index.js";
import "../components/app-card.js";
import "../components/app-form-field.js";

const CLI_NAME_REGEX = /^[a-z][a-z0-9-]*$/;
const ENV_PREFIX_REGEX = /^[A-Z][A-Z0-9_]*$/;

@customElement("branding-settings")
export class BrandingSettings extends LitElement {
  @state() private cliName = "";
  @state() private productName = "";
  @state() private envPrefix = "";
  @state() private stateDir = "";
  @state() private loading = true;
  @state() private loaded = false;
  @state() private loadError = "";
  @state() private saving = false;
  @state() private uncertain = false;
  @state() private submitted = false;
  @state() private message = "";
  @state() private messageType: "success" | "error" = "success";
  private saved: BrandingConfig | null = null;

  static styles = [sharedFieldStyles, sharedBtnStyles, css`
    :host { display: block; max-width: 1100px; min-width: 0; }
    * { box-sizing: border-box; }
    .page-header { display: flex; justify-content: space-between; align-items: start; gap: var(--space-lg); margin-bottom: var(--space-xl); }
    h1 { font-size: 24px; font-weight: 650; line-height: 1.35; margin: 0; color: var(--text-strong); }
    h2 { font-size: 16px; font-weight: 600; margin: 0; color: var(--text-strong); }
    p { margin: var(--space-xs) 0 0; line-height: 1.6; }
    .page-header p { font-size: 14px; color: var(--muted); }
    .form-group { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: var(--space-xl); padding: var(--space-xl) 0; }
    .form-group:first-child { padding-top: 0; }
    .form-group + .form-group { border-top: 1px solid var(--border); }
    .form-group:last-child { padding-bottom: 0; }
    .group-description, .save-scope, .draft-status { color: var(--muted); font-size: 12px; }
    .form-body { max-width: 690px; min-width: 0; }
    app-form-field { margin-bottom: var(--space-lg); }
    app-form-field:last-child { margin-bottom: 0; }
    app-form-field::part(label) { font-size: 14px; }
    app-form-field::part(hint), app-form-field::part(error) { font-size: 12px; overflow-wrap: anywhere; }
    .text-input { width: 100%; min-width: 0; padding: var(--space-sm) var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--text); font: inherit; font-size: 14px; }
    .text-input[aria-invalid="true"] { border-color: var(--danger); }
    .text-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .preview { padding: var(--space-md); background: var(--bg-accent); border-radius: var(--radius-sm); overflow-wrap: anywhere; }
    .preview strong { display: block; font-size: 16px; color: var(--text-strong); }
    .preview p { font-size: 12px; color: var(--muted); }
    .save-footer { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-md); width: 100%; }
    .actions { display: flex; flex-wrap: wrap; gap: var(--space-sm); }
    .feedback { margin: 0 0 var(--space-lg); padding: var(--space-md); font-size: 14px; line-height: 1.6; border-radius: var(--radius-sm); overflow-wrap: anywhere; }
    .feedback.error { color: var(--danger); background: var(--danger-subtle); }
    .feedback.success { color: var(--ok); background: var(--ok-subtle); }
    .loading { color: var(--muted); padding: var(--space-lg) 0; }
    @media (max-width: 850px) { .form-group { grid-template-columns: minmax(0, 1fr); gap: var(--space-md); } }
    @media (max-width: 600px) { h1 { font-size: 22px; } .page-header { flex-wrap: wrap; } }
  `];

  override connectedCallback() {
    super.connectedCallback();
    void this._loadFromApi();
  }

  private get draft(): BrandingConfig {
    return { cli_name: this.cliName, product_name: this.productName, env_prefix: this.envPrefix, state_dir: this.stateDir };
  }

  private get dirty(): boolean {
    return this.saved !== null && Object.entries(this.draft).some(([key, value]) => value !== this.saved![key as keyof BrandingConfig]);
  }

  private apply(config: BrandingConfig) {
    this.cliName = config.cli_name;
    this.productName = config.product_name;
    this.envPrefix = config.env_prefix;
    this.stateDir = config.state_dir;
  }

  private async _loadFromApi() {
    if (this.saving || (this.dirty && !this.uncertain)) return;
    this.loading = true;
    this.loadError = "";
    try {
      const resp = await authFetch("/api/branding/config");
      if (!resp.ok) throw new Error(resp.status === 403 ? "无权限读取品牌配置" : "品牌配置读取失败，请重试");
      const data = await resp.json();
      if (!data || !["cli_name", "product_name", "env_prefix", "state_dir"].every(key => typeof data[key] === "string")) {
        throw new Error("品牌配置不完整，暂不能编辑，请重新读取");
      }
      this.saved = { cli_name: data.cli_name, product_name: data.product_name, env_prefix: data.env_prefix, state_dir: data.state_dir };
      this.apply(this.saved);
      this.loaded = true;
      this.uncertain = false;
      this.submitted = false;
      this.message = "";
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : "品牌配置读取失败，请重试";
    } finally {
      this.loading = false;
    }
  }

  private fieldError(field: keyof BrandingConfig): string {
    const value = this.draft[field];
    if (!value.trim() && this.submitted) return "此项不能为空";
    if (field === "cli_name" && value && !CLI_NAME_REGEX.test(value)) return "仅允许小写字母开头，包含小写字母、数字和连字符";
    if (field === "env_prefix" && value && !ENV_PREFIX_REGEX.test(value)) return "仅允许大写字母开头，包含大写字母、数字和下划线";
    return "";
  }

  private edit(field: "cliName" | "productName" | "envPrefix" | "stateDir", event: Event) {
    this[field] = (event.target as HTMLInputElement).value;
    this.message = "";
  }

  private async _save() {
    if (!this.loaded || this.loading || this.loadError || this.saving || this.uncertain || !this.dirty) return;
    this.submitted = true;
    if ((Object.keys(this.draft) as (keyof BrandingConfig)[]).some(key => this.fieldError(key))) {
      this.message = "请修正标记的字段后再保存";
      this.messageType = "error";
      await this.updateComplete;
      this.renderRoot.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus();
      return;
    }
    const payload = Object.fromEntries(Object.entries(this.draft).map(([key, value]) => [key, value.trim()])) as unknown as BrandingConfig;
    this.saving = true;
    this.message = "";
    try {
      const resp = await authFetch("/api/branding/config", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (resp.ok) {
        this.saved = payload;
        this.apply(payload);
        await refreshBrandingCache();
        this.message = "品牌配置已保存";
        this.messageType = "success";
      } else {
        const err = await resp.json().catch(() => null);
        this.message = resp.status === 403 ? "无权限保存品牌配置，修改尚未保存" : (typeof err?.error === "string" ? err.error : "保存失败，修改尚未保存");
        this.messageType = "error";
      }
    } catch {
      this.uncertain = true;
      this.message = "保存结果未确认。请重新读取配置核对后再编辑。";
      this.messageType = "error";
    } finally {
      this.saving = false;
    }
  }

  render() {
    const disabled = this.saving || this.loading || this.uncertain || !!this.loadError;
    return html`
      <div class="page-header">
        <div><h1>品牌设置</h1><p>统一产品标识与命令环境，全部修改一起保存。</p></div>
        <button class="btn" ?disabled=${this.loading || this.saving || (this.dirty && !this.uncertain)} @click=${this._loadFromApi}>${this.loading ? "读取中…" : "重新读取"}</button>
      </div>
      ${this.loadError ? html`<p class="feedback error" role="alert">${this.loadError}</p>` : ""}
      ${this.message ? html`<p class="feedback ${this.messageType}" role=${this.messageType === "error" ? "alert" : "status"}>${this.message}</p>` : ""}
      ${this.loading ? html`<p class="loading" role="status">正在读取品牌配置…</p>` : ""}
      ${this.loaded ? html`
        <app-card aria-busy=${this.loading || this.saving}>
          <section class="form-group" aria-labelledby="identity-heading">
            <div><h2 id="identity-heading">产品标识</h2><p class="group-description">设置产品显示名称，核对保存前的文字预览。</p></div>
            <div class="form-body">
              <app-form-field label="产品名称" hint="产品显示名称，如 Slide" .error=${this.fieldError("product_name")} required>
                <input class="text-input" .value=${this.productName} ?disabled=${disabled} @input=${(e: Event) => this.edit("productName", e)} placeholder="Slide" />
              </app-form-field>
              <div class="preview" aria-label="产品名称预览"><strong>${this.productName.trim() || "未填写产品名称"}</strong><p>文字预览 · ${this.dirty ? "含未保存修改" : "当前已读取配置"}</p></div>
            </div>
          </section>
          <section class="form-group" aria-labelledby="runtime-heading">
            <div><h2 id="runtime-heading">命令与运行环境</h2><p class="group-description">统一 CLI 命令、环境变量前缀和数据目录标识。</p></div>
            <div class="form-body">
              <app-form-field label="CLI 命令名称" hint="终端命令名称，如 slide" .error=${this.fieldError("cli_name")} required>
                <input class="text-input" .value=${this.cliName} ?disabled=${disabled} @input=${(e: Event) => this.edit("cliName", e)} placeholder="slide" spellcheck="false" />
              </app-form-field>
              <app-form-field label="环境变量前缀" hint="环境变量前缀，如 SLIDE" .error=${this.fieldError("env_prefix")} required>
                <input class="text-input" .value=${this.envPrefix} ?disabled=${disabled} @input=${(e: Event) => this.edit("envPrefix", e)} placeholder="SLIDE" spellcheck="false" />
              </app-form-field>
              <app-form-field label="数据目录名称" hint="数据目录名称，如 .slide" .error=${this.fieldError("state_dir")} required>
                <input class="text-input" .value=${this.stateDir} ?disabled=${disabled} @input=${(e: Event) => this.edit("stateDir", e)} placeholder=".slide" spellcheck="false" />
              </app-form-field>
            </div>
          </section>
          <div slot="footer" class="save-footer">
            <div><div class="draft-status" role="status">${this.uncertain ? "保存结果待核对" : this.dirty ? "有未保存的修改" : "没有未保存的修改"}</div><p class="save-scope">保存范围：产品名称、CLI 名称、环境变量前缀、数据目录。</p></div>
            <div class="actions">
              <button class="btn" ?disabled=${disabled || !this.dirty} @click=${() => { if (this.saved) this.apply(this.saved); this.message = ""; this.submitted = false; }}>撤销修改</button>
              <button class="btn-primary" ?disabled=${disabled || !this.dirty} @click=${this._save}>${this.saving ? "保存中…" : "保存品牌"}</button>
            </div>
          </div>
        </app-card>
      ` : ""}
    `;
  }
}
