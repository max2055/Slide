import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { showToast } from '../components/app-toast-container.js';
import '../components/app-badge.js';
import '../components/app-card.js';
import '../components/app-data-table.js';
import '../components/app-form-field.js';

type ToolEffect = 'read' | 'write' | 'execute' | 'secret' | 'delegate';

interface AgentSecurityPolicy {
  agentId: string;
  toolAllowlist: string[] | null;
  skillAllowlist: string[] | null;
  allowedEffects: ToolEffect[];
  resourceScope: { instanceIds: number[] | null; serverIds: number[] | null; networkDeviceIds?: number[] | null };
  version: number;
  updatedBy: number | null;
  updatedAt: string | null;
}

interface SecurityCatalogResponse {
  agents: Array<{ id: string; name: string }>;
  policies: AgentSecurityPolicy[];
  tools: Array<{
    name: string;
    description: string;
    security: { effect: ToolEffect; resource: string; permissions: string[] } | null;
  }>;
  skills: Array<{ name: string; description: string; enabled: boolean; trusted: boolean }>;
}

interface PolicyHistoryRecord {
  id: number;
  version: number;
  changeNote: string;
  changedByUsername: string | null;
  changedBy: number;
  createdAt: string;
}

interface AgentExecutionConfig {
  approvalEnabled: boolean;
  restrictedNetworkEnabled: boolean;
  reasonCode: string;
}

const EFFECTS: Array<{ id: ToolEffect; label: string }> = [
  { id: 'read', label: '读取' },
  { id: 'write', label: '写入' },
  { id: 'execute', label: '执行' },
  { id: 'secret', label: '凭据使用' },
  { id: 'delegate', label: '委派' },
];

function permissions(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem('permissions') || '[]');
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function hasPermission(required: string): boolean {
  const current = permissions();
  if (current.has('*') || current.has(required)) return true;
  const separator = required.indexOf(':');
  return separator > 0 && (current.has(`${required.slice(0, separator)}:*`) || current.has(`*:${required.slice(separator + 1)}`));
}

function parseIds(value: string): number[] | null {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const ids = trimmed.split(',').map((item) => Number(item.trim()));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('ID_INVALID');
  return [...new Set(ids)].sort((a, b) => a - b);
}

@customElement('agent-security-policy-page')
export class AgentSecurityPolicyPage extends LitElement {
  @state() private catalog: SecurityCatalogResponse | null = null;
  @state() private selectedAgentId = '';
  @state() private policy: AgentSecurityPolicy | null = null;
  @state() private toolMode: 'inherit' | 'custom' = 'inherit';
  @state() private skillMode: 'inherit' | 'custom' = 'inherit';
  @state() private instanceMode: 'inherit' | 'custom' = 'inherit';
  @state() private serverMode: 'inherit' | 'custom' = 'inherit';
  @state() private networkDeviceMode: 'inherit' | 'custom' = 'inherit';
  @state() private selectedTools = new Set<string>();
  @state() private selectedSkills = new Set<string>();
  @state() private selectedEffects = new Set<ToolEffect>();
  @state() private instanceIds = '';
  @state() private serverIds = '';
  @state() private networkDeviceIds = '';
  @state() private changeNote = '';
  @state() private history: PolicyHistoryRecord[] = [];
  @state() private executionConfig: AgentExecutionConfig | null = null;
  @state() private executionConfigSaving = false;
  @state() private loading = true;
  @state() private saving = false;

  static styles = [sharedBtnStyles, css`
    :host { display: block; color: var(--text); }
    .page-header, .header-actions, .row-between, .choice-grid, .mode-control, .effect-list {
      display: flex;
      align-items: center;
    }
    .page-header { justify-content: space-between; gap: var(--space-lg); margin-bottom: var(--space-xl); }
    .page-header h1 { margin: 0 0 var(--space-xs); font-size: var(--text-xl); color: var(--text-strong); }
    .page-header p, .subtle { margin: 0; color: var(--muted); font-size: var(--text-sm); }
    .header-actions { gap: var(--space-sm); }
    .header-actions select { min-width: 12rem; }
    .layout { display: grid; gap: var(--space-lg); }
    .card-title { display: inline-flex; align-items: center; gap: var(--space-sm); }
    .card-title svg, button svg { width: 1rem; height: 1rem; }
    .section + .section { margin-top: var(--space-xl); padding-top: var(--space-xl); border-top: 1px solid var(--border); }
    .row-between { justify-content: space-between; gap: var(--space-md); margin-bottom: var(--space-md); }
    .section-title { margin: 0; font-size: var(--text-md); color: var(--text-strong); }
    .mode-control { border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
    .mode-control button { border: 0; border-right: 1px solid var(--border); background: var(--card); color: var(--muted); padding: var(--space-xs) var(--space-md); cursor: pointer; }
    .mode-control button:last-child { border-right: 0; }
    .mode-control button.active { background: var(--accent); color: var(--accent-foreground); }
    .mode-control button:disabled { cursor: not-allowed; opacity: var(--disabled-opacity); }
    .choice-grid { align-items: stretch; flex-wrap: wrap; gap: var(--space-sm); }
    .choice { display: flex; gap: var(--space-sm); align-items: flex-start; width: min(21rem, 100%); padding: var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elevated); }
    .choice input { margin-top: var(--space-xs); }
    .choice strong { display: block; font-size: var(--text-sm); overflow-wrap: anywhere; }
    .choice span { display: block; margin-top: var(--space-xs); color: var(--muted); font-size: var(--text-xs); line-height: 1.4; }
    .effect-list { flex-wrap: wrap; gap: var(--space-lg); }
    .effect-list label { display: inline-flex; align-items: center; gap: var(--space-xs); font-size: var(--text-sm); }
    .scope-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-lg); }
    input[type='text'], textarea, select { box-sizing: border-box; width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--card); color: var(--text); padding: var(--space-sm) var(--space-md); font: inherit; }
    textarea { resize: vertical; min-height: 5rem; }
    input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent-subtle); border-color: var(--accent); }
    .footer-actions { display: flex; justify-content: flex-end; align-items: center; gap: var(--space-md); }
    .empty-block { padding: var(--space-lg); border: 1px dashed var(--border); border-radius: var(--radius-sm); color: var(--muted); font-size: var(--text-sm); }
    .control-list { display: grid; gap: var(--space-md); }
    .control-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-lg); padding: var(--space-md) 0; border-bottom: 1px solid var(--border); }
    .control-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .control-copy { display: grid; gap: var(--space-xs); }
    .control-copy strong { color: var(--text-strong); font-size: var(--text-sm); }
    .control-copy span { color: var(--muted); font-size: var(--text-xs); line-height: 1.4; }
    .toggle { position: relative; display: inline-flex; flex: 0 0 auto; align-items: center; cursor: pointer; }
    .toggle input { position: absolute; opacity: 0; pointer-events: none; }
    .toggle-track { width: 2.75rem; height: 1.5rem; border-radius: 999px; background: var(--border); transition: background .15s ease; }
    .toggle-track::after { content: ''; display: block; width: 1.1rem; height: 1.1rem; margin: .2rem; border-radius: 50%; background: var(--card); transition: transform .15s ease; box-shadow: 0 1px 2px rgb(0 0 0 / .2); }
    .toggle input:checked + .toggle-track { background: var(--accent); }
    .toggle input:checked + .toggle-track::after { transform: translateX(1.25rem); }
    .toggle input:disabled + .toggle-track { opacity: var(--disabled-opacity); cursor: not-allowed; }
    @media (max-width: 760px) {
      .page-header, .row-between { align-items: stretch; flex-direction: column; }
      .header-actions { width: 100%; }
      .header-actions select { min-width: 0; flex: 1; }
      .scope-grid { grid-template-columns: 1fr; }
      .choice { width: 100%; }
    }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    try {
      this.catalog = await apiClient.get<SecurityCatalogResponse>('/agent/security/policies');
      this.selectedAgentId = this.selectedAgentId || this.catalog.agents[0]?.id || '';
      this.applyPolicy();
      await this.loadHistory();
      await this.loadExecutionConfig();
    } catch {
      showToast('加载 Agent 安全策略失败', 'error');
    } finally {
      this.loading = false;
    }
  }

  private async loadExecutionConfig(): Promise<void> {
    if (!hasPermission('admin:*')) {
      this.executionConfig = null;
      return;
    }
    try {
      this.executionConfig = await apiClient.get<AgentExecutionConfig>('/agent/security/config');
    } catch {
      this.executionConfig = null;
      showToast('加载 Agent 执行控制失败', 'error');
    }
  }

  private async saveExecutionConfig(patch: Partial<AgentExecutionConfig>): Promise<void> {
    if (!this.executionConfig) return;
    const previous = this.executionConfig;
    this.executionConfigSaving = true;
    try {
      this.executionConfig = await apiClient.put<AgentExecutionConfig>('/agent/security/config', {
        approvalEnabled: patch.approvalEnabled ?? previous.approvalEnabled,
        restrictedNetworkEnabled: patch.restrictedNetworkEnabled ?? previous.restrictedNetworkEnabled,
      });
      showToast('Agent 执行控制已更新', 'success');
    } catch (error) {
      this.executionConfig = previous;
      const detail = error instanceof Error ? error.message : '';
      showToast(detail.includes('SANDBOX_NETWORK_NOT_READY')
        ? '受限网络未就绪，请先配置 Sandbox Controller 的专用网络'
        : '更新 Agent 执行控制失败', 'error');
    } finally {
      this.executionConfigSaving = false;
    }
  }

  private onExecutionToggle(key: 'approvalEnabled' | 'restrictedNetworkEnabled', event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const enabled = input.checked;
    input.checked = this.executionConfig?.[key] === true;
    void this.saveExecutionConfig({ [key]: enabled });
  }

  private applyPolicy(): void {
    const policy = this.catalog?.policies.find((item) => item.agentId === this.selectedAgentId) ?? null;
    this.policy = policy;
    if (!policy) return;
    this.toolMode = policy.toolAllowlist === null ? 'inherit' : 'custom';
    this.skillMode = policy.skillAllowlist === null ? 'inherit' : 'custom';
    this.instanceMode = policy.resourceScope.instanceIds === null ? 'inherit' : 'custom';
    this.serverMode = policy.resourceScope.serverIds === null ? 'inherit' : 'custom';
    this.networkDeviceMode = policy.resourceScope.networkDeviceIds == null ? 'inherit' : 'custom';
    this.selectedTools = new Set(policy.toolAllowlist ?? this.catalog?.tools.map((tool) => tool.name) ?? []);
    this.selectedSkills = new Set(policy.skillAllowlist ?? this.catalog?.skills.map((skill) => skill.name) ?? []);
    this.selectedEffects = new Set(policy.allowedEffects);
    this.instanceIds = policy.resourceScope.instanceIds?.join(', ') ?? '';
    this.serverIds = policy.resourceScope.serverIds?.join(', ') ?? '';
    this.networkDeviceIds = policy.resourceScope.networkDeviceIds?.join(', ') ?? '';
    this.changeNote = '';
  }

  private async loadHistory(): Promise<void> {
    if (!this.selectedAgentId || !hasPermission('audit:view')) {
      this.history = [];
      return;
    }
    try {
      const response = await apiClient.get<{ records: PolicyHistoryRecord[] }>(`/agent/security/policies/${encodeURIComponent(this.selectedAgentId)}/history`);
      this.history = response.records;
    } catch {
      this.history = [];
    }
  }

  private async selectAgent(event: Event): Promise<void> {
    this.selectedAgentId = (event.target as HTMLSelectElement).value;
    this.applyPolicy();
    await this.loadHistory();
  }

  private toggleSet<T>(source: Set<T>, value: T, selected: boolean): Set<T> {
    const next = new Set(source);
    selected ? next.add(value) : next.delete(value);
    return next;
  }

  private async save(): Promise<void> {
    if (!this.policy || !this.changeNote.trim()) {
      showToast('请填写变更说明', 'warning');
      return;
    }
    if (this.selectedEffects.size === 0) {
      showToast('至少保留一种允许的操作级别', 'warning');
      return;
    }
    this.saving = true;
    try {
      const response = await apiClient.put<{ policy: AgentSecurityPolicy }>(`/agent/security/policies/${encodeURIComponent(this.selectedAgentId)}`, {
        toolAllowlist: this.toolMode === 'inherit' ? null : [...this.selectedTools].sort(),
        skillAllowlist: this.skillMode === 'inherit' ? null : [...this.selectedSkills].sort(),
        allowedEffects: EFFECTS.map((effect) => effect.id).filter((effect) => this.selectedEffects.has(effect)),
        resourceScope: {
          instanceIds: this.instanceMode === 'inherit' ? null : parseIds(this.instanceIds),
          serverIds: this.serverMode === 'inherit' ? null : parseIds(this.serverIds),
          networkDeviceIds: this.networkDeviceMode === 'inherit' ? null : parseIds(this.networkDeviceIds),
        },
        changeNote: this.changeNote.trim(),
      });
      this.policy = response.policy;
      if (this.catalog) {
        this.catalog = { ...this.catalog, policies: this.catalog.policies.map((item) => item.agentId === response.policy.agentId ? response.policy : item) };
      }
      this.applyPolicy();
      await this.loadHistory();
      showToast('Agent 安全策略已更新', 'success');
    } catch (error) {
      showToast(error instanceof Error && error.message === 'ID_INVALID' ? '资源范围只能填写正整数 ID' : '更新 Agent 安全策略失败', 'error');
    } finally {
      this.saving = false;
    }
  }

  private renderMode(value: 'inherit' | 'custom', onChange: (value: 'inherit' | 'custom') => void) {
    const disabled = !hasPermission('admin:*');
    return html`<div class="mode-control" role="group" aria-label="范围模式">
      <button type="button" class=${value === 'inherit' ? 'active' : ''} @click=${() => onChange('inherit')} .disabled=${disabled}>继承</button>
      <button type="button" class=${value === 'custom' ? 'active' : ''} @click=${() => onChange('custom')} .disabled=${disabled}>自定义</button>
    </div>`;
  }

  private historyRows(): Record<string, unknown>[] {
    return this.history.map((record) => ({
      version: `v${record.version}`,
      changeNote: record.changeNote,
      actor: record.changedByUsername || `用户 #${record.changedBy}`,
      createdAt: new Date(record.createdAt).toLocaleString(),
    }));
  }

  override render() {
    const isAdmin = hasPermission('admin:*');
    return html`
      <div class="page-header">
        <div><h1>Agent 安全</h1><p>在平台 Tool 目录、Skill 环境策略与用户 RBAC 基础上进一步收窄 Agent 权限</p></div>
        <div class="header-actions">
          <select aria-label="Agent" .value=${this.selectedAgentId} @change=${this.selectAgent}>
            ${(this.catalog?.agents ?? []).map((agent) => html`<option value=${agent.id}>${agent.name} (${agent.id})</option>`)}
          </select>
          <button class="btn-icon" title="刷新" aria-label="刷新" @click=${this.load} .disabled=${this.loading}>${icons.refresh}</button>
        </div>
      </div>
      ${this.loading || !this.policy || !this.catalog ? html`<div class="skeleton"></div>` : html`
        <div class="layout">
          ${isAdmin ? html`<app-card>
            <span slot="header" class="card-title">${icons.shield} Agent 执行控制</span>
            ${this.executionConfig ? html`<div class="control-list">
              <div class="control-row">
                <div class="control-copy"><strong>执行审批</strong><span>关闭后绕过 Agent 工具执行审批（包括代码执行和数据库发现）；用户权限、沙箱隔离和审计仍然保留。</span></div>
                <label class="toggle" title=${this.executionConfig.approvalEnabled ? '关闭执行审批' : '开启执行审批'}>
                  <input data-action="approval-toggle" type="checkbox" .checked=${this.executionConfig.approvalEnabled} .disabled=${this.executionConfigSaving} @change=${(event: Event) => this.onExecutionToggle('approvalEnabled', event)} aria-label="Agent 执行审批开关">
                  <span class="toggle-track"></span>
                </label>
              </div>
              <div class="control-row">
                <div class="control-copy"><strong>受限网络</strong><span>允许代码请求预配置的受限 Sandbox 网络；仍需 Controller 配置专用网络和出口策略。</span></div>
                <label class="toggle" title=${this.executionConfig.restrictedNetworkEnabled ? '关闭受限网络' : '开启受限网络'}>
                  <input data-action="restricted-network-toggle" type="checkbox" .checked=${this.executionConfig.restrictedNetworkEnabled} .disabled=${this.executionConfigSaving} @change=${(event: Event) => this.onExecutionToggle('restrictedNetworkEnabled', event)} aria-label="Agent 受限网络开关">
                  <span class="toggle-track"></span>
                </label>
              </div>
            </div>` : html`<div class="empty-block">执行控制配置不可用，系统按安全默认值运行。</div>`}
          </app-card>` : nothing}
          <app-card>
            <span slot="header" class="card-title">${icons.shield} 权限边界 <app-badge variant="info">v${this.policy.version}</app-badge></span>
            <section class="section">
              <div class="row-between"><div><h2 class="section-title">Tool 白名单</h2><p class="subtle">自定义模式只能从平台已注册目录中选择</p></div>${this.renderMode(this.toolMode, (value) => { this.toolMode = value; })}</div>
              ${this.toolMode === 'custom' ? html`<div class="choice-grid">${this.catalog.tools.map((tool) => html`
                <label class="choice"><input type="checkbox" .checked=${this.selectedTools.has(tool.name)} .disabled=${!isAdmin} @change=${(event: Event) => { this.selectedTools = this.toggleSet(this.selectedTools, tool.name, (event.target as HTMLInputElement).checked); }}><span><strong>${tool.name}</strong><span>${tool.description || '无描述'} · ${tool.security?.effect ?? '未分类'}</span></span></label>
              `)}</div>` : html`<div class="empty-block">继承平台 Tool 目录；实际执行仍受操作级别、资源范围和用户 RBAC 限制。</div>`}
            </section>
            <section class="section">
              <div class="row-between"><div><h2 class="section-title">Skill 白名单</h2><p class="subtle">只会加载同时满足环境策略与 Agent 策略的 Skill</p></div>${this.renderMode(this.skillMode, (value) => { this.skillMode = value; })}</div>
              ${this.skillMode === 'custom' ? html`<div class="choice-grid">${this.catalog.skills.map((skill) => html`
                <label class="choice"><input type="checkbox" .checked=${this.selectedSkills.has(skill.name)} .disabled=${!isAdmin} @change=${(event: Event) => { this.selectedSkills = this.toggleSet(this.selectedSkills, skill.name, (event.target as HTMLInputElement).checked); }}><span><strong>${skill.name}</strong><span>${skill.description || '无描述'} · ${skill.enabled ? '环境启用' : '环境禁用'} · ${skill.trusted ? '可信' : '未信任'}</span></span></label>
              `)}</div>` : html`<div class="empty-block">继承部署环境的 Skill allowlist 和可信校验结果。</div>`}
            </section>
            <section class="section">
              <div class="row-between"><div><h2 class="section-title">允许的操作级别</h2><p class="subtle">未勾选的 effect 不会暴露给模型，也无法在执行阶段绕过</p></div></div>
              <div class="effect-list">${EFFECTS.map((effect) => html`<label><input type="checkbox" .checked=${this.selectedEffects.has(effect.id)} .disabled=${!isAdmin} @change=${(event: Event) => { this.selectedEffects = this.toggleSet(this.selectedEffects, effect.id, (event.target as HTMLInputElement).checked); }}> ${effect.label}</label>`)}</div>
            </section>
            <section class="section">
              <div class="scope-grid">
                <div><div class="row-between"><h2 class="section-title">实例范围</h2>${this.renderMode(this.instanceMode, (value) => { this.instanceMode = value; })}</div>${this.instanceMode === 'custom' ? html`<app-form-field label="实例 ID" hint="多个 ID 使用英文逗号分隔；留空表示拒绝所有实例"><input type="text" .value=${this.instanceIds} .disabled=${!isAdmin} @input=${(event: Event) => { this.instanceIds = (event.target as HTMLInputElement).value; }}></app-form-field>` : html`<p class="subtle">继承用户实例 RBAC 范围</p>`}</div>
                <div><div class="row-between"><h2 class="section-title">服务器范围</h2>${this.renderMode(this.serverMode, (value) => { this.serverMode = value; })}</div>${this.serverMode === 'custom' ? html`<app-form-field label="服务器 ID" hint="多个 ID 使用英文逗号分隔；留空表示拒绝所有服务器"><input type="text" .value=${this.serverIds} .disabled=${!isAdmin} @input=${(event: Event) => { this.serverIds = (event.target as HTMLInputElement).value; }}></app-form-field>` : html`<p class="subtle">继承用户服务器 RBAC 范围</p>`}</div>
                <div><div class="row-between"><h2 class="section-title">网络设备范围</h2>${this.renderMode(this.networkDeviceMode, (value) => { this.networkDeviceMode = value; })}</div>${this.networkDeviceMode === 'custom' ? html`<app-form-field label="网络设备 ID" hint="多个 ID 使用英文逗号分隔；留空表示拒绝所有网络设备"><input type="text" .value=${this.networkDeviceIds} .disabled=${!isAdmin} @input=${(event: Event) => { this.networkDeviceIds = (event.target as HTMLInputElement).value; }}></app-form-field>` : html`<p class="subtle">继承用户网络设备 RBAC 范围</p>`}</div>
              </div>
            </section>
            ${isAdmin ? html`<section class="section"><app-form-field label="变更说明" hint="将写入不可变策略历史" required><textarea maxlength="500" .value=${this.changeNote} @input=${(event: Event) => { this.changeNote = (event.target as HTMLTextAreaElement).value; }}></textarea></app-form-field><div class="footer-actions"><button class="btn-primary" @click=${this.save} .disabled=${this.saving || !this.changeNote.trim()}>${icons.save} ${this.saving ? '保存中' : '保存策略'}</button></div></section>` : html`<section class="section"><app-badge variant="muted">只读</app-badge> <span class="subtle">仅管理员可修改策略</span></section>`}
          </app-card>
          ${hasPermission('audit:view') ? html`<app-card><span slot="header" class="card-title">${icons.activity} 策略变更记录</span><app-data-table .columns=${[{ key: 'version', label: '版本' }, { key: 'changeNote', label: '变更说明' }, { key: 'actor', label: '操作者' }, { key: 'createdAt', label: '时间' }]} .rows=${this.historyRows()} .loading=${false} emptyMessage="暂无策略变更"></app-data-table></app-card>` : nothing}
        </div>
      `}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'agent-security-policy-page': AgentSecurityPolicyPage } }
