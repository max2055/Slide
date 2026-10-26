import "../components/app-card.js";
import "../components/app-form-field.js";
import "../components/app-notice.js";
import "../components/app-dialog.js";
import "../components/app-badge.js";
import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
/**
 * LLM 配置管理 — 提供商选择栏 + 按任务分组的连接、模型与高级参数
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

/** Provider mutations persist first and reach the runtime second; both outcomes must stay visible. */
interface LLMConfigMutationResult { success?: boolean; error?: string; applied?: boolean; reloadError?: string }
interface ApplyWarning { message: string; retry?: () => void }

const APPLY_ERROR_REASONS: Record<string, string> = {
  LLM_CONFIGURATION_UNAVAILABLE: '运行时未能建立可用的模型客户端，请检查凭据和模型配置；运行时继续使用上一份可用配置。',
};

function blankForm(): FormData {
  return { name: "", display_name: "", api_base_url: "", default_model: "", deployment_type: "api", api_format: "", api_key: "", enabled: true, is_default: false, models: [] };
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
  @state() private applyWarning: ApplyWarning | null = null;
  @state() private showKey = false;
  @state() private modelSuggestions: string[] = [];
  @state() private modelsLoading = false;
  @state() private modelsMessage = '';
  @state() private modelDraft: ModelConfig | null = null;
  @state() private modelIndex = -1;
  @state() private modelError = '';
  @state() private modelSaving = false;
  @state() private modelFeedback = '';
  @state() private discardOpen = false;
  @state() private advancedOpen = false;
  private pendingNavigation: (() => void) | null = null;
  private savedForm = '';
  private _modelRequestVersion = 0;
  private _testRequestVersion = 0;
  private _savedOkTimer: ReturnType<typeof setTimeout> | null = null;
  static styles = [sharedFieldStyles, sharedBtnStyles, css`

    :host { display: block; min-width: 0; container-type: inline-size; }
    .page { max-width: 1120px; margin: 0 auto; }
    .shell { min-width: 0; }
    .page-header { margin-bottom: var(--space-lg); }
    .page-header h1 { font-size: calc(var(--text-lg) * 1.5); font-weight: 600; margin: 0 0 var(--space-xs); color: var(--text-strong); }
    .page-header p { font-size: var(--text-md); color: var(--muted); margin: 0; line-height: 1.6; }
    .provider-selector { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm) var(--space-md); margin-bottom: var(--space-lg); }
    .provider-selector label { font-size: var(--text-md); font-weight: 500; color: var(--text); }
    .provider-selector select { flex: 1; min-width: 0; max-width: 32rem; }
    .provider-selector .btn { flex-shrink: 0; }
    .provider-count { font-size: var(--text-sm); color: var(--muted); }
    .detail, .detail-inner { min-width: 0; }
    .config-section { padding: var(--space-lg) 0; border-bottom: 1px solid var(--border); }
    .config-section:first-child { padding-top: 0; }
    .section-intro { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--space-xs) var(--space-md); margin-bottom: var(--space-md); }
    .section-intro h2 { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--text-strong); }
    .section-intro p, .scope-hint { margin: 0; font-size: var(--text-sm); line-height: 1.6; color: var(--muted); }
    .connection-identity { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-md); }
    .connection-identity > .form-group { min-width: 0; margin-bottom: 0; }
    .connection-hint { margin: var(--space-xs) 0 var(--space-md); }
    @container (max-width: 620px) {
      .connection-identity { grid-template-columns: minmax(0, 1fr); }
      .provider-selector select { flex-basis: calc(100% - 5rem); }
      .provider-count { margin-right: auto; }
    }
    .section-body { min-width: 0; }
    .section-body .form-row > * { min-width: 0; }
    .section-body .form-label, .section-body .form-input, .section-body .form-select { font-size: var(--text-md); }
    .model-toolbar, .model-row, .dialog-actions { display: flex; align-items: center; gap: var(--space-sm); }
    .model-toolbar { flex-wrap: wrap; margin-bottom: var(--space-xs); }
    .model-toolbar h2 { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--text-strong); }
    .model-toolbar .scope-hint { flex: 1 1 16rem; min-width: min(100%, 16rem); overflow-wrap: anywhere; }
    .model-toolbar-actions { display: flex; flex-wrap: wrap; gap: var(--space-sm); max-width: 100%; }
    .model-toolbar-actions .btn { flex-shrink: 0; }
    .connection-card::part(header), .connection-card::part(footer) { display: none; }
    .model-row { justify-content: space-between; padding: var(--space-md) 0; border-bottom: 1px solid var(--border); }
    .model-row:last-child { border-bottom: 0; }
    .model-summary { min-width: 0; }
    .model-summary strong { font-size: var(--text-md); color: var(--text-strong); overflow-wrap: anywhere; }
    .model-summary p { margin: var(--space-xs) 0 0; font-size: var(--text-sm); line-height: 1.6; color: var(--muted); overflow-wrap: anywhere; }
    .model-row .btn { flex-shrink: 0; }
    .model-list { max-height: 26rem; overflow-y: auto; scrollbar-gutter: stable; }
    .advanced summary, .model-advanced summary { cursor: pointer; font-size: var(--text-md); color: var(--text); padding: var(--space-xs) 0; }
    .advanced-body { padding-top: var(--space-lg); }
    .model-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-md); margin: var(--space-lg) 0; }
    .model-fields app-form-field { min-width: 0; margin: 0; }
    .raw-parameters { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-sm); }
    .model-feedback { font-size: var(--text-sm); color: var(--muted); }
    @media (max-width: 600px) {
      .model-fields { grid-template-columns: minmax(0, 1fr); }
      .form-row { flex-direction: column; gap: 0; }
      .actions-bar { flex-wrap: wrap; }
      .dialog-actions { flex-wrap: wrap; justify-content: end; }
    }

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
    .actions-bar { display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: center; margin-top: var(--space-lg); padding-top: var(--space-md); border-top: 1px solid var(--border); }
    .actions-bar .spacer { flex: 1; }

    /* Status toggle */
    .toggle-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-md); margin: var(--space-md) 0; }
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
          if (this.savedForm) {
            const saved = JSON.parse(this.savedForm) as FormData;
            this.savedForm = JSON.stringify({ ...saved, enabled: fresh.enabled, is_default: fresh.is_default });
          }
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

  private get connectionDirty() { return this.viewMode === 'form' && JSON.stringify(this.form) !== this.savedForm; }

  private _navigate(action: () => void) {
    if (this.saving || this.modelSaving) return;
    if (this.connectionDirty) { this.pendingNavigation = action; this.discardOpen = true; }
    else action();
  }

  _selectProvider(p: LLMProvider) {
    this.modelDraft = null;
    this.modelFeedback = '';
    this.savedOk = false;
    this.applyWarning = null;
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
    this.savedForm = JSON.stringify(this.form);
  }

  _openAddPicker() {
    this.modelDraft = null;
    this.modelFeedback = '';
    this.savedOk = false;
    this.applyWarning = null;
    this._resetDiscovery();
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

  /**
   * Persistence and runtime application are separate outcomes. Only code-shaped
   * reload signals are shown; free-form server text could carry provider credentials.
   */
  private _reportApplyOutcome(savedLabel: string, result: LLMConfigMutationResult, retry?: () => void): boolean {
    const code = typeof result.reloadError === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.reloadError) ? result.reloadError : null;
    if (result.applied !== false) return false;
    this.applyWarning = {
      message: `${savedLabel}，但尚未应用到运行时。${(code && APPLY_ERROR_REASONS[code]) || '运行时未能确认应用结果。'}${code ? `（${code}）` : ''}`,
      retry,
    };
    return true;
  }

  private async _save() {
    if (this.saving || this.modelSaving) return;
    this.saving = true; this.formMsg = null; this.savedOk = false; this.applyWarning = null;
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
        displayName: this.form.display_name,
        deploymentType: this.form.deployment_type,
        apiFormat: this.form.api_format,
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
      const result = this.editing
        ? await apiClient.put<LLMConfigMutationResult>(`/llm/configs/${this.editing.id}`, body)
        : await apiClient.post<LLMConfigMutationResult>("/llm/configs", body);
      if (result?.success === false) throw new Error(result.error || '保存失败');
      this.form = { ...this.form, api_key: '', models };
      this.savedForm = JSON.stringify(this.form);
      this._resetTest();
      const unapplied = this._reportApplyOutcome('配置已保存', result ?? {}, () => this._save());
      if (this._savedOkTimer) clearTimeout(this._savedOkTimer);
      this.savedOk = !unapplied;
      if (!unapplied) this._savedOkTimer = setTimeout(() => { this.savedOk = false; }, 2500);
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
      this.applyWarning = null;
      const result = await apiClient.post<LLMConfigMutationResult>(`/llm/configs/${p.id}/toggle`);
      if (result?.success === false) throw new Error(result.error || "操作失败");
      await this._load(true);
      // 刷新 editing 引用，否则 toggle 开关显示旧状态
      if (this.editing && this.editing.id === p.id) {
        const fresh = this.providers.find(prov => prov.id === p.id);
        if (fresh) {
          this.editing = fresh;
          this.form = { ...this.form, enabled: fresh.enabled, is_default: fresh.is_default };
        }
      }
      // Re-toggling would invert the persisted state, so retry stays on the next save.
      this._reportApplyOutcome('启用状态已保存', result ?? {});
    } catch (e: any) { this.formMsg = e.message || "操作失败"; }
  }

  private async _setDefault(p: LLMProvider) {
    try {
      this.applyWarning = null;
      const result = await apiClient.post<LLMConfigMutationResult>(`/llm/configs/${p.id}/default`);
      if (result?.success === false) throw new Error(result.error || "操作失败");
      await this._load(true);
      // 刷新 editing 引用以保持 UI 同步
      if (this.editing && this.editing.id === p.id) {
        const fresh = this.providers.find(prov => prov.id === p.id);
        if (fresh) {
          this.editing = fresh;
          this.form = { ...this.form, enabled: fresh.enabled, is_default: fresh.is_default };
        }
      }
      this._reportApplyOutcome('默认提供商已保存', result ?? {}, () => this._setDefault(p));
    } catch (e: any) { this.formMsg = e.message || "操作失败"; }
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

  _addModel() { this._editModel(-1); }

  private _editModel(index: number) {
    this.modelIndex = index;
    this.modelDraft = index < 0 ? { id: '' } : structuredClone(this.form.models[index]);
    this.modelError = '';
  }

  private _patchModel(patch: Partial<ModelConfig>) {
    this.modelDraft = { ...this.modelDraft!, ...patch, ...(Object.keys(patch).some(key => ['contextWindow', 'maxTokens', 'supportsFunctionCall', 'supportsVision'].includes(key)) ? { parameterSource: 'manual' as const } : {}) };
  }

  private async _saveModel() {
    if (!this.modelDraft || this.modelSaving) return;
    this.modelError = '';
    const model = { ...this.modelDraft, id: this.modelDraft.id.trim() };
    const original = this.form.models[this.modelIndex];
    try {
      if (!model.id) throw new Error('请填写模型 ID。');
      if (this.form.models.some((m, i) => i !== this.modelIndex && m.id === model.id)) throw new Error('模型 ID 已存在，请使用不同 ID。');
      for (const [label, value, min] of [['上下文窗口', model.contextWindow, 1026], ['最大输出限制', model.maxTokens, 1]] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < min)) throw new Error(`${label}必须为不小于 ${min} 的整数。`);
      }
      for (const price of [model.cost?.input, model.cost?.output]) {
        if (price !== undefined && (!Number.isFinite(price) || price < 0)) throw new Error('价格必须为不小于 0 的数值；未知时留空。');
      }
      const apply = (models: ModelConfig[]) => {
        const index = original ? models.findIndex(m => m.id === original.id) : -1;
        return index < 0 ? [...models, model] : models.map((m, i) => i === index ? model : m);
      };
      if (this.editing) {
        this.modelSaving = true;
        const models = apply(this.editing.models_supported || []);
        const body: Record<string, unknown> = { modelsSupported: models };
        const isDefault = original?.id === this.editing.default_model || model.id === this.editing.default_model;
        if (isDefault) {
          const window = model.contextWindow ?? this.editing.context_window;
          const output = this.editing.max_tokens ?? 4096;
          if (window !== undefined && output + 1024 >= window || model.maxTokens !== undefined && output > model.maxTokens) {
            throw new Error('模型限制小于当前每次请求输出预留，请先在连接高级项调整 Max Tokens 并保存配置。');
          }
          body.model = model.id;
          if (model.contextWindow !== undefined) body.contextWindow = model.contextWindow;
          if (model.supportsFunctionCall !== undefined) body.supportsFunctionCall = model.supportsFunctionCall;
          if (model.supportsVision !== undefined) body.supportsVision = model.supportsVision;
        }
        const result = await apiClient.put<{ success: boolean; error?: string }>(`/llm/configs/${this.editing.id}`, body);
        if (result?.success === false) throw new Error(result.error || '保存模型失败');
        const fresh = { ...this.editing, models_supported: models, ...(isDefault ? {
          default_model: model.id, context_window: model.contextWindow ?? this.editing.context_window,
          supports_function_call: model.supportsFunctionCall ?? this.editing.supports_function_call,
          supports_vision: model.supportsVision ?? this.editing.supports_vision,
        } : {}) };
        this.editing = fresh;
        this.providers = this.providers.map(p => p.id === fresh.id ? fresh : p);
        // Advance only the model portion of the saved snapshot; preserve unsaved connection fields.
        const saved = JSON.parse(this.savedForm) as FormData;
        saved.models = apply(saved.models);
        if (saved.default_model === original?.id) {
          saved.default_model = model.id;
          saved.context_window = model.contextWindow ?? saved.context_window;
          saved.supports_function_call = model.supportsFunctionCall ?? saved.supports_function_call;
          saved.supports_vision = model.supportsVision ?? saved.supports_vision;
        }
        this.savedForm = JSON.stringify(saved);
      }
      this.form = { ...this.form, models: apply(this.form.models) };
      if (this.form.default_model === original?.id) {
        this.form = { ...this.form, default_model: model.id, context_window: model.contextWindow ?? this.form.context_window,
          supports_function_call: model.supportsFunctionCall ?? this.form.supports_function_call,
          supports_vision: model.supportsVision ?? this.form.supports_vision };
      }
      this.modelFeedback = this.editing ? `模型「${model.name || model.id}」已保存；连接草稿未提交。` : '模型已加入待保存配置，请保存配置后生效。';
      this.modelDraft = null;
      this._resetTest();
    } catch (e: any) { this.modelError = e.message || '保存模型失败'; }
    finally { this.modelSaving = false; }
  }

  _removeModel(idx: number) {
    const models = [...this.form.models];
    models.splice(idx, 1);
    this.form = { ...this.form, models };
    this.modelFeedback = '模型移除尚未保存，保存配置后生效；场景引用请在场景分配中核对。';
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
      return html`<div class="loading" role="status" aria-label="正在读取模型配置" style="flex-direction:column;gap:16px;padding:var(--space-xl);">
        <div class="skeleton-block" style="width:200px;height:24px;"></div>
        <div class="skeleton-block" style="width:100%;height:200px;"></div>
        <div class="skeleton-line skeleton-line--long"></div>
      </div>`;
    }
    if (this.error) {
      return html`<app-notice severity="error"><div role="alert">${this.error}</div><button class="btn" @click=${() => this._load()}>重新读取</button></app-notice>`;
    }

    return html`
      <div class="page">
        <div class="page-header">
          <h1>${this.activeTab === 'scenes' ? '场景分配' : '模型配置'}</h1>
          <p>${this.activeTab === 'scenes' ? '为不同场景分配提供商和模型，未单独分配时跟随全局默认' : '先配置连接，再管理模型与高级参数'}</p>
        </div>
        <div class="shell ${this.activeTab === 'scenes' ? 'scenes' : ''}">
          ${this.activeTab === "scenes" ? "" : this._renderSidebar()}
          ${this._renderDetail()}
        </div>
      </div>
      ${this._renderModelDialog()}
      <app-dialog .open=${this.discardOpen} title="放弃未保存修改？" size="sm" @app-dialog-close=${() => { this.discardOpen = false; this.pendingNavigation = null; }}>
        <p>当前连接配置有未保存修改，离开后将丢弃。</p>
        <div slot="footer" class="dialog-actions">
          <button class="btn" @click=${() => { this.discardOpen = false; this.pendingNavigation = null; }}>继续编辑</button>
          <button class="btn-primary" @click=${() => { const action = this.pendingNavigation; this.discardOpen = false; this.pendingNavigation = null; action?.(); }}>放弃并离开</button>
        </div>
      </app-dialog>
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
      <div class="provider-selector" ?inert=${this.saving || this.modelSaving}>
        <label for="provider-select">提供商</label>
        <select id="provider-select" class="form-select" .value=${String(this.selectedId ?? '')}
          @change=${(event: Event) => {
            const select = event.target as HTMLSelectElement;
            const provider = this.providers.find(p => p.id === Number(select.value));
            // Keep the committed selection while the discard dialog is pending.
            select.value = String(this.selectedId ?? '');
            if (provider) this._navigate(() => this._selectProvider(provider));
          }}>
          <option value="" .selected=${this.selectedId === null} disabled>${this.providers.length ? '选择提供商' : '尚无提供商'}</option>
          ${this.providers.map(p => html`<option value=${String(p.id)} .selected=${this.selectedId === p.id}>
            ${p.display_name || p.name}${p.is_default ? ' · 默认' : ''}${p.enabled ? '' : ' · 已禁用'}
          </option>`)}
        </select>
        <span class="provider-count">共 ${this.providers.length} 个</span>
        ${this.viewMode === 'form' ? html`<app-badge variant=${this.connectionDirty ? 'warning' : 'muted'}>${this.connectionDirty ? '未保存修改' : this.editing ? '已保存配置' : '新建配置'}</app-badge>` : ''}
        <button class="btn add-btn" @click=${() => this._navigate(() => this._openAddPicker())}>+ 添加提供商</button>
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
      return html`<div class="detail"><div class="detail-inner" ?inert=${this.saving || this.modelSaving} @input=${() => { this._resetTest(); this.requestUpdate(); }} @change=${() => { this._resetTest(); this.requestUpdate(); }}>${this._renderForm()}</div></div>`;
    }
    // placeholder
    return html`<div class="detail"><div class="placeholder">
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M20 9h3"/><path d="M20 14h3"/><path d="M1 9h3"/><path d="M1 14h3"/></svg>
      <p>${this.providers.length === 0 ? '选择下方模板快速配置 AI 提供商' : '选择一个提供商查看详情'}</p>
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
    return html`
      <app-card class="connection-card">
        <section class="config-section">
          <div class="section-intro"><h2>基础连接</h2><p>先配置供应商，再管理模型与高级参数。</p></div>
          <div class="section-body">
      <div class="connection-identity">
        <div class="form-group">
          <label class="form-label" for="provider-name">标识名 ${!isEdit ? html`<span style="color:var(--danger)">*</span>` : ''}</label>
          <input id="provider-name" class="form-input" .value=${this.form.name} @input=${(e: any) => this.form.name = e.target.value} placeholder="anthropic" ?disabled=${isEdit} style="font-family:var(--font-mono,monospace)" />
        </div>
        <div class="form-group">
          <label class="form-label" for="provider-display">显示名称</label>
          <input id="provider-display" class="form-input" .value=${this.form.display_name} @input=${(e: any) => this.form.display_name = e.target.value} placeholder="Anthropic Claude" />
        </div>

      <div class="form-group">
        <label class="form-label" for="api-format">API 兼容格式</label>
        <select id="api-format" class="form-select" .value=${this.form.api_format} @change=${(e: any) => this.form.api_format = e.target.value}>
          ${API_FORMATS.map(f => html`<option value=${f.value} .selected=${f.value === this.form.api_format}>${f.label}</option>`)}
        </select>
      </div>
      </div>
      <p class="form-hint connection-hint">自定义提供商需指定 API 格式，预置模板可自动检测</p>

            <app-form-field label="Base URL"><input class="form-input" aria-label="Base URL" .value=${this.form.api_base_url}
              @input=${(e: Event) => { this._resetDiscovery(); this.form = { ...this.form, api_base_url: (e.target as HTMLInputElement).value }; }} /></app-form-field>
      <div class="form-group">
        <label class="form-label" for="provider-key">API Key</label>
        <div class="key-wrapper">
          <input id="provider-key" class="form-input" type=${this.showKey ? "text" : "password"} autocomplete="new-password" .value=${this.form.api_key} @input=${(e: any) => this.form.api_key = e.target.value} placeholder=${isEdit ? "留空不修改" : "sk-..."} style="font-family:var(--font-mono,monospace)" />
          <button class="key-toggle" type="button" @click=${() => { this.showKey = !this.showKey; }} title=${this.showKey ? "隐藏 API Key" : "显示 API Key"}>
            ${this.showKey ? icons['eye-off'] : icons['eye']}
          </button>
        </div>
        <span class="form-hint">Key 将加密存储到数据库${isEdit ? ' · 留空则不修改' : ''}</span>
      </div>


          </div>
        </section>
        <section class="config-section">
          <div class="section-body">
            <div class="model-toolbar"><h2>模型清单</h2><span class="scope-hint">${this.form.models.length} 个模型 · 默认 ${this.form.default_model || '未选择'}</span>
              <div class="model-toolbar-actions">
              <button class="btn" data-testid="load-models" .disabled=${this.modelsLoading || !this.form.name.trim() || !this.form.api_base_url.trim()}
                @click=${this._fetchModels}>${this.modelsLoading ? '加载中…' : '加载模型'}</button>
              <button class="btn" @click=${this._addModel}>+ 添加模型</button>
              </div>
            </div>
            ${this.modelsMessage ? html`<p class="form-hint" role="status" aria-live="polite">${this.modelsMessage}</p>` : ''}
            <div class="model-list" aria-label="模型清单">
              ${this.form.models.length ? this.form.models.map((m, i) => html`
                <div class="model-row"><div class="model-summary"><strong>${m.name || m.id}</strong>
                  ${m.id === this.form.default_model ? html`<app-badge variant="muted">默认</app-badge>` : ''}
                  <p>${m.id} · 上下文 ${m.contextWindow === undefined ? '未知' : m.contextWindow.toLocaleString()} · 价格与能力见编辑</p>
                </div><button class="btn" @click=${() => this._editModel(i)} aria-label=${`编辑模型 ${m.name || m.id}`}>编辑</button></div>
              `) : html`<p class="scope-hint">尚无模型清单。可加载模型或手动添加；默认模型也可在连接高级项配置。</p>`}
            </div>
            <p class="scope-hint">加载与移除后需保存配置；编辑仅保存当前模型。</p>
            ${this.modelFeedback ? html`<p class="model-feedback" role="status">${this.modelFeedback}</p>` : ''}
          </div>
        </section>
        <section class="config-section">
          <div class="section-intro"><h2>连接高级项</h2><p>保留默认模型、输出预留与兼容参数，按需调整。</p></div>
          <div class="section-body"><details class="advanced" .open=${this.advancedOpen || !!this.formMsg && /上下文|Max Tokens/.test(this.formMsg)} @toggle=${(e: Event) => { this.advancedOpen = (e.target as HTMLDetailsElement).open; }}><summary>默认模型、输出与兼容参数</summary><div class="advanced-body">
      <div class="form-group">
        <label class="form-label" for="deployment">部署类型</label>
        <select id="deployment" class="form-select" .value=${this.form.deployment_type} @change=${(e: any) => this.form.deployment_type = e.target.value}>
          ${DEPLOY_TYPES.map(d => html`<option value=${d.value} .selected=${d.value === this.form.deployment_type}>${d.label}</option>`)}
        </select>
      </div>

        <app-form-field label="供应商参数目录" hint="自动识别官方地址；自定义代理可指定供应商。">
          <select class="form-select" aria-label="供应商参数目录" .value=${this.form.provider_type || ''}
            @change=${(e: Event) => { this._resetDiscovery(); this.form = { ...this.form, provider_type: (e.target as HTMLSelectElement).value }; }}>
            <option value="">自动识别 / 其他</option><option value="deepseek">DeepSeek</option><option value="stepfun">StepFun 阶跃星辰</option><option value="mimo">Xiaomi MiMo</option>
          </select>
        </app-form-field>
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

      <app-form-field label="工具调用能力" hint="仅在提供商及所用模型支持工具调用时启用；智能对话和后台分析需要此能力。">
        <input type="checkbox" aria-label="支持工具调用" .checked=${Boolean(this.form.supports_function_call)}
          @change=${(e: Event) => this._setSelectedParameters({ supports_function_call: (e.target as HTMLInputElement).checked })} />
      </app-form-field>

            <app-form-field label="视觉能力"><input type="checkbox" aria-label="支持视觉" .checked=${Boolean(this.form.supports_vision)}
              @change=${(e: Event) => this._setSelectedParameters({ supports_vision: (e.target as HTMLInputElement).checked })} /></app-form-field>
          </div></details></div>
        </section>
        <p class="scope-hint">保存配置会提交此连接的基础项、默认模型、高级项与待保存模型清单。启停、设为默认和删除即时生效。</p>
      <!-- Provider info bar -->
      ${isEdit ? html`
        <div class="toggle-row">
          <button class="btn" @click=${() => this._toggle(this.editing!)}>
            <div class="toggle-switch ${this.editing!.enabled ? 'on' : ''}"></div>
            <span>${this.editing!.enabled ? '已启用' : '已禁用'}</span>
          </button>
          ${this.editing!.is_default ? html`
            <span style="font-size:var(--text-xs);color:var(--accent-text);font-weight:500">★ 默认提供商</span>
          ` : html`
            <button class="btn" style="font-size:var(--text-xs);padding:var(--space-xs) var(--space-md)" @click=${() => this._setDefault(this.editing!)}>设为默认</button>
          `}
        </div>
      ` : ''}

      ${this.applyWarning ? html`
        <div role="alert" aria-label="运行时应用结果">
          <app-notice severity="warning">
            <span>${this.applyWarning.message}</span>
            ${this.applyWarning.retry ? html`<button class="btn btn-sm" style="margin-inline-start:var(--space-md)" @click=${() => this.applyWarning?.retry?.()}>重试应用</button>` : ''}
          </app-notice>
        </div>` : ''}

      ${this.formMsg ? html`<div class="msg msg-err" role="alert">${this.formMsg}</div>` : ''}

      <div class="actions-bar">
        ${isEdit ? html`
          <button class="btn" @click=${() => this._test(this.editing!)} .disabled=${this.testing}>
            ${this.testing ? '测试中...' : '测试连接'}
          </button>
        ` : ''}
        <span class="spacer"></span>
        ${isEdit ? html`
          <button class="btn" @click=${() => this._delete(this.editing!)}>删除</button>
        ` : html`
          <button class="btn" @click=${() => { this._navigate(() => this._openAddPicker()); }}>返回模板</button>
        `}
        <button class="btn-primary ${this.savedOk ? 'btn-success' : ''}" @click=${this._save} ?disabled=${this.saving || this.modelSaving || !this.form.name}>
          ${this.savedOk ? '✓ 已保存配置' : this.saving ? '保存中...' : '保存配置'}
        </button>
      </div>
      ${isEdit ? html`
        <div role="status" aria-live="polite" aria-atomic="true" aria-label="连接测试结果">
          ${this.testing || this.testResult ? html`
            <app-notice severity=${this.testResult?.startsWith('❌') ? 'error' : 'info'}>
              ${this.testing ? '正在测试连接…' : this.testResult}
            </app-notice>` : ''}
        </div>` : ''}

      </app-card>
    `;
  }

  private _renderModelDialog() {
    const m = this.modelDraft;
    const numberField = (label: string, value: number | undefined, update: (n: number | undefined) => void, min = 0, step = '1') => html`
      <app-form-field label=${label} hint="留空表示未知"><input class="form-input" aria-label=${label} type="number" min=${min} step=${step}
        .value=${value === undefined ? '' : String(value)} @input=${(e: Event) => { const value = (e.target as HTMLInputElement).value; update(value === '' ? undefined : Number(value)); }} /></app-form-field>`;
    const capability = (label: string, key: 'supportsFunctionCall' | 'supportsVision') => html`
      <app-form-field label=${label}><select class="form-select" aria-label=${label} .value=${m?.[key] === undefined ? '' : String(m[key])}
        @change=${(e: Event) => { const value = (e.target as HTMLSelectElement).value; this._patchModel({ [key]: value === '' ? undefined : value === 'true' }); }}>
        <option value="" .selected=${m?.[key] === undefined}>未知</option><option value="true" .selected=${m?.[key] === true}>支持</option><option value="false" .selected=${m?.[key] === false}>不支持</option></select></app-form-field>`;
    return html`<app-dialog .open=${!!m} title="编辑模型" size="lg" .closable=${!this.modelSaving} .closeOnOverlay=${false}
      @app-dialog-close=${() => { this.modelDraft = null; }}>
      ${m ? html`
        <p class="scope-hint">${this.editing ? '保存仅更新当前模型及其默认参数，不提交连接草稿。' : '新连接：应用后仍需保存配置。'}取消或 Esc 放弃本次编辑。</p>
        <fieldset ?disabled=${this.modelSaving} style="border:0;padding:0;margin:0;min-width:0">
        <div class="model-fields">
          <app-form-field label="模型 ID"><input class="form-input" aria-label="模型 ID" .value=${m.id} @input=${(e: Event) => this._patchModel({ id: (e.target as HTMLInputElement).value })} /></app-form-field>
          <app-form-field label="显示名称"><input class="form-input" aria-label="模型显示名称" .value=${m.name || ''} @input=${(e: Event) => this._patchModel({ name: (e.target as HTMLInputElement).value || undefined })} /></app-form-field>
          ${numberField('模型上下文窗口', m.contextWindow, n => this._patchModel({ contextWindow: n }), 1026)}
          ${numberField('最大输出限制', m.maxTokens, n => this._patchModel({ maxTokens: n }), 1)}
        </div>
        <details class="model-advanced"><summary>计价、能力与参数来源</summary><div class="model-fields">
          ${numberField('输入价格（$/1M tokens）', m.cost?.input, n => this._patchModel({ cost: { ...m.cost, input: n } }), 0, 'any')}
          ${numberField('输出价格（$/1M tokens）', m.cost?.output, n => this._patchModel({ cost: { ...m.cost, output: n } }), 0, 'any')}
          ${capability('模型工具调用能力', 'supportsFunctionCall')}${capability('模型视觉能力', 'supportsVision')}
          <app-form-field label="参数来源"><select class="form-select" aria-label="参数来源" .value=${m.parameterSource || ''}
            @change=${(e: Event) => this._patchModel({ parameterSource: (e.target as HTMLSelectElement).value as ModelConfig['parameterSource'] || undefined })}>
            ${[['', '未标注'], ['unknown', '未知'], ['api', '供应商 API'], ['catalog', '参数目录'], ['manual', '手动配置']].map(([value, label]) => html`<option value=${value} .selected=${(m.parameterSource || '') === value}>${label}</option>`)}</select></app-form-field>
          <app-form-field label="参数供应商"><input class="form-input" aria-label="参数供应商" .value=${m.parameterProvider || ''}
            @input=${(e: Event) => this._patchModel({ parameterProvider: (e.target as HTMLInputElement).value || undefined })} /></app-form-field>
        </div>
        <details><summary>原始参数（包含保留的扩展字段）</summary><pre class="raw-parameters">${JSON.stringify(m, null, 2)}</pre></details>
        </details>
        </fieldset>
        ${this.modelError ? html`<div class="msg msg-err" role="alert">${this.modelError}</div>` : ''}
      ` : ''}
      <div slot="footer" class="dialog-actions">
        ${this.modelIndex >= 0 ? html`<button class="btn" ?disabled=${this.modelSaving} @click=${() => { this._removeModel(this.modelIndex); this.modelDraft = null; }}>从配置中移除（待保存）</button>` : ''}
        <button class="btn" ?disabled=${this.modelSaving} @click=${() => { this.modelDraft = null; }}>取消</button>
        <button class="btn-primary" ?disabled=${this.modelSaving} @click=${this._saveModel}>${this.modelSaving ? '保存中…' : this.editing ? '保存模型' : '应用到待保存配置'}</button>
      </div>
    </app-dialog>`;
  }
}

declare global { interface HTMLElementTagNameMap { "llm-config-page": LLMConfigPage; } }
