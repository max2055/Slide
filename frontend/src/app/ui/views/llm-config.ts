import "../components/app-card.js";
import "../components/app-form-field.js";
import "../components/app-notice.js";
import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
/**
 * LLM 配置管理 — 两栏布局：左侧提供商列表 + 右侧详情/模板选择
 * 参考 pi-web ModelsConfig 的 UX 模式优化
 */
import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { customElement, property, state } from "lit/decorators.js";
import { apiClient } from "../../../api/index.js";
import { icons } from "../../../icons.js";

interface LLMProvider {
  id: number; name: string; display_name: string;
  deployment_type: string; api_format?: string;
  api_base_url?: string; default_model?: string;
  models_supported?: ModelConfig[];
  enabled: boolean; is_default: boolean; supports_function_call?: boolean;
  context_window?: number; max_tokens?: number; supports_vision?: boolean;
}

interface ModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number };
  supportsFunctionCall?: boolean;
  supportsVision?: boolean;
  parameterSource?: 'api' | 'catalog' | 'unknown' | 'manual';
  parameterProvider?: string;
}

interface FormData {
  name: string; display_name: string; api_base_url: string;
  default_model: string; deployment_type: string; api_format: string;
  api_key: string; enabled: boolean; is_default: boolean;
  models: ModelConfig[]; supports_function_call?: boolean;
  context_window?: number; max_tokens?: number; supports_vision?: boolean;
  provider_type?: string;
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
  { id: "stepfun", name: "stepfun", displayName: "StepFun 阶跃星辰", color: "var(--accent)", bg: "var(--accent-subtle)", baseUrl: "https://api.stepfun.com/v1", defaultModel: "step-3.5-flash-2603", deploymentType: "api", description: "Step 3.5 / 3.7 Flash", models: ["step-3.5-flash-2603", "step-3.5-flash", "step-3.7-flash"] },
  { id: "mimo", name: "mimo", displayName: "Xiaomi MiMo", color: "var(--accent)", bg: "var(--accent-subtle)", baseUrl: "https://api.xiaomimimo.com/v1", defaultModel: "mimo-v2-flash", deploymentType: "api", description: "MiMo Flash / Pro", models: ["mimo-v2-flash", "mimo-v2-pro", "mimo-v2.6-flash", "mimo-v2.6-pro"] },
  { id: "anthropic", name: "anthropic", displayName: "Anthropic Claude", color: "#d97706", bg: "rgba(217,119,6,0.12)", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-6", deploymentType: "api", description: "Claude Sonnet / Opus / Haiku", models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-5", "claude-sonnet-4-5", "claude-3.5-sonnet", "claude-3.5-haiku"] },
  { id: "openai", name: "openai", displayName: "OpenAI", color: "#10a37f", bg: "rgba(16,163,127,0.12)", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4.1", deploymentType: "api", description: "GPT-4.1 / GPT-4o / o4-mini", models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini", "o4-mini", "o3-mini", "gpt-4-turbo"] },
  { id: "deepseek", name: "deepseek", displayName: "DeepSeek", color: "#4f46e5", bg: "rgba(79,70,229,0.12)", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-v4-pro", deploymentType: "api", description: "DeepSeek V4 Pro / Flash", models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-reasoner", "deepseek-chat", "deepseek-coder"] },
  { id: "google", name: "google", displayName: "Google Gemini", color: "#4285f4", bg: "rgba(66,133,244,0.12)", baseUrl: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-2.5-pro", deploymentType: "api", description: "Gemini 2.5 Pro / Flash", models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"] },
  { id: "ollama", name: "ollama", displayName: "Ollama", color: "#374151", bg: "rgba(55,65,81,0.12)", baseUrl: "http://localhost:11434/v1", defaultModel: "qwen2.5-coder:32b", deploymentType: "local", description: "本地部署 · 开源模型", models: ["qwen2.5-coder:32b", "qwen2.5:72b", "llama3.3:70b", "deepseek-r1:70b", "codellama:70b", "mistral:7b", "gemma3:27b", "phi4:14b"] },
];

interface SceneConfig {
  scene: string;
  binding: { provider_id: number; model: string } | null;
  effective: { provider_id: number; provider_name: string; model: string; source: string } | null;
  error: string | null;
}
const SCENE_LABELS: Record<string, string> = { default: '全局默认', chat: '智能对话', sql_analysis: 'SQL 分析', fault_diagnosis: '故障诊断', health_check: '健康检查' };
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
  moonshot: { color: "#409eff", bg: "rgba(64,158,255,0.12)" },
  kimi: { color: "#409eff", bg: "rgba(64,158,255,0.12)" },
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
  @property({ type: String }) activeTab = "providers";
  @state() private scenes: SceneConfig[] = [];
  @state() private sceneDrafts: Record<string, { provider_id: number | null; model: string }> = {};
  @state() private sceneMessage = '';
  @state() private sceneSaving = '';
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
  @state() private modelsLoading = false;
  @state() private modelsMessage = '';
  private _modelRequestVersion = 0;
  private _testRequestVersion = 0;
  private _savedOkTimer: ReturnType<typeof setTimeout> | null = null;
  static styles = [sharedFieldStyles, sharedBtnStyles, css`

    :host { display: block; height: 100%; }
    .shell { display: flex; height: 100%; min-height: 0; overflow: hidden; }
    .shell.scenes .detail { min-width: 0; }
    .shell.scenes app-card { overflow-wrap: anywhere; }
    @media (max-width: 720px) {
      .shell { flex-direction: column; }
      .shell .sidebar { width: auto; min-width: 0; max-height: 12rem; flex-shrink: 0; border-right: none; border-bottom: 1px solid var(--border); }
      .shell .detail-inner { padding: var(--space-md); }
    }
    .page-header { margin-bottom: 24px; }
    .page-header h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; color: var(--text-strong); }
    .page-header p { font-size: 13px; color: var(--muted); margin: 0; }

    /* Sidebar */
    .sidebar { width: 240px; min-width: 240px; border-right: 1px solid var(--border); background: var(--card); display: flex; flex-direction: column; overflow: hidden; }
    .sidebar-list { flex: 1; overflow-y: auto; padding: 4px 6px; }

    /* Sidebar empty */
    .sidebar-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px 16px; text-align: center; gap: 10px; }
    .sidebar-empty svg { opacity: 0.2; }
    .sidebar-empty p { font-size: 11px; color: var(--muted); margin: 0; line-height: 1.4; }
    .sidebar-empty .add-first-btn { margin-top: 4px; padding: 6px 16px; border-radius: var(--radius-md); font-size: 12px; font-weight: 500; cursor: pointer; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-foreground); transition: opacity 0.15s; }
    .sidebar-empty .add-first-btn:hover { opacity: 0.85; }
    .sidebar-item { display: flex; align-items: center; gap: var(--space-sm); padding: 8px 10px; border-radius: var(--radius-md); cursor: pointer; transition: background 0.12s; }
    .sidebar-item:hover { background: var(--hover); }
    .sidebar-item.selected { background: var(--active); }
    .brand-circle { width: 28px; height: 28px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; color: inherit; }
    .item-info { flex: 1; min-width: 0; }
    .item-name { font-size: 12px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item-url { font-size: 10px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .status-on { background: #22c55e; }
    .status-off { background: var(--border); }
    .default-star { font-size: 11px; color: var(--accent-text); flex-shrink: 0; margin-left: -2px; }
    .sidebar-footer { padding: 8px 6px; border-top: 1px solid var(--border); }
    .add-btn { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; padding: 7px 0; background: none; border: 1px dashed var(--border); border-radius: var(--radius-md); color: var(--muted); cursor: pointer; font-size: 12px; transition: border-color 0.12s, color 0.12s; }
    .add-btn:hover { border-color: var(--accent); color: var(--accent-text); }

    /* Detail */
    .detail { flex: 1; overflow-y: auto; padding: 0; display: flex; flex-direction: column; background: var(--bg-elevated); }
    .detail-inner { padding: 20px 28px; max-width: 560px; }

    /* Template picker */
    .picker-section-label { font-size: 10px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 8px; margin-top: 4px; }
    .template-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
    .template-card { display: flex; flex-direction: column; align-items: center; gap: var(--space-sm); padding: 16px 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); cursor: pointer; text-align: center; transition: border-color 0.12s, background 0.12s; }
    .template-card:hover { border-color: var(--accent); background: var(--bg-accent); }
    .template-card .t-circle { width: 36px; height: 36px; border-radius: var(--radius-lg); display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; }
    .template-card .t-name { font-size: 12px; font-weight: 600; color: var(--text); }
    .template-card .t-desc { font-size: 10px; color: var(--muted); line-height: 1.3; }
    .template-card.custom .t-circle { border: 1.5px dashed var(--border); background: transparent; color: var(--muted); }

    /* Form */
    .form-section-title { font-size: var(--text-xs); font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
    .form-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
    .form-label { font-size: var(--text-sm); font-weight: 500; color: var(--text); }
    .form-input, .form-select { width: 100%; padding: var(--space-sm) var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: var(--text-base); background: var(--card); color: var(--text); box-sizing: border-box; transition: border-color 0.15s; }
    .form-input:focus, .form-select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }
    .form-input:disabled { opacity: 0.5; background: var(--bg-elevated); cursor: not-allowed; }
    .form-hint { font-size: var(--text-xs); color: var(--muted); margin-top: 2px; }
    .form-row { display: flex; gap: 10px; }
    .form-row > .form-group { flex: 1; }
    .model-controls { display: flex; flex-wrap: wrap; align-items: end; gap: var(--space-md); margin-bottom: var(--space-md); }
    .model-controls app-form-field { flex: 1; min-width: 180px; }
    .provider-controls { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-md); margin-bottom: var(--space-md); }
    .provider-controls app-form-field { min-width: 0; margin-bottom: 0; }
    .provider-controls .btn { justify-self: start; }
    @media (min-width: 721px) {
      .provider-controls { grid-template-columns: repeat(2, minmax(0, 1fr)) auto; grid-template-rows: auto auto auto; row-gap: var(--space-xs); align-items: start; }
      /* Share label, control and hint rows through the form field's public parts. */
      .provider-controls app-form-field { display: grid; grid-template-rows: subgrid; grid-row: 1 / -1; }
      .provider-controls app-form-field:first-child { grid-column: 1; }
      .provider-controls app-form-field:nth-child(2) { grid-column: 2; }
      .provider-controls app-form-field::part(field) { display: grid; grid-template-rows: subgrid; grid-row: 1 / -1; }
      .provider-controls app-form-field::part(label) { grid-row: 1; margin-bottom: 0; }
      .provider-controls app-form-field::part(control) { grid-row: 2; min-width: 0; }
      .provider-controls app-form-field::part(hint) { grid-row: 3; margin-top: 0; }
      .provider-controls .btn { grid-column: 3; grid-row: 2; }
    }
    .key-wrapper { position: relative; }
    .key-wrapper .form-input { padding-right: 34px; }
    .key-toggle { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 24px; height: 24px; padding: 0; border: none; background: transparent; color: var(--muted); cursor: pointer; display: flex; align-items: center; justify-content: center; }

    .model-remove-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; margin-top: 14px; flex-shrink: 0; border: 1px solid rgba(239,68,68,0.25); border-radius: var(--radius-sm); background: transparent; color: var(--danger); cursor: pointer; transition: background 0.12s, border-color 0.12s; }
    .model-remove-btn:hover { background: rgba(239,68,68,0.1); border-color: #ef4444; }
    .model-remove-btn svg { width: 14px; height: 14px; }
    .actions-bar { display: flex; gap: var(--space-sm); align-items: center; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
    .actions-bar .spacer { flex: 1; }

    /* Status toggle */
    .toggle-row { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; }
    .toggle-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text); cursor: pointer; }
    .toggle-switch { width: 36px; height: 20px; border-radius: 999px; background: var(--border); position: relative; transition: background 0.2s; flex-shrink: 0; }
    .toggle-switch.on { background: #22c55e; }
    .toggle-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.2s; }
    .toggle-switch.on::after { transform: translateX(16px); }

    /* Messages */
    .msg { font-size: 12px; padding: 8px 12px; border-radius: var(--radius-sm); margin-bottom: 12px; }
    .msg-ok { background: var(--ok-subtle); color: var(--ok); }
    .msg-err { background: var(--danger-subtle); color: var(--danger); }

    /* Placeholder */
    .placeholder { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--muted); text-align: center; padding: 40px; gap: 12px; }
    .placeholder svg { opacity: 0.25; }
    .placeholder p { font-size: 13px; margin: 0; }
  `];

  override connectedCallback() { super.connectedCallback(); this._load(); }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._savedOkTimer) clearTimeout(this._savedOkTimer);
    this._modelRequestVersion++;
    this._resetTest();
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  private async _load(silent = false) {
    if (!silent) { this.loading = true; }
    this.error = null;
    try {
      const data = await apiClient.get<LLMProvider[]>("/llm/configs");
      this.providers = Array.isArray(data) ? data : [];
      await this._loadScenes();
      if (this.selectedId && !this.providers.find(p => p.id === this.selectedId)) {
        this.selectedId = null;
        this.editing = null;
        this.viewMode = this.providers.length === 0 ? "picker" : "placeholder";
      }
      // 刷新 editing 引用以保持 UI 同步
      if (this.editing) {
        const fresh = this.providers.find(p => p.id === this.editing!.id);
        if (fresh) {
          this.editing = fresh;
          this.form = { ...this.form, enabled: fresh.enabled, is_default: fresh.is_default };
        } else {
          this.editing = null;
        }
      }
      // First load with no providers: show template picker directly
      if (this.providers.length === 0) {
        this.viewMode = "picker";
      } else if (this.viewMode === "placeholder") {
        this._selectProvider(
          this.providers.find(p => p.is_default)
          ?? this.providers.find(p => p.enabled)
          ?? this.providers[0],
        );
      }
    } catch (e: any) { this.error = e.message || "加载失败"; }
    finally { if (!silent) { this.loading = false; } }
  }

  // ── Sidebar actions ──────────────────────────────────────────────────────

  _selectProvider(p: LLMProvider) {
    this._resetTest();
    this._resetDiscovery();
    const selectedModel = p.models_supported?.find(m => m.id === p.default_model);
    this.selectedId = p.id;
    this.editing = p;
    this.form = {
      name: p.name, display_name: p.display_name || "",
      api_base_url: p.api_base_url || "", default_model: p.default_model || "",
      deployment_type: p.deployment_type || "api",
      api_format: p.api_format || "", api_key: "",
      enabled: p.enabled, is_default: p.is_default, supports_function_call: selectedModel?.supportsFunctionCall ?? Boolean(p.supports_function_call),
      context_window: p.models_supported?.find(m => m.id === p.default_model)?.contextWindow ?? p.context_window,
      max_tokens: p.max_tokens ?? 4096, supports_vision: selectedModel?.supportsVision ?? Boolean(p.supports_vision),
      provider_type: p.models_supported?.find(m => m.id === p.default_model)?.parameterProvider,
      models: (p.models_supported || []).map((m: any) => ({
        ...m,
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
    this.modelSuggestions = this.form.models.map(m => m.id);
  }

  _openAddPicker() {
    this._resetTest();
    this.selectedId = null;
    this.editing = null;
    this.viewMode = "picker";
    this.formMsg = null;
    this.testResult = null;
  }

  _selectTemplate(tpl: ProviderTemplate) {
    this._resetTest();
    this._resetDiscovery();
    this.editing = null;
    this.form = {
      name: tpl.name, display_name: tpl.displayName,
      api_base_url: tpl.baseUrl, default_model: tpl.defaultModel,
      deployment_type: tpl.deploymentType, api_format: "", api_key: "",
      enabled: true, is_default: this.providers.length === 0,
      models: [],
      max_tokens: 4096, provider_type: ['deepseek', 'stepfun', 'mimo'].includes(tpl.id) ? tpl.id : undefined,
    };
    this.modelSuggestions = tpl.models;
    this.viewMode = "form";
    this.formMsg = null;
    this.testResult = null;
    this.showKey = false;
  }

  _openCustomForm() {
    this._resetTest();
    this._resetDiscovery();
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
      const window = this.form.context_window;
      const output = this.form.max_tokens;
      const selected = this.form.models.find(m => m.id === this.form.default_model);
      if (!this.form.default_model.trim()) throw new Error('请选择或填写模型 ID。');
      if (!Number.isSafeInteger(window) || !window || window <= 1025) throw new Error('请填写有效的上下文窗口，未知模型需要手动配置。');
      if (!Number.isSafeInteger(output) || !output || output <= 0 || output + 1024 >= window) throw new Error('Max Tokens 必须大于 0，并为输入保留空间（Max Tokens + 1024 < 上下文窗口）。');
      if (selected?.maxTokens !== undefined && output > selected.maxTokens) throw new Error('Max Tokens 超过所选模型的最大输出限制。');
      const models = selected ? this.form.models : [...this.form.models, {
        id: this.form.default_model, name: this.form.default_model, contextWindow: window,
        supportsFunctionCall: Boolean(this.form.supports_function_call), supportsVision: Boolean(this.form.supports_vision),
        parameterProvider: this.form.provider_type || undefined, parameterSource: 'manual' as const,
      }];
      const body: any = {
        name: this.form.name,
        displayName: this.form.display_name || undefined,
        deploymentType: this.form.deployment_type,
        apiFormat: this.form.api_format || undefined,
        apiKey: this.form.api_key || undefined,
        baseURL: this.form.api_base_url || undefined,
        model: this.form.default_model || undefined,
        enabled: this.form.enabled,
        supportsFunctionCall: Boolean(this.form.supports_function_call),
        supportsVision: Boolean(this.form.supports_vision),
        contextWindow: window, maxTokens: output,
        modelsSupported: models,
      };
      if (!body.apiKey) delete body.apiKey;
      if (this.editing) {
        const result = await apiClient.put<{ success: boolean; error?: string }>(`/llm/configs/${this.editing.id}`, body);
        if (result?.success === false) throw new Error(result.error || '保存失败');
      } else {
        const result = await apiClient.post<{ success: boolean; error?: string }>("/llm/configs", body);
        if (result?.success === false) throw new Error(result.error || '保存失败');
      }
      this.form = { ...this.form, api_key: '' };
      this._resetTest();
      this.savedOk = true;
      if (this._savedOkTimer) clearTimeout(this._savedOkTimer);
      this._savedOkTimer = setTimeout(() => { this.savedOk = false; }, 2500);
      await this._load(true);
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
    try {
      await apiClient.post(`/llm/configs/${p.id}/toggle`);
      await this._load(true);
      // 刷新 editing 引用，否则 toggle 开关显示旧状态
      if (this.editing && this.editing.id === p.id) {
        const fresh = this.providers.find(prov => prov.id === p.id);
        if (fresh) {
          this.editing = fresh;
          this.form = { ...this.form, enabled: fresh.enabled, is_default: fresh.is_default };
        }
      }
    } catch (_) {}
  }

  private async _setDefault(p: LLMProvider) {
    try {
      await apiClient.post(`/llm/configs/${p.id}/default`);
      await this._load(true);
      // 刷新 editing 引用以保持 UI 同步
      if (this.editing && this.editing.id === p.id) {
        const fresh = this.providers.find(prov => prov.id === p.id);
        if (fresh) {
          this.editing = fresh;
          this.form = { ...this.form, enabled: fresh.enabled, is_default: fresh.is_default };
        }
      }
    } catch (_) {}
  }

  private async _delete(p: LLMProvider) {
    if (!confirm(`确定删除提供商 "${p.display_name || p.name}"？`)) return;
    try {
      await apiClient.delete(`/llm/configs/${p.id}`);
      this._resetTest();
      if (this.selectedId === p.id) { this.selectedId = null; this.viewMode = "placeholder"; this.editing = null; }
      await this._load(true);
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
    const selected = models[idx]?.id === this.form.default_model;
    this.form = { ...this.form, models, ...(selected && patch.contextWindow !== undefined ? { context_window: patch.contextWindow } : {}) };
  }

  private _resetDiscovery() {
    this._modelRequestVersion++; this.modelsLoading = false; this.modelsMessage = ''; this.modelSuggestions = [];
  }

  private _selectModel(id: string) {
    this._resetTest();
    const selected = this.form.models.find(m => m.id === id);
    this.form = { ...this.form, default_model: id,
      context_window: selected?.contextWindow,
      max_tokens: Math.min(4096, selected?.maxTokens ?? 4096, Math.max(1, (selected?.contextWindow ?? 8192) - 1025)),
      supports_function_call: selected?.supportsFunctionCall ?? false, supports_vision: selected?.supportsVision ?? false };
    this.modelsMessage = selected?.contextWindow ? '已应用所选模型参数，可按需要修改后保存。' : '未知模型参数，请手动填写上下文窗口、Max Tokens 和工具调用能力。';
  }

  private _setSelectedParameters(patch: Partial<FormData>) {
    const models = this.form.models.map(m => m.id !== this.form.default_model ? m : { ...m,
      ...(patch.context_window !== undefined ? { contextWindow: patch.context_window } : {}),
      ...(patch.supports_function_call !== undefined ? { supportsFunctionCall: patch.supports_function_call } : {}),
      ...(patch.supports_vision !== undefined ? { supportsVision: patch.supports_vision } : {}),
      parameterSource: 'manual' as const });
    this.form = { ...this.form, ...patch, models };
  }

  private async _fetchModels() {
    const url = this.form.api_base_url.trim();
    if (!url || !this.form.name.trim() || this.modelsLoading) return;
    const version = ++this._modelRequestVersion;
    const name = this.form.name;
    const type = this.form.provider_type;
    this.modelsLoading = true; this.modelsMessage = '';
    try {
      const res = await apiClient.post<{ models: ModelConfig[]; source: string; warning?: string }>('/llm/models', {
        providerName: name, baseURL: url, apiKey: this.form.api_key.trim() || undefined,
        apiFormat: this.form.api_format || undefined, deploymentType: this.form.deployment_type, providerType: type || undefined,
      });
      if (version !== this._modelRequestVersion || this.form.name !== name || this.form.api_base_url.trim() !== url || this.form.provider_type !== type) return;
      if (!Array.isArray(res?.models)) throw new Error('供应商未返回有效模型列表');
      this.form = { ...this.form, models: res.models };
      this.modelSuggestions = res.models.map(m => m.id);
      if (res.models.some(m => m.id === this.form.default_model)) this._selectModel(this.form.default_model);
      this.modelsMessage = res.warning || `已加载 ${res.models.length} 个模型，请选择模型以应用参数。`;
    } catch (error: any) {
      if (version === this._modelRequestVersion) this.modelsMessage = `加载模型失败：${error.message}`;
    } finally { if (version === this._modelRequestVersion) this.modelsLoading = false; }
  }

  private _resetTest() {
    this._testRequestVersion++;
    this.testing = false;
    this.testResult = null;
  }

  private _testDraft(p: LLMProvider) {
    // Existing providers are resolved by their persisted name; other fields remain draft-only.
    const draft: Record<string, string> = { providerName: p.name };
    if (this.form.api_key.trim()) draft.apiKey = this.form.api_key.trim();
    if (this.form.api_base_url.trim()) draft.baseURL = this.form.api_base_url.trim();
    if (this.form.default_model.trim()) draft.model = this.form.default_model.trim();
    if (this.form.api_format.trim()) draft.apiFormat = this.form.api_format.trim();
    if (this.form.deployment_type.trim()) draft.deploymentType = this.form.deployment_type.trim();
    return draft;
  }

  private async _test(p: LLMProvider) {
    const version = ++this._testRequestVersion;
    const draft = this._testDraft(p);
    const isCurrent = () => version === this._testRequestVersion && this.editing?.id === p.id
      && JSON.stringify(draft) === JSON.stringify(this._testDraft(this.editing));
    this.testing = true; this.testResult = null;
    try {
      const r = await apiClient.post<any>("/llm/test", draft);
      if (isCurrent()) this.testResult = r.success ? `✅ ${r.message || "连接成功"}` : `❌ ${r.error || r.message || "连接失败"}`;
    } catch (e: any) {
      if (isCurrent()) this.testResult = `❌ ${e.message || "连接失败"}`;
    } finally { if (version === this._testRequestVersion) this.testing = false; }
  }

  protected override async updated(changed: Map<PropertyKey, unknown>) {
    if ((changed.has('testing') || changed.has('testResult')) && (this.testing || this.testResult)) {
      const region = this.renderRoot.querySelector('[aria-label="连接测试结果"]');
      // The nested notice must finish rendering before its height can be scrolled into view.
      await region?.querySelector<LitElement>('app-notice')?.updateComplete;
      if (region?.isConnected && (this.testing || this.testResult)) region.scrollIntoView?.({ block: 'nearest' });
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  override render() {
    if (this.loading) {
      return html`<div class="loading" style="flex-direction:column;gap:16px;padding:var(--space-xl);">
        <div class="skeleton-block" style="width:200px;height:24px;"></div>
        <div class="skeleton-block" style="width:100%;height:200px;"></div>
        <div class="skeleton-line skeleton-line--long"></div>
      </div>`;
    }
    if (this.error) {
      return html`<div style="padding:var(--space-xl);text-align:center;color:var(--danger);font-size:var(--text-base)">${this.error}</div>`;
    }

    return html`
      <div style="display:flex;flex-direction:column;height:100%">
        <div class="page-header">
          <h1>${this.activeTab === 'scenes' ? '场景分配' : '模型配置'}</h1>
          <p>${this.activeTab === 'scenes' ? '为不同场景分配提供商和模型，未单独分配时跟随全局默认' : '管理 AI 提供商：添加、编辑、启停、测试连接'}</p>
        </div>
        <div class="shell ${this.activeTab === 'scenes' ? 'scenes' : ''}" style="flex:1">
          ${this.activeTab === "scenes" ? "" : this._renderSidebar()}
          ${this._renderDetail()}
        </div>
      </div>
    `;
  }

  private async _loadScenes() {
    try {
      this.scenes = await apiClient.get<SceneConfig[]>('/llm/scenes');
      this.sceneDrafts = Object.fromEntries(this.scenes.map(row => [row.scene,
        row.binding ? { ...row.binding } : { provider_id: null, model: '' }]));
      this.sceneMessage = '';
    } catch (error: any) { this.sceneMessage = error.message || '场景配置加载失败'; }
  }

  private async _saveScene(scene: string) {
    this.sceneSaving = scene;
    this.sceneMessage = '';
    const draft = this.sceneDrafts[scene];
    try {
      await apiClient.put(`/llm/scenes/${scene}`, draft.provider_id === null
        ? { provider_id: null } : draft);
      await this._loadScenes();
    } catch (error: any) { this.sceneMessage = error.message || '场景配置保存失败'; }
    finally { this.sceneSaving = ''; }
  }

  private _renderScenes() {
    return html`
      <p class="form-hint">未单独分配的场景跟随全局默认。全局默认在提供商详情中设置。健康检查的规则评分不调用模型。</p>
      ${this.sceneMessage ? html`<p role="alert" class="msg msg-err">${this.sceneMessage}</p>
        <button class="btn" @click=${this._loadScenes}>重新加载</button>` : ''}
      ${this.scenes.map(row => {
        const draft = this.sceneDrafts[row.scene];
        const provider = this.providers.find(p => p.id === draft?.provider_id);
        const models = [...new Set([provider?.default_model, ...(provider?.models_supported || []).map(m => m.id)].filter(Boolean))] as string[];
        return html`<app-card style="margin-bottom:var(--space-md)">
          <span slot="header">${SCENE_LABELS[row.scene]}</span>
          ${row.scene !== 'default' ? html`
            <app-form-field label="提供商">
              <select class="form-select" aria-label=${SCENE_LABELS[row.scene] + '提供商'} .value=${String(draft.provider_id ?? '')}
                .disabled=${!!this.sceneSaving} @change=${(e: Event) => {
                  const id = Number((e.target as HTMLSelectElement).value) || null;
                  this.sceneDrafts = { ...this.sceneDrafts, [row.scene]: { provider_id: id, model: this.providers.find(p => p.id === id)?.default_model || '' } };
                }}>
                <option value="" .selected=${draft.provider_id === null}>跟随全局默认</option>
                ${draft.provider_id && !provider ? html`<option value=${String(draft.provider_id)} .selected=${true}>已删除的提供商 #${draft.provider_id}</option>` : ''}
                ${this.providers.map(p => html`<option value=${String(p.id)} .selected=${p.id === draft.provider_id} .disabled=${!p.enabled}>${p.display_name || p.name}${p.enabled ? '' : '（已禁用）'}</option>`)}
              </select>
            </app-form-field>
            ${draft.provider_id !== null ? html`<app-form-field label="模型">
              <select class="form-select" aria-label=${SCENE_LABELS[row.scene] + '模型'} .value=${draft.model} .disabled=${!!this.sceneSaving}
                @change=${(e: Event) => { this.sceneDrafts = { ...this.sceneDrafts, [row.scene]: { ...draft, model: (e.target as HTMLSelectElement).value } }; }}>
                ${!models.includes(draft.model) ? html`<option value=${draft.model} .selected=${true}>${draft.model || '请选择模型'}（不可用）</option>` : ''}
                ${models.map(model => html`<option value=${model} .selected=${model === draft.model}>${model}</option>`)}
              </select>
            </app-form-field>` : ''}
            <button class="btn-primary" .disabled=${!!this.sceneSaving || (draft.provider_id !== null && !draft.model)}
              @click=${() => this._saveScene(row.scene)}>${this.sceneSaving === row.scene ? '保存中…' : '保存分配'}</button>
          ` : ''}
          <p class="form-hint" aria-live="polite">${row.error || `当前生效：${row.effective?.provider_name} / ${row.effective?.model}${row.effective?.source === 'default' ? '（全局默认）' : ''}`}</p>
        </app-card>`;
      })}`;
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
    if (this.activeTab === "scenes") {
      return html`<div class="detail"><div class="detail-inner">${this._renderScenes()}</div></div>`;
    }
    if (this.viewMode === "picker") {
      return html`<div class="detail"><div class="detail-inner">${this._renderPicker()}</div></div>`;
    }
    if (this.viewMode === "form") {
      return html`<div class="detail"><div class="detail-inner" @input=${this._resetTest} @change=${this._resetTest}>${this._renderForm()}</div></div>`;
    }
    // placeholder
    return html`<div class="detail"><div class="placeholder">
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
          <label class="form-label">标识名 ${!isEdit ? html`<span style="color:var(--danger)">*</span>` : ''}</label>
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

      <div class="provider-controls">
        <app-form-field label="供应商参数目录" hint="自动识别官方地址；自定义代理可指定供应商。">
          <select class="form-select" aria-label="供应商参数目录" .value=${this.form.provider_type || ''}
            @change=${(e: Event) => { this._resetDiscovery(); this.form = { ...this.form, provider_type: (e.target as HTMLSelectElement).value }; }}>
            <option value="">自动识别 / 其他</option><option value="deepseek">DeepSeek</option><option value="stepfun">StepFun 阶跃星辰</option><option value="mimo">Xiaomi MiMo</option>
          </select>
        </app-form-field>
        <app-form-field label="Base URL">
          <input class="form-input" aria-label="Base URL" .value=${this.form.api_base_url}
            @input=${(e: Event) => { this._resetDiscovery(); this.form = { ...this.form, api_base_url: (e.target as HTMLInputElement).value }; }} placeholder="https://api.stepfun.com/v1" />
        </app-form-field>
        <button class="btn" data-testid="load-models" .disabled=${this.modelsLoading || !this.form.name.trim() || !this.form.api_base_url.trim()} @click=${this._fetchModels}>
          ${this.modelsLoading ? '加载中…' : '加载模型'}
        </button>
      </div>
      ${this.modelsMessage ? html`<p class="form-hint" role="status" aria-live="polite">${this.modelsMessage}</p>` : ''}
      <div class="model-controls">
        <app-form-field label="选择模型" hint="选择后自动应用参数，保存后生效。">
          <select class="form-select" aria-label="选择模型" .value=${this.form.default_model} .disabled=${this.modelsLoading}
            @change=${(e: Event) => this._selectModel((e.target as HTMLSelectElement).value)}>
            <option value="">请选择模型</option>
            ${this.form.default_model && !this.form.models.some(m => m.id === this.form.default_model) ? html`<option value=${this.form.default_model} .selected=${true}>${this.form.default_model}（手动配置）</option>` : ''}
            ${this.form.models.filter(m => m.id).map(m => html`<option value=${m.id} .selected=${m.id === this.form.default_model}>${m.name && m.name !== m.id ? `${m.name} · ${m.id}` : m.id}</option>`)}
          </select>
        </app-form-field>
        <app-form-field label="手动模型 ID" hint="列表中没有的模型仍可手动添加。">
          <input class="form-input" aria-label="手动模型 ID" .value=${this.form.default_model} @change=${(e: Event) => this._selectModel((e.target as HTMLInputElement).value.trim())}
            list="model-suggestions" autocomplete="off" />
          <datalist id="model-suggestions">${this.modelSuggestions.map(m => html`<option value=${m} />`)}</datalist>
        </app-form-field>
      </div>
      <div class="model-controls">
        <app-form-field label="上下文窗口" hint="输入、系统提示词、工具定义和输出共享此窗口。">
          <input class="form-input" aria-label="上下文窗口" type="number" min="1026" step="1" .value=${this.form.context_window !== undefined ? String(this.form.context_window) : ''}
            @input=${(e: Event) => this._setSelectedParameters({ context_window: Number((e.target as HTMLInputElement).value) })} />
        </app-form-field>
        <app-form-field label="Max Tokens（每次请求输出）" hint="默认预留 4096，需小于上下文窗口；不是模型总容量。">
          <input class="form-input" aria-label="Max Tokens" type="number" min="1" step="1" .value=${this.form.max_tokens !== undefined ? String(this.form.max_tokens) : ''}
            @input=${(e: Event) => { this.form = { ...this.form, max_tokens: Number((e.target as HTMLInputElement).value) }; }} />
        </app-form-field>
      </div>
      ${this.form.models.find(m => m.id === this.form.default_model)?.maxTokens ? html`<p class="form-hint">模型最大输出：${this.form.models.find(m => m.id === this.form.default_model)!.maxTokens} tokens · 参数来源：${({ api: '供应商 API', catalog: '参数目录', manual: '手动配置', unknown: '未知' } as Record<string, string>)[this.form.models.find(m => m.id === this.form.default_model)?.parameterSource || 'manual']}</p>` : ''}

      <!-- Models -->
      <div style="margin-top:var(--space-xs);padding-top:var(--space-lg);border-top:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-sm)">
          <div class="form-section-title" style="margin-bottom:0">模型列表</div>
          <button class="btn" style="font-size:var(--text-xs);padding:var(--space-xs) var(--space-md)" @click=${this._addModel}>+ 添加模型</button>
        </div>
        ${this.form.models.length === 0 ? html`
          <div style="padding:var(--space-lg);text-align:center;color:var(--muted);font-size:var(--text-sm);border:1px dashed var(--border);border-radius:var(--radius-sm)">
            暂无模型 · 默认模型字段已指定基础模型，此处可配置更多
          </div>
        ` : this.form.models.map((m, i) => html`
          <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-md);margin-bottom:var(--space-sm);background:var(--card)">
            <div style="display:flex;gap:var(--space-sm);align-items:center;margin-bottom:var(--space-sm)">
              <div class="form-group" style="flex:1;margin-bottom:0">
                <label class="form-label" style="font-size:10px">模型 ID</label>
                <input class="form-input" style="font-size:var(--text-sm);padding:var(--space-xs) var(--space-sm);font-family:var(--font-mono,monospace)"
                  .value=${m.id} @input=${(e: any) => this._updateModel(i, { id: e.target.value })}
                  placeholder="claude-sonnet-4-6" />
              </div>
              <div class="form-group" style="flex:1;margin-bottom:0">
                <label class="form-label" style="font-size:10px">显示名称</label>
                <input class="form-input" style="font-size:var(--text-sm);padding:var(--space-xs) var(--space-sm)"
                  .value=${m.name || ""} @input=${(e: any) => this._updateModel(i, { name: e.target.value || undefined })}
                  placeholder="Claude Sonnet 4.6" />
              </div>
              <button class="model-remove-btn" @click=${() => this._removeModel(i)} title="删除此模型">
                ${icons['trash-2']}
              </button>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap: var(--space-sm)">
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" style="font-size:10px">Context Window</label>
                <input class="form-input" style="font-size:var(--text-sm);padding:var(--space-xs) var(--space-sm)" type="number"
                  .value=${m.contextWindow !== undefined ? String(m.contextWindow) : ""}
                  @input=${(e: any) => this._updateModel(i, { contextWindow: e.target.value ? parseInt(e.target.value) : undefined })}
                  placeholder="200000" />
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" style="font-size:10px">最大输出限制</label>
                <input class="form-input" style="font-size:var(--text-sm);padding:var(--space-xs) var(--space-sm)" type="number"
                  .value=${m.maxTokens !== undefined ? String(m.maxTokens) : ""}
                  @input=${(e: any) => this._updateModel(i, { maxTokens: e.target.value ? parseInt(e.target.value) : undefined })}
                  placeholder="16384" />
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" style="font-size:10px">Cost Input ($/1M)</label>
                <input class="form-input" style="font-size:var(--text-sm);padding:var(--space-xs) var(--space-sm)" type="number" step="0.01"
                  .value=${m.cost?.input !== undefined ? String(m.cost.input) : ""}
                  @input=${(e: any) => this._updateModel(i, { cost: { ...m.cost, input: e.target.value ? parseFloat(e.target.value) : undefined } })}
                  placeholder="3.00" />
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" style="font-size:10px">Cost Output ($/1M)</label>
                <input class="form-input" style="font-size:var(--text-sm);padding:var(--space-xs) var(--space-sm)" type="number" step="0.01"
                  .value=${m.cost?.output !== undefined ? String(m.cost.output) : ""}
                  @input=${(e: any) => this._updateModel(i, { cost: { ...m.cost, output: e.target.value ? parseFloat(e.target.value) : undefined } })}
                  placeholder="15.00" />
              </div>
            </div>
          </div>
        `)}
      </div>

      <app-form-field label="工具调用能力" hint="仅在提供商及所用模型支持工具调用时启用；智能对话和后台分析需要此能力。">
        <input type="checkbox" aria-label="支持工具调用" .checked=${Boolean(this.form.supports_function_call)}
          @change=${(e: Event) => this._setSelectedParameters({ supports_function_call: (e.target as HTMLInputElement).checked })} />
      </app-form-field>
      <!-- Provider info bar -->
      ${isEdit ? html`
        <div class="toggle-row">
          <div class="toggle-item" @click=${() => this._toggle(this.editing!)}>
            <div class="toggle-switch ${this.editing!.enabled ? 'on' : ''}"></div>
            <span>${this.editing!.enabled ? '已启用' : '已禁用'}</span>
          </div>
          ${this.editing!.is_default ? html`
            <span style="font-size:var(--text-xs);color:var(--accent-text);font-weight:500">★ 默认提供商</span>
          ` : html`
            <button class="btn" style="font-size:var(--text-xs);padding:var(--space-xs) var(--space-md)" @click=${() => this._setDefault(this.editing!)}>设为默认</button>
          `}
        </div>
      ` : ''}

      ${this.formMsg ? html`<div class="msg msg-err">${this.formMsg}</div>` : ''}

      <div class="actions-bar">
        ${isEdit ? html`
          <button class="btn" @click=${() => this._test(this.editing!)} .disabled=${this.testing}>
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
          ${this.savedOk ? html`<span style="font-size:11px">✓ 已保存</span>` : this.saving ? '保存中...' : '保存'}
        </button>
      </div>
      ${isEdit ? html`
        <div role="status" aria-live="polite" aria-atomic="true" aria-label="连接测试结果">
          ${this.testing || this.testResult ? html`
            <app-notice severity=${this.testResult?.startsWith('❌') ? 'error' : 'info'}>
              ${this.testing ? '正在测试连接…' : this.testResult}
            </app-notice>` : ''}
        </div>` : ''}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "llm-config-page": LLMConfigPage; } }
