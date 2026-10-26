import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.ts';
import type { InvestigationBudgetResponse, InvestigationPoliciesResponse, InvestigationUsageResponse, InvestigationEffectiveBudgetView } from '../../../api/generated/public-api.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { canAccessSettingsItem, settingsBasePath, settingsItemById } from '../settings-navigation.ts';
import { workspaceStyles, fmt, badge, stat, table, pairs } from './workspace-ui.js';
import '../components/app-empty-state.ts';
import '../components/app-form-field.js';
import { showToast } from '../components/app-toast-container.js';

type Kind = 'policies' | 'budget' | 'usage';
type Facts = InvestigationBudgetResponse | InvestigationPoliciesResponse | InvestigationUsageResponse;
type EffectiveBudgetView = InvestigationEffectiveBudgetView;
type EffectiveBudgetDocument = EffectiveBudgetView['effective'];
type AdmissionPolicy = NonNullable<EffectiveBudgetDocument['admission']>['policy'];
type BudgetDraft = EffectiveBudgetDocument['runtime'] & EffectiveBudgetDocument['profileLimits'] & AdmissionPolicy;
type BudgetKey = keyof BudgetDraft;
const RUNTIME_KEYS = ['contextWindowTokens', 'outputTokens', 'summaryOutputTokens', 'maxExecutionTokens'] as const;
const PROFILE_KEYS = ['deadlineMs', 'maxToolCalls', 'maxProviderAttempts', 'maxRows', 'maxBytes', 'maxWindowMs'] as const;
const ADMISSION_KEYS = ['maxConcurrent', 'manualReserved', 'maxPerResourceConcurrent', 'maxAutomaticRequestsPerHour',
  'maxAutomaticTokensPerDay', 'maxTotalTokensPerDay', 'maxCostMicrosPerDay'] as const;
const BUDGET_FIELDS: Array<{ key: BudgetKey; label: string; hint: string; min: number; max: number }> = [
  { key: 'contextWindowTokens', label: '上下文窗口', hint: 'tokens；不得超过 Provider 上下文窗口，且至少比输出/摘要上限大 1024。', min: 1, max: 1_000_000 },
  { key: 'outputTokens', label: '普通输出上限', hint: 'tokens；不得超过 Provider 最大输出。', min: 1, max: 1_000_000 },
  { key: 'summaryOutputTokens', label: '摘要输出上限', hint: 'tokens；上下文压缩摘要使用，不得超过 Provider 最大输出。', min: 1, max: 1_000_000 },
  { key: 'maxExecutionTokens', label: '单次执行 Token 上限', hint: 'tokens；必须 ≥ 上下文窗口，默认等于每日上限。', min: 1, max: 1_000_000 },
  { key: 'deadlineMs', label: '执行 Deadline', hint: '毫秒；默认 600,000（10 分钟）。', min: 1, max: 900_000 },
  { key: 'maxToolCalls', label: '最大工具调用', hint: '默认 36。', min: 1, max: 64 },
  { key: 'maxProviderAttempts', label: '最大 Provider 尝试', hint: '默认 8。', min: 1, max: 16 },
  { key: 'maxRows', label: '最大返回行数', hint: '默认 200。', min: 1, max: 1_000 },
  { key: 'maxBytes', label: '最大工具结果字节', hint: '默认 128,000。', min: 1, max: 1_000_000 },
  { key: 'maxWindowMs', label: '最大查询时间窗', hint: '毫秒；默认 3,600,000（1 小时）。', min: 1, max: 86_400_000 },
  { key: 'maxConcurrent', label: '全局并发', hint: '同时运行的调查数；手动与自动共用。', min: 1, max: 64 },
  { key: 'manualReserved', label: '手动并发保留', hint: '从全局并发中为手动请求保留的槽位，不得超过全局并发。', min: 0, max: 64 },
  { key: 'maxPerResourceConcurrent', label: '每资源并发', hint: '同一资源上同时进行的调查数。', min: 1, max: 64 },
  { key: 'maxAutomaticRequestsPerHour', label: '自动每小时请求', hint: '自动触发每 UTC 小时最多准入的请求数。', min: 1, max: 1_000 },
  { key: 'maxAutomaticTokensPerDay', label: '自动每日 Token 上限', hint: '自动通道每日 Token 上限，不得超过全部每日上限。', min: 1, max: 1_000_000_000 },
  { key: 'maxTotalTokensPerDay', label: '全部每日 Token 上限', hint: '手动与自动合计的每日 Token 上限，且不得低于单次执行上限。', min: 1, max: 1_000_000_000 },
  { key: 'maxCostMicrosPerDay', label: '每日成本上限（micro）', hint: '按配置费率估算的每日成本上限；1,000,000 micro = 1 货币单位。', min: 1, max: 1_000_000_000_000 },
];
const titles = { policies: '调查策略', budget: '有效预算', usage: '用量与成本' };
const stateLabels = { reserved: '未发送保留', sent: '已发送待用量', settled: '已结算', unknown: '结果未知保留', cancelled: '发送前取消' };
type PolicyFacts = InvestigationPoliciesResponse;
type PolicyBlocker = PolicyFacts['blockers'][number];
const identityLabels: Record<PolicyFacts['serviceIdentity']['status'], string> = {
  not_configured: '尚未配置', not_found: '账号不存在', invalid: '不是专用服务身份', disabled: '账号已停用', ready: '已就绪' };
const entryLabels: Record<PolicyFacts['entry']['status'], string> = {
  not_connected: '尚未接入', unverified: '未观察到持久入口证据', connected: '已确认入口接线' };
const receiptStatusLabels: Record<NonNullable<PolicyFacts['receipts']['lastStatus']>, string> = {
  accepted: '已受理', suppressed: '已抑制', pending: '待处理', unknown: '未知' };
const executionLabels: Record<NonNullable<PolicyFacts['execution']['lastStatus']>, string> = {
  accepted: '已受理待执行', running: '执行中', completed: '已完成', failed: '执行失败',
  partial: '部分完成', timed_out: '执行超时', cancelled: '已取消', suppressed: '准入抑制', unknown: '结果未知' };
const admissionReasonLabels: Record<PolicyFacts['budget']['admissionReasons'][number], string> = {
  AUTOMATIC_FREQUENCY: '自动每小时请求已达上限',
  AUTOMATIC_DAILY_TOKENS: '自动每日 Token 余额不足以容纳一次预留',
  TOTAL_DAILY_TOKENS: '全部每日 Token 余额不足以容纳一次预留',
  DAILY_COST: '每日成本余额不足以容纳一次预留',
  GLOBAL_CONCURRENCY: '全局并发当前已满（瞬时）',
  MANUAL_CAPACITY_RESERVED: '自动通道并发当前已满（手动保留容量，瞬时）',
  RESOURCE_CONCURRENCY: '已配置资源并发当前均已满（瞬时）' };
const budgetLabels: Record<PolicyFacts['budget']['status'], string> = {
  uninitialized: '尚未初始化', matching: '与冻结策略一致', conflict: '与冻结策略冲突', unavailable: '预算配置不可用' };
const coverageLabels = { database: '数据库', server: '服务器', network_device: '网络设备' } as const;
const coverageStatusLabels: Record<PolicyFacts['resourceCoverage'][number]['status'], string> = {
  not_configured: '尚未配置', covered: '已覆盖', partial: '部分可用', unavailable: '资源不可用' };
const blockerLabels: Record<PolicyBlocker['code'], string> = {
  MASTER_CONFIG_INVALID: 'AI 总开关配置格式无效，已按关闭处理',
  MASTER_SWITCH_DISABLED: 'AI 总开关已关闭',
  INVESTIGATION_SWITCH_DISABLED: '调查自动开关（部署环境）未开启',
  SERVICE_IDENTITY_NOT_CONFIGURED: '尚未配置专用服务身份',
  SERVICE_IDENTITY_NOT_FOUND: '专用服务身份账号不存在',
  SERVICE_IDENTITY_INVALID: '配置的账号不是专用调查服务身份',
  SERVICE_IDENTITY_DISABLED: '专用服务身份已停用',
  SERVICE_PERMISSIONS_MISSING: '专用服务身份缺少必需权限',
  RESOURCE_SCOPE_NOT_CONFIGURED: '尚未配置资源范围',
  RESOURCE_SCOPE_INVALID: '资源范围配置格式无效',
  RESOURCE_UNAVAILABLE: '已配置的资源不存在或不可用',
  RESOURCE_PERMISSION_MISSING: '专用服务身份缺少该类资源的查看权限',
  RESOURCE_INSTANCE_SCOPE_MISSING: '专用服务身份缺少实例级授权',
  BUDGET_UNAVAILABLE: '预算配置不可用',
  BUDGET_UNINITIALIZED: '预算域尚未初始化，自动准入无法保留额度',
  BUDGET_CONFLICT: '当前配置与冻结预算冲突，不能视为可准入',
  BUDGET_QUOTA_REACHED: '当天额度、频次或成本余额不足以容纳下一次自动预留',
  BUDGET_CAPACITY_REACHED: '当前并发快照没有可用槽位（瞬时事实）',
  ENTRY_NOT_OBSERVED: '尚未观察到持久自动入口证据，不能确认已接线',
};
const remediationLabels: Record<PolicyBlocker['remediation'], string> = {
  analysis_settings: '前往自动分析设置', budget_settings: '前往有效预算', user_permissions: '前往用户与权限',
  deployment_environment: '需由运维调整部署环境', alert_engine: '检查告警引擎运行状态', none: '' };
const remediationPaths: Partial<Record<PolicyBlocker['remediation'], string>> = {
  analysis_settings: '/settings/monitoring/analysis?view=automatic',
  budget_settings: '/settings/ai/budget',
  user_permissions: '/settings/access/users?view=accounts',
};
const masterStatusLabels = { persisted: '已保存配置', defaulted: '未保存，使用默认值', invalid: '配置无效' } as const;
const money = (value: number, currency: string) => `${currency} ${(value / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
const exactMoney = (value: number, currency: string) => `${currency} ${(value / 1_000_000).toFixed(6)}（${value} micro）`;

@customElement('investigation-governance-page')
export class InvestigationGovernancePage extends LitElement {
  @property() kind: Kind = 'policies';
  @property({ attribute: false }) permissions: Set<string> | null = null;
  @state() private facts: Facts | null = null;
  @state() private loading = false;
  @state() private error = '';
  @state() private forbidden = false;
  @state() private offset = 0;
  @state() private limit = 20;
  @state() private dialog: 'policy' | 'ledger' | 'group' | '' = '';
  @state() private group: InvestigationUsageResponse['items'][number] | null = null;
  @state() private budget: EffectiveBudgetView | null = null;
  @state() private draft: BudgetDraft | null = null;
  @state() private budgetLoading = false;
  @state() private budgetSaving = false;
  @state() private budgetError = '';
  @state() private budgetFieldErrors: Partial<Record<BudgetKey, string>> = {};
  private generation = 0;
  private invalidate() {
    this.generation++; this.dialog = ''; this.group = null; this.facts = null; this.loading = false; this.error = ''; this.offset = 0;
    this.budget = null; this.draft = null; this.budgetLoading = false; this.budgetSaving = false; this.budgetError = ''; this.budgetFieldErrors = {};
  }
  private sessionExpired = () => { this.permissions = new Set(); this.invalidate(); this.forbidden = true; };
  private permissionsChanged = (event: Event) => {
    // Erase synchronously, before Lit removes/reuses the page or renders a new permission set.
    this.invalidate();
    const codes = (event as CustomEvent<{ permissions?: string[] }>).detail?.permissions;
    this.permissions = new Set(Array.isArray(codes) ? codes : []);
    this.forbidden = !this.allowed;
  };
  private get allowed() { return canAccessSettingsItem(settingsItemById(this.kind)!, this.permissions); }
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-session-expired', this.sessionExpired);
    window.addEventListener('slide-permissions-loaded', this.permissionsChanged);
  }
  disconnectedCallback() {
    this.invalidate();
    window.removeEventListener('slide-session-expired', this.sessionExpired);
    window.removeEventListener('slide-permissions-loaded', this.permissionsChanged);
    super.disconnectedCallback();
  }
  protected willUpdate(changes: PropertyValues<this>) {
    if (changes.has('kind') || changes.has('permissions')) { this.invalidate(); void this.load(); }
  }
  private async load(offset = 0) {
    this.invalidate(); this.offset = offset; this.forbidden = !this.allowed;
    if (!this.allowed || !this.isConnected) return;
    const generation = this.generation, kind = this.kind;
    this.loading = true;
    try {
      const query = kind === 'usage' ? `?limit=${this.limit}&offset=${offset}` : '';
      const response = await authFetch(`/api/investigation-${kind}${query}`, { cache: 'no-store' });
      if (generation !== this.generation || !this.isConnected) return;
      if (!response.ok) {
        this.forbidden = [401, 403].includes(response.status);
        this.error = response.status === 401 ? '登录已失效，请重新登录。'
          : this.forbidden ? '当前账号无权访问此调查设置。' : '调查设置暂不可用，请稍后重试。';
        return;
      }
      const facts = await response.json() as Facts;
      if (generation === this.generation && this.isConnected && this.kind === kind) {
        this.facts = facts;
        if (kind === 'budget') await this.loadEffective();
      }
    } catch {
      if (generation === this.generation) this.error = '调查设置暂不可用，请检查连接后重试。';
    } finally { if (generation === this.generation) this.loading = false; }
  }
  /** Admission quota is always present in a server-normalized view; legacy
   * rows without it fall back to the reported defaults. */
  private buildDraft(document: EffectiveBudgetDocument, view: EffectiveBudgetView): BudgetDraft | null {
    const policy = document.admission?.policy ?? view.effective.admission?.policy ?? view.defaults.admission?.policy;
    return policy ? { ...document.runtime, ...document.profileLimits, ...policy } : null;
  }
  private async loadEffective() {
    const generation = this.generation, kind = this.kind;
    this.budgetLoading = true; this.budgetError = '';
    try {
      const response = await authFetch('/api/investigation-budget/effective', { cache: 'no-store' });
      if (generation !== this.generation || !this.isConnected || this.kind !== kind) return;
      if (!response.ok) {
        this.budgetError = [401, 403].includes(response.status) ? '当前账号无权读取或修改有效预算。' : '有效预算暂不可用，请稍后重试。';
        return;
      }
      const view = await response.json() as EffectiveBudgetView;
      if (generation !== this.generation || !this.isConnected) return;
      const draft = view && view.schemaVersion === 1 && view.effective?.runtime && view.effective?.profileLimits && view.defaults?.runtime
        ? this.buildDraft(view.effective, view) : null;
      if (!draft) {
        this.budgetError = '有效预算响应不完整，请稍后重试。';
        return;
      }
      this.budget = view;
      this.draft = draft;
    } catch {
      if (generation === this.generation) this.budgetError = '有效预算暂不可用，请检查连接后重试。';
    } finally { if (generation === this.generation) this.budgetLoading = false; }
  }
  private updateBudgetField(key: BudgetKey, event: Event) {
    if (!this.draft) return;
    this.draft = { ...this.draft, [key]: Number((event.target as HTMLInputElement).value) };
    if (this.budgetFieldErrors[key]) {
      const next = { ...this.budgetFieldErrors }; delete next[key]; this.budgetFieldErrors = next;
    }
  }
  private budgetDirty() {
    if (!this.draft || !this.budget) return false;
    const base = this.buildDraft(this.budget.effective, this.budget);
    return !!base && BUDGET_FIELDS.some(field => this.draft![field.key] !== base[field.key]);
  }
  /** A policy edit rotates the ledger domain; runtime/Profile edits do not. */
  private policyDirty() {
    if (!this.draft || !this.budget) return false;
    const base = this.buildDraft(this.budget.effective, this.budget);
    return !!base && ADMISSION_KEYS.some(key => this.draft![key] !== base[key]);
  }
  /** Runtime/Profile edits still require verified provider capacity. */
  private coreDirty() {
    if (!this.draft || !this.budget) return false;
    const base = this.buildDraft(this.budget.effective, this.budget);
    return !!base && [...RUNTIME_KEYS, ...PROFILE_KEYS].some(key => this.draft![key] !== base[key]);
  }
  private restoreBudgetDefaults() {
    if (!this.budget) return;
    const draft = this.buildDraft(this.budget.defaults, this.budget);
    if (!draft) return;
    this.draft = draft;
    this.budgetFieldErrors = {}; this.budgetError = '';
  }
  private validateBudget(): boolean {
    const draft = this.draft, errors: Partial<Record<BudgetKey, string>> = {};
    if (!draft) return false;
    for (const field of BUDGET_FIELDS) {
      const value = draft[field.key];
      if (!Number.isSafeInteger(value) || value < field.min || value > field.max)
        errors[field.key] = `请输入 ${fmt(field.min)}–${fmt(field.max)} 的整数`;
    }
    const provider = this.budget?.provider;
    if (provider) {
      if (!errors.contextWindowTokens && draft.contextWindowTokens > provider.contextWindowTokens)
        errors.contextWindowTokens = `不能超过 Provider 上下文窗口 ${fmt(provider.contextWindowTokens)}`;
      if (provider.maxOutputTokens !== undefined) {
        if (!errors.outputTokens && draft.outputTokens > provider.maxOutputTokens)
          errors.outputTokens = `不能超过 Provider 最大输出 ${fmt(provider.maxOutputTokens)}`;
        if (!errors.summaryOutputTokens && draft.summaryOutputTokens > provider.maxOutputTokens)
          errors.summaryOutputTokens = `不能超过 Provider 最大输出 ${fmt(provider.maxOutputTokens)}`;
      }
    }
    if (!errors.contextWindowTokens && !errors.outputTokens && !errors.summaryOutputTokens
      && draft.contextWindowTokens < Math.max(draft.outputTokens, draft.summaryOutputTokens) + 1024)
      errors.contextWindowTokens = '必须至少比输出/摘要上限大 1024';
    if (!errors.maxExecutionTokens && draft.maxExecutionTokens < draft.contextWindowTokens)
      errors.maxExecutionTokens = '必须 ≥ 上下文窗口';
    if (!errors.manualReserved && !errors.maxConcurrent && draft.manualReserved > draft.maxConcurrent)
      errors.manualReserved = `不能超过全局并发 ${fmt(draft.maxConcurrent)}`;
    if (!errors.maxAutomaticTokensPerDay && !errors.maxTotalTokensPerDay && draft.maxAutomaticTokensPerDay > draft.maxTotalTokensPerDay)
      errors.maxAutomaticTokensPerDay = `不能超过全部每日上限 ${fmt(draft.maxTotalTokensPerDay)}`;
    if (!errors.maxExecutionTokens && !errors.maxTotalTokensPerDay && draft.maxExecutionTokens > draft.maxTotalTokensPerDay)
      errors.maxTotalTokensPerDay = `每日上限不能低于单次执行上限 ${fmt(draft.maxExecutionTokens)}`;
    this.budgetFieldErrors = errors;
    return Object.keys(errors).length === 0;
  }
  private budgetErrorMessage(code: unknown, status: number) {
    if (code === 'INVESTIGATION_BUDGET_CONFLICT') return '配置已被他人修改，请刷新后重试。';
    if (code === 'INVESTIGATION_BUDGET_CAPABILITY_EXCEEDED') return '超出当前 Provider 能力，请调整窗口或输出上限。';
    if (code === 'INVESTIGATION_BUDGET_CAPABILITY_UNAVAILABLE') return '当前 Provider 能力未验证，暂不能保存。';
    if (code === 'INVESTIGATION_BUDGET_POLICY_INVALID') return '准入策略冲突：手动保留不能超过全局并发，自动与单次执行上限不能超过每日总量。';
    if (code === 'INVESTIGATION_BUDGET_CONFIGURATION_INVALID') return '配置值不合法，请检查标红字段。';
    return [401, 403].includes(status) ? '当前账号无权保存此设置。' : '保存失败，请稍后重试。';
  }
  private async saveBudget() {
    if (!this.budget || !this.draft || this.budgetSaving) return;
    this.budgetError = '';
    if (!this.validateBudget()) { this.budgetError = '请修正标红字段后再保存。'; return; }
    this.budgetSaving = true;
    try {
      const draft = this.draft, rotates = this.policyDirty();
      const response = await authFetch('/api/investigation-budget/effective', { method: 'PUT',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          expectedVersion: this.budget.effective.version,
          runtime: { contextWindowTokens: draft.contextWindowTokens, outputTokens: draft.outputTokens,
            summaryOutputTokens: draft.summaryOutputTokens, maxExecutionTokens: draft.maxExecutionTokens },
          profileLimits: { deadlineMs: draft.deadlineMs, maxToolCalls: draft.maxToolCalls,
            maxProviderAttempts: draft.maxProviderAttempts, maxRows: draft.maxRows, maxBytes: draft.maxBytes, maxWindowMs: draft.maxWindowMs },
          admissionPolicy: { maxConcurrent: draft.maxConcurrent, manualReserved: draft.manualReserved,
            maxPerResourceConcurrent: draft.maxPerResourceConcurrent, maxAutomaticRequestsPerHour: draft.maxAutomaticRequestsPerHour,
            maxAutomaticTokensPerDay: draft.maxAutomaticTokensPerDay, maxTotalTokensPerDay: draft.maxTotalTokensPerDay,
            maxCostMicrosPerDay: draft.maxCostMicrosPerDay },
        }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { this.budgetError = this.budgetErrorMessage(body?.error, response.status); return; }
      const view = body as EffectiveBudgetView, next = this.buildDraft(view.effective, view);
      if (!next) { this.budgetError = '有效预算响应不完整，请重新加载。'; return; }
      this.budget = view; this.draft = next;
      this.budgetFieldErrors = {};
      showToast(rotates ? `准入策略已保存，新执行将使用账本域 ${view.admission.domain}` : '有效预算已保存，新执行将使用该分配', 'success');
    } catch { this.budgetError = '保存失败，请检查连接后重试。'; }
    finally { this.budgetSaving = false; }
  }
  private renderBudgetEditor() {
    if (!this.budget) return html`<div class="section-head"><h2>有效预算（可编辑）</h2><span class="caption">${this.budgetLoading ? '正在加载…' : ''}</span></div>
      ${this.budgetError ? html`<div class="notice" role="alert"><div>${this.budgetError}</div></div>` : nothing}`;
    const budget = this.budget, provider = budget.provider, dirty = this.budgetDirty();
    const rotates = this.policyDirty();
    const blocked = !budget.capabilityVerified && this.coreDirty();
    return html`<div class="section-head"><div><h2>有效预算（可编辑）</h2><p class="caption">保存后仅影响新执行；在途 Run 继续使用已冻结的分配。</p></div>
        <div class="row">${badge(budget.source === 'settings' ? `持久设置 · v${budget.effective.version}` : '当前默认值', budget.source === 'settings' ? 'ok' : 'muted')}
        ${badge(`账本域 ${budget.admission.domain} · 修订 ${budget.admission.revision}`, 'muted')}
        ${badge(budget.capabilityVerified ? 'Provider 能力已核验' : 'Provider 能力未核验', budget.capabilityVerified ? 'ok' : 'warn')}</div></div>
      <app-card data-budget="editor">
        ${budget.capabilityVerified ? nothing : html`<div class="notice" role="alert"><div><strong>当前 Provider 能力不可用</strong>此时只能保存准入策略；运行时与 Profile 修改需先完成模型配置。</div></div>`}
        <div class="definitions-grid">
          <div><h3>运行时分配</h3>${RUNTIME_KEYS.map(key => this.renderBudgetInput(key))}</div>
          <div><h3>Profile 限制</h3>${PROFILE_KEYS.map(key => this.renderBudgetInput(key))}</div>
          <div><h3>准入与每日配额</h3>${ADMISSION_KEYS.map(key => this.renderBudgetInput(key))}
            <p class="caption" data-budget="rotation">修改准入策略会轮换账本域：新执行使用新域，旧账本只读保留，不重写、不迁移。</p></div>
        </div>
        <details><summary>Provider 能力与默认值</summary>${pairs([['Provider 模型', provider?.model ?? '不可用'],
          ['上下文窗口', provider ? fmt(provider.contextWindowTokens) : '—'],
          ['最大输出', provider?.maxOutputTokens !== undefined ? fmt(provider.maxOutputTokens) : '—'],
          ['来源', budget.source === 'settings' ? '持久设置' : '能力推导默认值'],
          ['当前账本域', budget.admission.domain],
          ['策略修订', `v${budget.admission.revision}（${budget.admission.source === 'settings' ? '持久设置' : '部署默认值'}）`],
          ['更新时间', budget.effective.updatedAt]])}</details>
        ${this.budgetError ? html`<div class="notice" role="alert"><div>${this.budgetError}</div></div>` : nothing}
        <div class="row">
          <button class="btn btn-primary" data-budget-action="save" ?disabled=${this.budgetSaving || !dirty || blocked}
            aria-busy=${String(this.budgetSaving)} @click=${() => this.saveBudget()}>保存有效预算</button>
          <button class="btn-ghost" data-budget-action="defaults" ?disabled=${this.budgetSaving} @click=${() => this.restoreBudgetDefaults()}>恢复默认值</button>
          <span class="caption">${dirty ? (rotates ? '准入策略已修改 · 保存后轮换账本域' : '有未保存的修改') : '已与当前持久设置一致'}</span>
        </div>
      </app-card>`;
  }
  private renderBudgetInput(key: BudgetKey) {
    const field = BUDGET_FIELDS.find(item => item.key === key)!;
    const gated = !(ADMISSION_KEYS as readonly BudgetKey[]).includes(key) && !this.budget?.capabilityVerified;
    return html`<app-form-field label=${field.label} hint=${field.hint} .error=${this.budgetFieldErrors[key] ?? ''} required>
      <input type="number" inputmode="numeric" min=${field.min} max=${field.max} step="1"
        .value=${String(this.draft?.[key] ?? '')} ?disabled=${this.budgetSaving || gated}
        @input=${(event: Event) => this.updateBudgetField(key, event)} />
    </app-form-field>`;
  }
  static styles = [sharedFieldStyles, sharedBtnStyles, workspaceStyles];
  render() {
    return html`<div class="page-header"><div><h1>${titles[this.kind]}</h1><p class="muted small">${{policies:'确认配置、接入与自动触发状态。',budget:'核对当前限额与持久冻结配置，不推算剩余额度。',usage:'查看已知结算、保留额度及未知用量。'}[this.kind]}</p></div><button aria-busy=${String(this.loading)} class="btn btn-refresh" ?disabled=${this.loading || !this.allowed} @click=${() => this.load()}>刷新${titles[this.kind]}</button></div>
      ${this.loading ? html`<app-card><div class="state-box" role="status">正在加载调查设置…</div></app-card>`
        : this.error || this.forbidden ? html`<app-card><div role="alert"><app-empty-state icon="lock" title=${this.forbidden ? '无权访问' : '暂不可用'} description=${this.error || '当前账号无权访问此调查设置。'}></app-empty-state></div></app-card>`
        : this.facts ? this.kind === 'policies' ? this.renderPolicies(this.facts as InvestigationPoliciesResponse) : this.kind === 'budget' ? this.renderBudget(this.facts as InvestigationBudgetResponse) : this.renderUsage(this.facts as InvestigationUsageResponse) : nothing}
      <p class="detail-note">只读展示当前服务事实；刷新不会注册策略、初始化预算、保留额度或启动调查。</p>${this.renderDialog()}`;
  }
  private openRemediation(remediation: PolicyBlocker['remediation']) {
    const path = remediationPaths[remediation];
    if (!path) return;
    window.history.pushState({}, '', `${settingsBasePath(window.location.pathname)}${path}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  private remediationAction(blocker: PolicyBlocker) {
    const label = remediationLabels[blocker.remediation];
    if (!label) return nothing;
    return remediationPaths[blocker.remediation]
      ? html`<button class="link" data-remediation=${blocker.remediation} @click=${() => this.openRemediation(blocker.remediation)}>${label} →</button>`
      : html`<span class="caption">${label}</span>`;
  }
  private renderPolicies(facts: PolicyFacts) {
    const master = facts.masterSwitch, investigation = facts.investigationSwitch, identity = facts.serviceIdentity;
    const available = facts.automaticAnalysisStatus === 'available';
    const headline = { available: '已就绪', unverified: '待验证入口', blocked: '尚未可用' }[facts.automaticAnalysisStatus];
    const headlineHint = available ? '已确认持久自动入口证据；配置与权限为当前读取事实'
      : facts.automaticAnalysisStatus === 'unverified' ? '配置与开关已就绪，但尚无持久自动入口证据'
        : `${facts.blockers.length} 项阻塞，逐项修复后再判断`;
    return html`<div class="metrics">
        ${stat('配置完整', facts.configurationStatus === 'configured' ? '已配置' : facts.configurationStatus === 'invalid' ? '配置无效' : '尚未配置', '专用身份 + 资源范围 + 总开关格式')}
        ${stat('总开关', master.status === 'invalid' ? '配置无效' : master.enabled ? '已开启' : '已关闭', `${masterStatusLabels[master.status]} · 来源 ${master.source === 'system_config' ? 'system_config' : '默认值'}`)}
        ${stat('自动分析', headline, headlineHint)}
      </div>
      ${facts.blockers.length
        ? html`<div class="notice" role="status"><div><strong>${facts.automaticAnalysisStatus === 'unverified' ? '自动分析待验证入口' : '自动分析尚不可用'}</strong><ul class="rules">${facts.blockers.map(blocker => html`<li data-blocker=${blocker.code}>${blockerLabels[blocker.code]} · ${this.remediationAction(blocker)}</li>`)}</ul></div></div>`
        : html`<div class="notice neutral" role="status"><div><strong>${headline}</strong>配置、入口、权限与预算均为当前读取事实；历史回执与曾成功的执行都不代表下次一定成功。</div></div>`}
      <div class="section-head"><h2>总开关与调查开关</h2><span class="caption">两个开关分别控制不同入口，必须同时开启</span></div>
      <app-card><div class="definitions-grid">
        <div><h3>AI 总开关</h3>${badge(master.status === 'invalid' ? '配置无效' : master.enabled ? '已开启' : '已关闭', master.status === 'invalid' ? 'danger' : master.enabled ? 'ok' : 'muted')}
          ${pairs([['来源', master.source === 'system_config' ? 'system_config.auto_analysis_config' : '内置默认值（未保存配置）'],
            ['保存状态', masterStatusLabels[master.status]], ['分析级别', master.severityLevels.length ? master.severityLevels.join('、') : '无'],
            ['时间窗口', `${master.timeWindowStart}–${master.timeWindowEnd}`], ['实例白名单', master.instanceWhitelistCount ? `${fmt(master.instanceWhitelistCount)} 个（仅数据库）` : '未限制']])}
          <button class="link" data-remediation="analysis_settings" @click=${() => this.openRemediation('analysis_settings')}>查看自动分析设置 →</button></div>
        <div><h3>调查自动开关</h3>${badge(investigation.enabled ? '已开启' : '未开启', investigation.enabled ? 'ok' : 'muted')}
          ${pairs([['来源', '部署环境'], ['自动触发', investigation.enabled ? '已开启' : '未开启'],
            ['手动入口', investigation.manualEnabled ? '已开启' : '未开启'], ['遗留桥接', investigation.legacyEnabled ? '已开启' : '未开启']])}
          <p class="caption">由运维环境变量控制，修改后需重启服务；本页不提供写入。</p></div>
      </div></app-card>
      <div class="section-head"><h2>专用服务身份</h2>${badge(identityLabels[identity.status], identity.status === 'ready' ? 'ok' : identity.status === 'not_configured' ? 'muted' : 'danger')}</div>
      <app-card><div class="definitions-grid"><div>
          <p class="caption">自动调查以专用只读服务主体执行，不借用当前管理员身份。${identity.status === 'ready' ? '已按当前数据库事实核验。' : '未就绪时不会代替执行。'}</p>
          ${pairs([['状态', identityLabels[identity.status]], ['必需权限', identity.permissionsSufficient ? '已具备' : identity.status === 'ready' ? '缺失' : '未知'],
            ['缺少权限', identity.missingPermissions.length ? identity.missingPermissions.join('、') : '无'],
            ['实例级授权', identity.instanceScopeSufficient ? '满足' : '缺少部分实例授权']])}
        </div><div><h3>处理路径</h3><p class="caption">专用身份与资源范围由部署环境配置；账号状态和权限在用户与权限中核验。</p>
          <button class="link" data-remediation="user_permissions" @click=${() => this.openRemediation('user_permissions')}>前往用户与权限 →</button></div>
      </div></app-card>
      <div class="section-head"><div><h2>资源覆盖</h2><p class="caption">数据库、服务器、网络设备分别核验；固定策略名不扩展覆盖范围。</p></div></div>
      <app-card .compact=${true}>${table([{ key: 'type', label: '资源类型', width: '18%' }, { key: 'status', label: '覆盖状态', width: '22%' },
        { key: 'configured', label: '已配置', width: '14%' }, { key: 'existing', label: '存在', width: '14%' },
        { key: 'permitted', label: '可授权访问', width: '16%' }, { key: 'permission', label: '类型权限', width: '16%' }],
        facts.resourceCoverage.map(coverage => ({ type: coverageLabels[coverage.type],
          status: badge(coverageStatusLabels[coverage.status], coverage.status === 'covered' ? 'ok' : coverage.status === 'partial' ? 'warn' : coverage.status === 'unavailable' ? 'danger' : 'muted'),
          configured: fmt(coverage.configuredCount), existing: fmt(coverage.existingCount), permitted: fmt(coverage.permittedCount),
          permission: coverage.typePermission ? '已具备' : '缺少' })))}</app-card>
      <div class="section-head"><h2>自动入口接线</h2><span class="caption">只有当前配置范围内的持久自动接管证据才算接线</span></div>
      <app-card><div class="definitions-grid"><div>
          ${badge(entryLabels[facts.entry.status], facts.entry.status === 'connected' ? 'ok' : facts.entry.status === 'unverified' ? 'warn' : 'muted')}
          ${pairs([['入口状态', entryLabels[facts.entry.status]], ['当前范围回执', `${fmt(facts.entry.observedReceiptCount)} 条`],
            ['最近回执时间', facts.entry.lastObservedAt ?? '无'],
            ['已观察接线的资源类型', facts.entry.witnessTypes.length ? facts.entry.witnessTypes.map(type => coverageLabels[type]).join('、') : '无']])}
          <p class="caption">接线证据来自 investigation_alert_owners 的自动调查接管记录；任意历史告警标签或已删除资源都不能证明当前范围已接线。</p></div>
        <div><h3>历史回执（全部告警）</h3>${pairs([['已受理', fmt(facts.receipts.accepted)], ['已抑制', fmt(facts.receipts.suppressed)],
            ['待处理', fmt(facts.receipts.pending)], ['未知', fmt(facts.receipts.unknown)], ['回执总数', fmt(facts.receipts.total)],
            ['最近状态', facts.receipts.lastStatus ? receiptStatusLabels[facts.receipts.lastStatus] : '无'],
            ['最近原因', facts.receipts.lastReason ?? '无'], ['最近尝试', facts.receipts.lastAttemptAt ?? '无']])}
          <p class="caption">alerts.tags.auto_analysis 只证明入口曾尝试，不证明模型执行或成功。</p></div>
      </div></app-card>
      <div class="section-head"><h2>最近执行结果</h2><span class="caption">来自持久接管、调查请求与工作流任务的真实终态</span></div>
      <app-card><div class="definitions-grid"><div>
          ${facts.execution.observed ? badge(executionLabels[facts.execution.lastStatus!], facts.execution.lastStatus === 'completed' ? 'ok' : ['failed', 'cancelled'].includes(facts.execution.lastStatus!) ? 'danger' : 'warn') : badge('尚无持久执行', 'muted')}
          ${pairs([['已观察到接管', `${fmt(facts.execution.observed)} 次`], ['已受理待执行', fmt(facts.execution.accepted)],
            ['执行中', fmt(facts.execution.running)], ['已完成', fmt(facts.execution.completed)], ['执行失败', fmt(facts.execution.failed)],
            ['部分完成', fmt(facts.execution.partial)], ['执行超时', fmt(facts.execution.timed_out)],
            ['已取消', fmt(facts.execution.cancelled)], ['准入抑制', fmt(facts.execution.suppressed)],
            ['结果未知', fmt(facts.execution.unknown)]])}
          <p class="caption">最近状态 ${facts.execution.lastStatus ? executionLabels[facts.execution.lastStatus] : '无'} · ${facts.execution.lastAt ?? '无时间'}（终结取结束时间；待执行或执行中取受理/开始时间）</p></div>
        <div><h3>口径</h3><p class="caption">终态来自持久的调查 Run，工作流任务完成不代表调查成功；回执观察与执行结果互不替代：入口回执不等于执行，执行成功也不证明此刻的权限与预算仍充足。</p></div>
      </div></app-card>
      <div class="section-head"><h2>预算与准入</h2>${badge(budgetLabels[facts.budget.status], facts.budget.status === 'matching' ? 'ok' : facts.budget.status === 'conflict' ? 'danger' : facts.budget.status === 'unavailable' ? 'danger' : 'warn')}</div>
      <app-card><div class="definitions-grid"><div>${pairs([['冻结策略', budgetLabels[facts.budget.status]],
            ['下一次自动预留', facts.budget.status !== 'matching' ? '无法判断' : facts.budget.quotaReached || facts.budget.capacityReached ? '当前会被拒绝' : '当前可容纳'],
            ['每次预留 Token', fmt(facts.budget.reserveTokens)],
            ['每次预留成本', `${fmt(facts.budget.reserveCostMicros)} micro`],
            ['准入原因', facts.budget.admissionReasons.length ? facts.budget.admissionReasons.map(reason => admissionReasonLabels[reason]).join('；') : '无']])}
          <p class="caption">按当前自动准入的同一预留量比较；并发原因为瞬时快照，不保证未来发送一定成功。只读汇总，不创建域或保留额度。</p></div>
        <div><h3>处理路径</h3><p class="caption">未初始化时首次准入才会创建账本域；本页刷新不会创建或保留额度。</p>
          <button class="link" data-remediation="budget_settings" @click=${() => this.openRemediation('budget_settings')}>前往有效预算 →</button></div>
      </div></app-card>
      <div class="section-head"><h2>策略定义与触发边界</h2><span class="caption">当前生产组合 · 只读</span></div>
      <app-card><div class="definitions-grid"><div><h3>${facts.policy.id}</h3><p class="caption">调用预置 ${facts.policy.profileId.toUpperCase()} · V${facts.policy.version} · 来源 ${facts.policy.source}</p></div>
        <div><h3>逐次准入校验</h3><p class="caption">配置不代表服务主体拥有权限或预算；每次接入实时核验。</p></div></div>
        <details><summary>查看触发边界与技术事实</summary><button class="link" @click=${() => { this.dialog = 'policy'; }}>查看触发边界 →</button></details>
        <p class="detail-note">内部调查事件只持久化，不触发自身调查；本页不注册策略、不初始化预算、不保留额度或启动调查。</p></app-card>`;
  }
  private renderBudget(facts: InvestigationBudgetResponse) {
    const policy = facts.policy, frozen = facts.persistedPolicy;
    const status = {uninitialized:'尚未初始化冻结预算',matching:'当前配置与冻结预算匹配',conflict:'当前配置与冻结预算冲突，不能视为可准入'};
    const fields: Array<[keyof typeof policy,string]> = [['maxTotalTokensPerDay','全部每日 Token 上限'],['maxAutomaticTokensPerDay','自动每日 Token 上限'],['currency','币种'],['maxCostMicrosPerDay','每日成本上限'],['maxConcurrent','全局并发'],['manualReserved','手动并发保留'],['maxPerResourceConcurrent','每资源并发'],['maxAutomaticRequestsPerHour','自动每小时请求上限']];
    const value = (key: keyof typeof policy, p: typeof policy) => key === 'maxCostMicrosPerDay' ? money(p.maxCostMicrosPerDay,p.currency) : typeof p[key] === 'number' ? fmt(p[key] as number) : p[key];
    return html`${this.renderBudgetEditor()}<div class="notice ${facts.admissionStatus === 'conflict' ? '' : 'neutral'}" role=${facts.admissionStatus === 'conflict' ? 'alert' : 'status'}><div><strong>${status[facts.admissionStatus]}</strong>${facts.admissionStatus === 'uninitialized' ? '只读查询不会创建预算域，剩余额度尚不可确定。' : '配置一致性不代表具备余额；每次执行仍需准入校验。'}</div></div>
      <div class="metrics">${stat('全部每日 Token 上限',fmt(policy.maxTotalTokensPerDay),'UTC 日窗口 · 配置额度')}${stat('自动每日 Token 上限',fmt(policy.maxAutomaticTokensPerDay),'包含在全部每日上限中')}${stat('每日成本上限',money(policy.maxCostMicrosPerDay,policy.currency),'按配置费率估算 · 非剩余余额')}</div>
      <div class="section-head"><h2>预算规则</h2><span class="caption">当前加载配置 · 只读</span></div><app-card data-budget="loader"><div class="definitions-grid"><div><h3>并发与频次</h3>${pairs([['全局并发',`${fmt(policy.maxConcurrent)} 个`],['其中手动保留',`${fmt(policy.manualReserved)} 个`],['每资源并发',`${fmt(policy.maxPerResourceConcurrent)} 个`],['自动每小时请求',`${fmt(policy.maxAutomaticRequestsPerHour)} 次`]])}</div><div><h3>成本与预留</h3>${pairs([['币种',policy.currency],['每日成本上限',money(policy.maxCostMicrosPerDay,policy.currency)],['每执行保留成本',money(facts.reserveCostMicros,policy.currency)],['窗口时区','UTC']])}</div></div><details><summary>查看精确值与配置来源</summary>${pairs([['每日成本上限',exactMoney(policy.maxCostMicrosPerDay,policy.currency)],['每执行保留成本',exactMoney(facts.reserveCostMicros,policy.currency)],['配置来源',facts.policySource === 'settings' ? '有效预算设置' : '部署加载器'],['账本域',`${facts.domain} · 修订 ${facts.admissionRevision}`]])}</details></app-card>
      <div class="section-head"><h2>持久冻结配置</h2>${badge(facts.admissionStatus === 'conflict' ? '配置冲突' : frozen ? '一致' : '未初始化',facts.admissionStatus === 'conflict' ? 'danger' : frozen ? 'ok' : 'muted')}</div><app-card data-budget="frozen" .compact=${!!frozen}>${frozen ? table([{key:'field',label:'关键字段',width:'40%'},{key:'loader',label:'当前配置',width:'30%'},{key:'persisted',label:'冻结配置',width:'30%'}],fields.map(([key,label]) => ({field:label,loader:value(key,policy),persisted:html`<span class=${policy[key] !== frozen[key] ? 'conflict' : ''}>${value(key,frozen)}${policy[key] !== frozen[key] ? ' · 不一致' : ''}</span>`}))) : html`<app-empty-state icon="clipboard" title="尚无冻结预算" description="预算域尚未初始化。只读刷新不会保留额度或触发调查。"></app-empty-state>`}</app-card>
      <p class="detail-note">额度不等于余额或供应商收费；Profile 上限见调查 Profiles。${facts.automaticTriggerStatus === 'connected' ? '已确认当前配置范围内的持久自动入口证据；每次实时校验权限与预算。' : '尚未观察到持久自动入口证据，不能确认已接入。'}</p>`;
  }
  private renderUsage(facts: InvestigationUsageResponse) {
    return html`<div class="metrics four">${stat('已知结算 Token',fmt(facts.settledTokens),`${fmt(facts.knownUsageCount)} 条已知用量`)}${stat('当前保留 Token',fmt(facts.outstandingTokens),'未释放的额度保留')}${stat('未知 / 待返回',`${fmt(facts.unknownUsageCount)} / ${fmt(facts.pendingUsageCount)}`,'不能当作零用量或零费用')}${stat('预留记录',fmt(facts.total),`${fmt(facts.groupCount)} 个账本分组`)}</div>
      ${facts.unknownUsageCount || facts.pendingUsageCount || facts.items.some(item => item.unknownCostCount) ? html`<div class="notice"><div><strong>${fmt(facts.unknownUsageCount)} 条用量未知，${fmt(facts.pendingUsageCount)} 条待返回</strong>未知用量、待返回用量和缺费率仍保留额度，不能当作零费用。</div></div>` : nothing}
      <div class="section-head"><div><h2>账本分组</h2><p class="caption">全部历史 · 全局管理汇总 · 按币种、状态及触发方式分组</p></div><button class="btn-ghost" @click=${() => { this.dialog = 'ledger'; }}>查看汇总口径</button></div>
      <app-card .compact=${true}>${facts.items.length ? table([{key:'currency',label:'币种',width:'12%'},{key:'state',label:'账本状态',width:'22%'},{key:'mode',label:'触发方式',width:'14%'},{key:'count',label:'记录数',width:'12%'},{key:'cost',label:'已知结算估算',width:'22%'},{key:'action',label:'详情',width:'18%'}],facts.items.map(item => ({currency:item.currency,state:badge(stateLabels[item.state],item.unknownUsageCount || item.pendingUsageCount || item.unknownCostCount ? 'warn' : item.knownUsageCount ? 'ok' : 'muted'),mode:item.mode === 'manual' ? '手动' : '自动',count:fmt(item.count),cost:item.knownUsageCount > 0 && item.state === 'settled' && item.unknownCostCount < item.knownUsageCount ? html`${money(item.estimatedSettledCostMicros,item.currency)}${item.unknownCostCount ? html`<div class="entity-sub">部分已知估算 · ${fmt(item.unknownCostCount)} 条缺费率</div>` : nothing}` : '—',action:html`<button class="link" data-usage-group=${`${item.currency}/${item.state}/${item.mode}`} @click=${() => { this.group = item; this.dialog = 'group'; }}>查看分组 →</button>`}))) : html`<div class="empty-space"><app-empty-state icon="bar-chart" title=${facts.total === 0 ? '暂无持久用量' : '当前页暂无分组'} description="当前返回为空；未知用量会另行标记，不视为零费用。"></app-empty-state></div>`}
      <div class="paging"><span>当前分组 ${facts.items.length ? this.offset + 1 : 0}–${this.offset + facts.items.length} / ${facts.groupCount}</span><div class="row"><label>每页分组 <select aria-label="每页分组" .value=${String(this.limit)} @change=${(event: Event) => { this.limit = Number((event.target as HTMLSelectElement).value); void this.load(); }}>${[5,20,50].map(limit => html`<option value=${limit} .selected=${this.limit === limit}>${limit}</option>`)}</select></label><button class="btn-ghost" ?disabled=${this.offset === 0} @click=${() => this.load(Math.max(0,this.offset-this.limit))}>上一组页</button><button class="btn-ghost" ?disabled=${facts.nextOffset === null} @click=${() => this.load(facts.nextOffset!)}>下一组页</button></div></div></app-card>
      ${facts.costs.length ? html`<div class="section-head"><h2>成本与额度</h2><span class="caption">不同币种独立展示</span></div><app-card .compact=${true}>${table([{key:'currency',label:'币种',width:'18%'},{key:'known',label:'已知结算估算',width:'28%'},{key:'held',label:'当前保留成本',width:'27%'},{key:'historical',label:'历史预留成本',width:'27%'}],facts.costs.map(cost => ({currency:cost.currency,known:money(cost.estimatedSettledCostMicros,cost.currency),held:money(cost.outstandingCostMicros,cost.currency),historical:money(cost.reservedCostMicros,cost.currency)})))}</app-card>` : nothing}
      <p class="detail-note">费用为配置费率估算，非供应商实收；已知数值只覆盖可计量部分。输入 Token 包含缓存输入，不重复相加。精确 micro 值在汇总及分组详情中保留。</p>`;
  }
  private renderDialog() {
    let title = '', body: unknown = nothing;
    if (this.dialog === 'policy' && this.facts && this.kind === 'policies') {
      const facts = this.facts as PolicyFacts;
      title = '自动分析 · 触发边界'; body = html`${pairs([['配置完整', facts.configurationStatus],
        ['AI 总开关', facts.masterSwitch.status === 'invalid' ? '配置无效' : facts.masterSwitch.enabled ? '已开启' : '已关闭'],
        ['调查自动开关', facts.investigationSwitch.enabled ? '已开启' : '未开启'],
        ['自动入口', entryLabels[facts.entry.status]], ['已接线资源类型', facts.entry.witnessTypes.length ? facts.entry.witnessTypes.map(type => coverageLabels[type]).join('、') : '无'],
        ['最近执行', facts.execution.lastStatus ? executionLabels[facts.execution.lastStatus] : '无'],
        ['专用服务身份', identityLabels[facts.serviceIdentity.status]],
        ['预算', budgetLabels[facts.budget.status]], ['执行模式', '只读']])}<p class="detail-note">主体、全部必需资源、工具策略和预算均逐次实时核验。缺少当前配置范围内的持久自动接管证据时不会宣称已接线；内部调查事件仅持久化，不触发自身调查。</p><details><summary>策略技术标识</summary><pre>${JSON.stringify(facts, null, 2)}</pre></details>`;
    } else if (this.dialog === 'ledger' && this.facts && this.kind === 'usage') {
      const facts = this.facts as InvestigationUsageResponse; title = '持久账本 · 汇总口径';
      body = html`<div data-usage="totals">${pairs([['Reservation 总数',fmt(facts.total)],['分组总数',fmt(facts.groupCount)],...Object.entries(stateLabels).map(([key,label]): [string,unknown] => [label,fmt(facts.counts[key as keyof typeof stateLabels])]),['已知用量数',fmt(facts.knownUsageCount)],['未知用量数',fmt(facts.unknownUsageCount)],['待返回用量数',fmt(facts.pendingUsageCount)],['历史预留 Token',fmt(facts.reservedTokens)],['当前保留 Token',fmt(facts.outstandingTokens)],['已知结算 Token',fmt(facts.settledTokens)]])}</div><p class="detail-note">发送前取消不代表供应商返回零用量。未知、待返回或缺费率部分未计入已知估算。</p><details><summary>精确成本值</summary>${facts.costs.map(cost => html`<div data-currency=${cost.currency}>${pairs([['币种',cost.currency],['历史预留成本',exactMoney(cost.reservedCostMicros,cost.currency)],['当前保留成本',exactMoney(cost.outstandingCostMicros,cost.currency)],['已知结算估算',exactMoney(cost.estimatedSettledCostMicros,cost.currency)]])}</div>`)}</details>`;
    } else if (this.dialog === 'group' && this.group) {
      const item = this.group; title = `${item.currency} · ${stateLabels[item.state]} · ${item.mode === 'manual' ? '手动' : '自动'}`;
      body = html`${pairs([['Reservation 数',fmt(item.count)],['已知 / 未知 / 待返回用量数',`${fmt(item.knownUsageCount)} / ${fmt(item.unknownUsageCount)} / ${fmt(item.pendingUsageCount)}`],['已知输入 Token 小计',item.knownUsageCount ? fmt(item.knownInputTokens) : '未计量'],['其中缓存输入',item.knownUsageCount ? fmt(item.knownCachedInputTokens) : '未计量'],['已知输出 Token 小计',item.knownUsageCount ? fmt(item.knownOutputTokens) : '未计量'],['历史预留 / 当前保留 Token',`${fmt(item.reservedTokens)} / ${fmt(item.outstandingTokens)}`],['已知结算 Token',fmt(item.settledTokens)],['未知成本数（含缺费率）',fmt(item.unknownCostCount)]])}<p class="detail-note">${item.state === 'cancelled' ? '发送前取消未发送，不代表供应商返回零用量。' : '已知 Token 仅为小计；未知、待返回或缺费率部分未计入已知估算。'} 输入 Token 包含缓存输入，不重复相加。</p><details><summary>精确成本值</summary>${pairs([['历史预留成本',exactMoney(item.reservedCostMicros,item.currency)],['当前保留成本',exactMoney(item.outstandingCostMicros,item.currency)],['已知结算估算',item.knownUsageCount && item.unknownCostCount < item.knownUsageCount ? exactMoney(item.estimatedSettledCostMicros,item.currency) : '未计量']])}</details>`;
    }
    return html`<app-dialog .open=${!!this.dialog} size="xl" .title=${title} @app-dialog-close=${() => { this.dialog = ''; }}>${body}<div slot="footer"><button class="btn" @click=${() => { this.dialog = ''; }}>关闭</button></div></app-dialog>`;
  }
}
