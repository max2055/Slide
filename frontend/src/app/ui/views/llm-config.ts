/**
 * LLM 配置管理 — 两栏布局：左侧提供商列表 + 右侧详情/模板选择
 * 参考 pi-web ModelsConfig 的 UX 模式优化
 */
import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { customElement, state } from "lit/decorators.js";
import { apiClient } from "../../../api/index.js";
import { icons } from "../../../icons.js";

interface LLMProvider {
  id: number; name: string; display_name: string;
  deployment_type: string; api_format?: string;
  api_base_url?: string; default_model?: string;
  models_supported?: ModelConfig[];
  enabled: boolean; is_default: boolean;
}

interface ModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number };
}

interface FormData {
  name: string; display_name: string; api_base_url: string;
  default_model: string; deployment_type: string; api_format: string;
  api_key: string; enabled: boolean; is_default: boolean;
  models: ModelConfig[];
}

const API_FORMATS = [
  { value: "", label: "自动检测" },
  { value: "openai-completions", label: "OpenAI Completions" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
];

const DEPLOY_TYPES = [
  { value: "api", label: "API (云端)" },
  { value: "local", label: "本地 (Ollama/vLLM)" },
  { value: "cloud", label: "Cloud (代理)" },
];

interface ProviderTemplate {
  id: string; name: string; displayName: string;
  color: string; bg: string;
  baseUrl: string; defaultModel: string;
  deploymentType: string;
  description: string;
  models: string[];
}

const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  { id: "anthropic", name: "anthropic", displayName: "Anthropic Claude", color: "#d97706", bg: "rgba(217,119,6,0.12)", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-6", deploymentType: "api", description: "Claude Sonnet / Opus / Haiku", models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-5", "claude-sonnet-4-5", "claude-3.5-sonnet", "claude-3.5-haiku"] },
  { id: "openai", name: "openai", displayName: "OpenAI", color: "#10a37f", bg: "rgba(16,163,127,0.12)", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4.1", deploymentType: "api", description: "GPT-4.1 / GPT-4o / o4-mini", models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini", "o4-mini", "o3-mini", "gpt-4-turbo"] },
  { id: "deepseek", name: "deepseek", displayName: "DeepSeek", color: "#4f46e5", bg: "rgba(79,70,229,0.12)", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-v4-pro", deploymentType: "api", description: "DeepSeek V4 Pro / Flash", models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-reasoner", "deepseek-chat", "deepseek-coder"] },
  { id: "google", name: "google", displayName: "Google Gemini", color: "#4285f4", bg: "rgba(66,133,244,0.12)", baseUrl: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-2.5-pro", deploymentType: "api", description: "Gemini 2.5 Pro / Flash", models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"] },
  { id: "ollama", name: "ollama", displayName: "Ollama", color: "#374151", bg: "rgba(55,65,81,0.12)", baseUrl: "http://localhost:11434/v1", defaultModel: "qwen2.5-coder:32b", deploymentType: "local", description: "本地部署 · 开源模型", models: ["qwen2.5-coder:32b", "qwen2.5:72b", "llama3.3:70b", "deepseek-r1:70b", "codellama:70b", "mistral:7b", "gemma3:27b", "phi4:14b"] },
];

type ViewMode = "placeholder" | "picker" | "form";

function blankForm(): FormData {
  return { name: "", display_name: "", api_base_url: "", default_model: "", deployment_type: "api", api_format: "", api_key: "", enabled: true, is_default: false, models: [] };
}

// ── Brand color + initial resolver ──────────────────────────────────────────

const BRAND_MAP: Record<string, { color: string; bg: string }> = {
  anthropic: { color: "#d97706", bg: "rgba(217,119,6,0.12)" },
  openai: { color: "#10a37f", bg: "rgba(16,163,127,0.12)" },
  deepseek: { color: "#4f46e5", bg: "rgba(79,70,229,0.12)" },
  ollama: { color: "#374151", bg: "rgba(55,65,81,0.12)" },
  google: { color: "#4285f4", bg: "rgba(66,133,244,0.12)" },
  gemini: { color: "#4285f4", bg: "rgba(66,133,244,0.12)" },
  bailian: { color: "#ff6a00", bg: "rgba(255,106,0,0.12)" },
  qwen: { color: "#615dfa", bg: "rgba(97,93,250,0.12)" },
  zhipu: { color: "#3859ff", bg: "rgba(56,89,255,0.12)" },
  glm: { color: "#3859ff", bg: "rgba(56,89,255,0.12)" },
  moonshot: { color: "#8b5cf6", bg: "rgba(139,92,246,0.12)" },
  kimi: { color: "#8b5cf6", bg: "rgba(139,92,246,0.12)" },
  minimax: { color: "#06b6d4", bg: "rgba(6,182,212,0.12)" },
  mistral: { color: "#facc15", bg: "rgba(250,204,21,0.15)" },
  groq: { color: "#f97316", bg: "rgba(249,115,22,0.12)" },
  cohere: { color: "#39594d", bg: "rgba(57,89,77,0.12)" },
  xai: { color: "#000000", bg: "rgba(0,0,0,0.08)" },
  grok: { color: "#000000", bg: "rgba(0,0,0,0.08)" },
  perplexity: { color: "#1e88e5", bg: "rgba(30,136,229,0.12)" },
  huggingface: { color: "#ffbd45", bg: "rgba(255,189,69,0.15)" },
  together: { color: "#6366f1", bg: "rgba(99,102,241,0.12)" },
  fireworks: { color: "#fb3b4b", bg: "rgba(251,59,75,0.12)" },
  cerebras: { color: "#f2753d", bg: "rgba(242,117,61,0.12)" },
  openrouter: { color: "#6366f1", bg: "rgba(99,102,241,0.12)" },
};

function brandFor(name: string): { color: string; bg: string; initial: string } {
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(BRAND_MAP)) {
    if (lower.includes(key)) return { ...val, initial: name.charAt(0).toUpperCase() };
  }
  // fallback: generate a stable color from name hash
  const hash = [...lower].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
  const hue = Math.abs(hash) % 360;
  return { color: `hsl(${hue}, 45%, 45%)`, bg: `hsla(${hue}, 45%, 45%, 0.12)`, initial: name.charAt(0).toUpperCase() };
}


// ── Component ───────────────────────────────────────────────────────────────

@customElement("llm-config-page")
export class LLMConfigPage extends LitElement {
  @state() private providers: LLMProvider[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private selectedId: number | null = null;
  @state() private viewMode: ViewMode = "placeholder";
  @state() private editing: LLMProvider | null = null;
  @state() private form: FormData = blankForm();
  @state() private saving = false;
  @state() private testing = false;
  @state() private testResult: string | null = null;
  @state() private formMsg: string | null = null;
  @state() private savedOk = false;
  @state() private showKey = false;
  @state() private modelSuggestions: string[] = [];
  private _savedOkTimer: ReturnType<typeof setTimeout> | null = null;
  static styles = [sharedBtnStyles, css`

    :host { display: block; height: 100%; }
    .shell { display: flex; height: 100%; overflow: hidden; }
    .page-header { margin-bottom: 0; padding: 0 0 16px; flex-shrink: 0; }
    .page-header h1 { font-size: 20px; font-weight: 700; margin: 0 0 2px; color: var(--text-strong); }
    .page-header p { font-size: 12px; color: var(--muted); margin: 0; }

    /* Sidebar */
    .sidebar { width: 240px; min-width: 240px; border-right: 1px solid var(--border); background: var(--card); display: flex; flex-direction: column; overflow: hidden; }
    .sidebar-list { flex: 1; overflow-y: auto; padding: 4px 6px; }

    /* Sidebar empty */
    .sidebar-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px 16px; text-align: center; gap: 10px; }
    .sidebar-empty svg { opacity: 0.2; }
    .sidebar-empty p { font-size: 11px; color: var(--muted); margin: 0; line-height: 1.4; }
    .sidebar-empty .add-first-btn { margin-top: 4px; padding: 6px 16px; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; border: 1px solid var(--accent); background: var(--accent); color: #fff; transition: opacity 0.15s; }
    .sidebar-empty .add-first-btn:hover { opacity: 0.85; }
    .sidebar-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; cursor: pointer; transition: background 0.12s; }
    .sidebar-item:hover { background: var(--hover); }
    .sidebar-item.selected { background: var(--active); }
    .brand-circle { width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; color: inherit; }
    .item-info { flex: 1; min-width: 0; }
    .item-name { font-size: 12px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item-url { font-size: 10px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .status-on { background: #22c55e; }
    .status-off { background: var(--border); }
    .default-star { font-size: 11px; color: var(--accent); flex-shrink: 0; margin-left: -2px; }
    .sidebar-footer { padding: 8px 6px; border-top: 1px solid var(--border); }
    .add-btn { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; padding: 7px 0; background: none; border: 1px dashed var(--border); border-radius: 6px; color: var(--muted); cursor: pointer; font-size: 12px; transition: border-color 0.12s, color 0.12s; }
    .add-btn:hover { border-color: var(--accent); color: var(--accent); }

    /* Detail */
    .detail { flex: 1; overflow-y: auto; padding: 0; display: flex; flex-direction: column; }
    .detail-inner { padding: 20px 28px; max-width: 560px; }

    /* Template picker */
    .picker-section-label { font-size: 10px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 8px; margin-top: 4px; }
    .template-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
    .template-card { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); cursor: pointer; text-align: center; transition: border-color 0.12s, background 0.12s; }
    .template-card:hover { border-color: var(--accent); background: var(--bg-accent); }
    .template-card .t-circle { width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; }
    .template-card .t-name { font-size: 12px; font-weight: 600; color: var(--text); }
    .template-card .t-desc { font-size: 10px; color: var(--muted); line-height: 1.3; }
    .template-card.custom .t-circle { border: 1.5px dashed var(--border); background: transparent; color: var(--muted); }

    /* Form */
    .form-section-title { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
    .form-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
    .form-label { font-size: 12px; font-weight: 500; color: var(--text); }
    .form-input, .form-select { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; background: var(--card); color: var(--text); box-sizing: border-box; transition: border-color 0.15s; }
    .form-input:focus, .form-select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-subtle); }
    .form-input:disabled { opacity: 0.5; background: var(--bg-elevated); cursor: not-allowed; }
    .form-hint { font-size: 10px; color: var(--muted); margin-top: 2px; }
    .form-row { display: flex; gap: 10px; }
    .form-row > .form-group { flex: 1; }
    .key-wrapper { position: relative; }
    .key-wrapper .form-input { padding-right: 34px; }
    .key-toggle { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 24px; height: 24px; padding: 0; border: none; background: transparent; color: var(--muted); cursor: pointer; display: flex; align-items: center; justify-content: center; }

    .model-remove-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; margin-top: 14px; flex-shrink: 0; border: 1px solid rgba(239,68,68,0.25); border-radius: 5px; background: transparent; color: #ef4444; cursor: pointer; transition: background 0.12s, border-color 0.12s; }
    .model-remove-btn:hover { background: rgba(239,68,68,0.1); border-color: #ef4444; }
    .model-remove-btn svg { width: 14px; height: 14px; }
    .actions-bar { display: flex; gap: 8px; align-items: center; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
    .actions-bar .spacer { flex: 1; }

    /* Status toggle */
    .toggle-row { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; }
    .toggle-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text); cursor: pointer; }
    .toggle-switch { width: 36px; height: 20px; border-radius: 999px; background: var(--border); position: relative; transition: background 0.2s; flex-shrink: 0; }
    .toggle-switch.on { background: #22c55e; }
    .toggle-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.2s; }
    .toggle-switch.on::after { transform: translateX(16px); }

    /* Messages */
    .msg { font-size: 12px; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; }
    .msg-ok { background: var(--ok-subtle); color: var(--ok); }
    .msg-err { background: var(--danger-subtle); color: var(--destructive); }

    /* Placeholder */
    .placeholder { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--muted); text-align: center; padding: 40px; gap: 12px; }
    .placeholder svg { opacity: 0.25; }
    .placeholder p { font-size: 13px; margin: 0; }
  `];

  override connectedCallback() { super.connectedCallback(); this._load(); }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._savedOkTimer) clearTimeout(this._savedOkTimer);
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  private async _load() {
    this.loading = true; this.error = null;
    try {
      const data = await apiClient.get<LLMProvider[]>("/llm/configs");
      this.providers = Array.isArray(data) ? data : [];
      if (this.selectedId && !this.providers.find(p => p.id === this.selectedId)) {
        this.selectedId = null;
        this.viewMode = this.providers.length === 0 ? "picker" : "placeholder";
      }
      // First load with no providers: show template picker directly
      if (this.providers.length === 0) {
        this.viewMode = "picker";
      }
    } catch (e: any) { this.error = e.message || "加载失败"; }
    finally { this.loading = false; }
  }

  // ── Sidebar actions ──────────────────────────────────────────────────────

  _selectProvider(p: LLMProvider) {
    this.selectedId = p.id;
    this.editing = p;
    this.form = {
      name: p.name, display_name: p.display_name || "",
      api_base_url: p.api_base_url || "", default_model: p.default_model || "",
      deployment_type: p.deployment_type || "api",
      api_format: p.api_format || "", api_key: "",
      enabled: p.enabled, is_default: p.is_default,
      models: (p.models_supported || []).map((m: any) => ({
        id: m.id || "", name: m.name || "",
        contextWindow: m.contextWindow || m.context_window,
        maxTokens: m.maxTokens || m.max_tokens,
        cost: m.cost || undefined,
      })),
    };
    this.viewMode = "form";
    this.formMsg = null;
    this.testResult = null;
    this.showKey = false;
  }

  _openAddPicker() {
    this.selectedId = null;
    this.editing = null;
    this.viewMode = "picker";
    this.formMsg = null;
    this.testResult = null;
  }

  _selectTemplate(tpl: ProviderTemplate) {
    this.editing = null;
    this.form = {
      name: tpl.name, display_name: tpl.displayName,
      api_base_url: tpl.baseUrl, default_model: tpl.defaultModel,
      deployment_type: tpl.deploymentType, api_key: "",
      enabled: true, is_default: this.providers.length === 0,
    };
    this.modelSuggestions = tpl.models;
    this.viewMode = "form";
    this.formMsg = null;
    this.testResult = null;
    this.showKey = false;
  }

  _openCustomForm() {
    this.editing = null;
    this.form = { ...blankForm(), is_default: this.providers.length === 0 };
    this.viewMode = "form";
    this.formMsg = null;
    this.testResult = null;
    this.showKey = false;
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  private async _save() {
    this.saving = true; this.formMsg = null; this.savedOk = false;
    try {
      const body: any = {
        name: this.form.name,
        displayName: this.form.display_name || undefined,
        deploymentType: this.form.deployment_type,
        apiFormat: this.form.api_format || undefined,
        apiKey: this.form.api_key || undefined,
        baseURL: this.form.api_base_url || undefined,
        model: this.form.default_model || undefined,
        enabled: this.form.enabled,
        modelsSupported: this.form.models.length > 0 ? this.form.models : undefined,
      };
      if (!body.apiKey) delete body.apiKey;
      if (this.editing) {
        await apiClient.put(`/llm/configs/${this.editing.id}`, body);
      } else {
        await apiClient.post("/llm/configs", body);
      }
      this.savedOk = true;
      if (this._savedOkTimer) clearTimeout(this._savedOkTimer);
      this._savedOkTimer = setTimeout(() => { this.savedOk = false; }, 2500);
      await this._load();
      // Keep the form open but update editing ref
      if (!this.editing) {
        // New provider: find it in the reloaded list
        const found = this.providers.find(p => p.name === this.form.name);
        if (found) {
          this.selectedId = found.id;
          this.editing = found;
        }
      } else {
        const updated = this.providers.find(p => p.id === this.editing!.id);
        if (updated) this.editing = updated;
      }
    } catch (e: any) { this.formMsg = e.message || "保存失败"; }
    finally { this.saving = false; }
  }

  private async _toggle(p: LLMProvider) {
    try { await apiClient.post(`/llm/configs/${p.id}/toggle`); await this._load(); } catch (_) {}
  }

  private async _setDefault(p: LLMProvider) {
    try { await apiClient.post(`/llm/configs/${p.id}/default`); await this._load(); } catch (_) {}
  }

  private async _delete(p: LLMProvider) {
    if (!confirm(`确定删除提供商 "${p.display_name || p.name}"？`)) return;
    try {
      await apiClient.delete(`/llm/configs/${p.id}`);
      if (this.selectedId === p.id) { this.selectedId = null; this.viewMode = "placeholder"; this.editing = null; }
      await this._load();
    } catch (e: any) { this.formMsg = e.message || "删除失败"; }
  }

  // ── Model CRUD ──────────────────────────────────────────────────────────

  _addModel() {
    this.form = { ...this.form, models: [...this.form.models, { id: "" }] };
  }

  _removeModel(idx: number) {
    const models = [...this.form.models];
    models.splice(idx, 1);
    this.form = { ...this.form, models };
  }

  _updateModel(idx: number, patch: Partial<ModelConfig>) {
    const models = this.form.models.map((m, i) => i === idx ? { ...m, ...patch } : m);
    this.form = { ...this.form, models };
  }

  private async _fetchModels() {
    const url = this.form.api_base_url.trim();
    if (!url) return;
    try {
      const res = await apiClient.get<{ models: { id: string; name: string }[] }>(`/llm/models?baseUrl=${encodeURIComponent(url)}`);
      if (Array.isArray(res?.models) && res.models.length > 0) {
        this.modelSuggestions = res.models.map(m => m.id);
      }
    } catch (_) { /* catalog might not have this provider */ }
  }

  private async _test(p: LLMProvider) {
    this.testing = true; this.testResult = null;
    try {
      const r = await apiClient.post<any>("/llm/test", { providerName: p.name });
      this.testResult = r.success ? `✅ ${r.message || "连接成功"}` : `❌ ${r.error || r.message || "连接失败"}`;
    } catch (e: any) { this.testResult = `❌ ${e.message}`; }
    finally { this.testing = false; setTimeout(() => { this.testResult = null; }, 8000); }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  override render() {
    if (this.loading) {
      return html`<div style="padding:48px;text-align:center;color:var(--muted);font-size:13px">加载中...</div>`;
    }
    if (this.error) {
      return html`<div style="padding:48px;text-align:center;color:var(--destructive);font-size:13px">${this.error}</div>`;
    }

    return html`
      <div style="display:flex;flex-direction:column;height:100%">
        <div class="page-header" style="padding:0 28px 16px">
          <h1>LLM 配置</h1>
          <p>管理 AI 提供商：添加、编辑、启停、测试连接</p>
        </div>
        <div class="shell" style="flex:1">
          ${this._renderSidebar()}
          ${this._renderDetail()}
        </div>
      </div>
    `;
  }

  _renderSidebar() {
    return html`
    <div class="sidebar">
      <div class="sidebar-list">
        ${this.providers.length === 0 ? html`
          <div class="sidebar-empty">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M20 9h3"/><path d="M20 14h3"/><path d="M1 9h3"/><path d="M1 14h3"/></svg>
            <p>还没有 AI 提供商<br/>选择一个模板快速开始</p>
            <button class="add-first-btn" @click=${this._openAddPicker}>添加第一个提供商</button>
          </div>
        ` : this.providers.map(p => {
          const brand = brandFor(p.name);
          const isSelected = this.selectedId === p.id;
          return html`
          <div class="sidebar-item ${isSelected ? 'selected' : ''}" @click=${() => this._selectProvider(p)}>
            <div class="brand-circle" style="background:${brand.bg};color:${brand.color}">${brand.initial}</div>
            <div class="item-info">
              <div class="item-name">${p.display_name || p.name}</div>
              <div class="item-url">${p.api_base_url || p.deployment_type}</div>
            </div>
            <span class="status-dot ${p.enabled ? 'status-on' : 'status-off'}" title=${p.enabled ? '已启用' : '已禁用'}></span>
            ${p.is_default ? html`<span class="default-star" title="默认提供商">★</span>` : ''}
          </div>`;
        })}
      </div>
      <div class="sidebar-footer">
        <button class="add-btn" @click=${this._openAddPicker}>
          + 添加提供商
        </button>
      </div>
    </div>`;
  }

  _renderDetail() {
    // test result banner
    const testBanner = this.testResult ? html`
      <div style="padding:8px 28px 0">
        <div class="msg ${this.testResult.startsWith('✅') ? 'msg-ok' : 'msg-err'}">${this.testResult}</div>
      </div>` : null;

    if (this.viewMode === "picker") {
      return html`<div class="detail">${testBanner}<div class="detail-inner">${this._renderPicker()}</div></div>`;
    }
    if (this.viewMode === "form") {
      return html`<div class="detail">${testBanner}<div class="detail-inner">${this._renderForm()}</div></div>`;
    }
    // placeholder
    return html`<div class="detail">${testBanner}<div class="placeholder">
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M20 9h3"/><path d="M20 14h3"/><path d="M1 9h3"/><path d="M1 14h3"/></svg>
      <p>${this.providers.length === 0 ? '选择下方模板快速配置 AI 提供商' : '从左侧选择一个提供商查看详情'}</p>
    </div></div>`;
  }

  _renderPicker() {
    return html`
      <div class="form-section-title">新建提供商</div>

      <!-- 自定义 — 放最前面，和 pi-web 一致 -->
      <div class="picker-section-label">自定义</div>
      <div class="template-grid" style="margin-bottom:18px">
        <div class="template-card custom" @click=${this._openCustomForm}>
          <div class="t-circle" style="font-size:16px;font-weight:300">+</div>
          <div class="t-name">OpenAI / Anthropic 兼容</div>
          <div class="t-desc">自定义 API 端点 · 手动填写</div>
        </div>
      </div>

      <!-- 预置模板 -->
      <div class="picker-section-label">预置提供商</div>
      <div class="template-grid" style="margin-bottom:20px">
        ${PROVIDER_TEMPLATES.map(tpl => html`
          <div class="template-card" @click=${() => this._selectTemplate(tpl)}>
            <div class="t-circle" style="background:${tpl.bg};color:${tpl.color}">${tpl.displayName.charAt(0)}</div>
            <div class="t-name">${tpl.displayName}</div>
            <div class="t-desc">${tpl.description}</div>
          </div>
        `)}
      </div>
    `;
  }

  _renderForm() {
    const isEdit = !!this.editing;
    const brand = brandFor(this.form.name || "new");
    return html`
      <div class="form-section-title">${isEdit ? '编辑提供商' : '新建提供商'}</div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">标识名 ${!isEdit ? html`<span style="color:var(--destructive)">*</span>` : ''}</label>
          <input class="form-input" .value=${this.form.name} @input=${(e: any) => this.form.name = e.target.value} placeholder="anthropic" ?disabled=${isEdit} style="font-family:var(--font-mono,monospace)" />
        </div>
        <div class="form-group">
          <label class="form-label">显示名称</label>
          <input class="form-input" .value=${this.form.display_name} @input=${(e: any) => this.form.display_name = e.target.value} placeholder="Anthropic Claude" />
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">部署类型</label>
        <select class="form-select" .value=${this.form.deployment_type} @change=${(e: any) => this.form.deployment_type = e.target.value}>
          ${DEPLOY_TYPES.map(d => html`<option value=${d.value}>${d.label}</option>`)}
        </select>
      </div>

      <div class="form-group">
        <label class="form-label">API 兼容格式</label>
        <select class="form-select" .value=${this.form.api_format} @change=${(e: any) => this.form.api_format = e.target.value}>
          ${API_FORMATS.map(f => html`<option value=${f.value}>${f.label}</option>`)}
        </select>
        <span class="form-hint">自定义提供商需指定 API 格式，预置模板可自动检测</span>
      </div>

      <div class="form-group">
        <label class="form-label">API Key</label>
        <div class="key-wrapper">
          <input class="form-input" type=${this.showKey ? "text" : "password"} autocomplete="new-password" .value=${this.form.api_key} @input=${(e: any) => this.form.api_key = e.target.value} placeholder=${isEdit ? "留空不修改" : "sk-..."} style="font-family:var(--font-mono,monospace)" />
          <button class="key-toggle" type="button" @click=${() => { this.showKey = !this.showKey; }} title=${this.showKey ? "隐藏 API Key" : "显示 API Key"}>
            ${this.showKey ? icons['eye-off'] : icons['eye']}
          </button>
        </div>
        <span class="form-hint">Key 将加密存储到数据库${isEdit ? ' · 留空则不修改' : ''}</span>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Base URL</label>
          <input class="form-input" .value=${this.form.api_base_url} @input=${(e: any) => this.form.api_base_url = e.target.value} @blur=${this._fetchModels} placeholder="https://api.anthropic.com/v1" style="font-family:var(--font-mono,monospace)" />
        </div>
        <div class="form-group">
          <label class="form-label">默认模型</label>
          <input class="form-input" .value=${this.form.default_model} @input=${(e: any) => this.form.default_model = e.target.value} @blur=${this._fetchModels} placeholder="claude-sonnet-4-6" style="font-family:var(--font-mono,monospace)" list="model-suggestions" autocomplete="off" />
          <datalist id="model-suggestions">
            ${this.modelSuggestions.map(m => html`<option value=${m} />`)}
          </datalist>
        </div>
      </div>

      <!-- Models -->
      <div style="margin-top:4px;padding-top:16px;border-top:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div class="form-section-title" style="margin-bottom:0">模型列表</div>
          <button class="btn" style="font-size:11px;padding:3px 10px" @click=${this._addModel}>+ 添加模型</button>
        </div>
        ${this.form.models.length === 0 ? html`
          <div style="padding:16px;text-align:center;color:var(--muted);font-size:12px;border:1px dashed var(--border);border-radius:6px">
            暂无模型 · 默认模型字段已指定基础模型，此处可配置更多
          </div>
        ` : this.form.models.map((m, i) => html`
          <div style="border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:8px;background:var(--card)">
            <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px">
              <div class="form-group" style="flex:1;margin-bottom:0">
                <label class="form-label" style="font-size:10px">模型 ID</label>
                <input class="form-input" style="font-size:12px;padding:5px 8px;font-family:var(--font-mono,monospace)"
                  .value=${m.id} @input=${(e: any) => this._updateModel(i, { id: e.target.value })}
                  placeholder="claude-sonnet-4-6" />
              </div>
              <div class="form-group" style="flex:1;margin-bottom:0">
                <label class="form-label" style="font-size:10px">显示名称</label>
                <input class="form-input" style="font-size:12px;padding:5px 8px"
                  .value=${m.name || ""} @input=${(e: any) => this._updateModel(i, { name: e.target.value || undefined })}
                  placeholder="Claude Sonnet 4.6" />
              </div>
              <button class="model-remove-btn" @click=${() => this._removeModel(i)} title="删除此模型">
                ${icons['trash-2']}
              </button>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px">
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" style="font-size:10px">Context Window</label>
                <input class="form-input" style="font-size:12px;padding:5px 8px" type="number"
                  .value=${m.contextWindow !== undefined ? String(m.contextWindow) : ""}
                  @input=${(e: any) => this._updateModel(i, { contextWindow: e.target.value ? parseInt(e.target.value) : undefined })}
                  placeholder="200000" />
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" style="font-size:10px">Max Tokens</label>
                <input class="form-input" style="font-size:12px;padding:5px 8px" type="number"
                  .value=${m.maxTokens !== undefined ? String(m.maxTokens) : ""}
                  @input=${(e: any) => this._updateModel(i, { maxTokens: e.target.value ? parseInt(e.target.value) : undefined })}
                  placeholder="16384" />
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" style="font-size:10px">Cost Input ($/1M)</label>
                <input class="form-input" style="font-size:12px;padding:5px 8px" type="number" step="0.01"
                  .value=${m.cost?.input !== undefined ? String(m.cost.input) : ""}
                  @input=${(e: any) => this._updateModel(i, { cost: { ...m.cost, input: e.target.value ? parseFloat(e.target.value) : undefined } })}
                  placeholder="3.00" />
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" style="font-size:10px">Cost Output ($/1M)</label>
                <input class="form-input" style="font-size:12px;padding:5px 8px" type="number" step="0.01"
                  .value=${m.cost?.output !== undefined ? String(m.cost.output) : ""}
                  @input=${(e: any) => this._updateModel(i, { cost: { ...m.cost, output: e.target.value ? parseFloat(e.target.value) : undefined } })}
                  placeholder="15.00" />
              </div>
            </div>
          </div>
        `)}
      </div>

      <!-- Provider info bar -->
      ${isEdit ? html`
        <div class="toggle-row">
          <div class="toggle-item" @click=${() => this._toggle(this.editing!)}>
            <div class="toggle-switch ${this.editing!.enabled ? 'on' : ''}"></div>
            <span>${this.editing!.enabled ? '已启用' : '已禁用'}</span>
          </div>
          ${this.editing!.is_default ? html`
            <span style="font-size:11px;color:var(--accent);font-weight:500">★ 默认提供商</span>
          ` : html`
            <button class="btn" style="font-size:11px;padding:4px 10px" @click=${() => this._setDefault(this.editing!)}>设为默认</button>
          `}
        </div>
      ` : ''}

      ${this.formMsg ? html`<div class="msg msg-err">${this.formMsg}</div>` : ''}

      <div class="actions-bar">
        ${isEdit ? html`
          <button class="btn" @click=${() => this._test(this.editing!)} ?disabled=${this.testing}>
            ${this.testing ? '测试中...' : '测试连接'}
          </button>
        ` : ''}
        <span class="spacer"></span>
        ${isEdit ? html`
          <button class="btn-danger-outline" @click=${() => this._delete(this.editing!)}>删除</button>
        ` : html`
          <button class="btn" @click=${() => { this.viewMode = "picker"; }}>返回模板</button>
        `}
        <button class="btn-primary ${this.savedOk ? 'btn-success' : ''}" @click=${this._save} ?disabled=${this.saving || !this.form.name}>
          ${this.savedOk ? html`${icons['check']} 已保存` : this.saving ? '保存中...' : '保存'}
        </button>
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "llm-config-page": LLMConfigPage; } }
