import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { showToast } from '../components/app-toast-container.js';
import { inferBasePathFromPathname } from '../navigation.ts';
import { permissionMatches, settingsItemById } from '../settings-navigation.ts';
import '../components/app-badge.js';
import '../components/app-card.js';
import '../components/app-data-table.js';
import '../components/app-empty-state.js';
import '../components/app-dialog.js';

interface SandboxStatus {
  status: string;
  activeJobs: number;
  maxConcurrentJobs: number;
  daemon: { checkedAt: string; reachable: boolean; rootless: boolean };
  policy: {
    network: string;
    rootFilesystem: string;
    user: string;
    capabilities: string;
    noNewPrivileges: boolean;
    runtimes: string[];
    limits: Record<string, number | string>;
  };
  recentJobs: Array<{
    jobId: string;
    runtime: string;
    status: 'succeeded' | 'failed' | 'timed_out';
    exitCode: number | null;
    timedOut: boolean;
    outputTruncated: boolean;
    createdAt: string;
    durationMs: number;
  }>;
}

interface SandboxResponse { configured: boolean; reachable: boolean; status?: SandboxStatus }
interface SandboxConfigResponse { enabled: boolean; reasonCode: string }

const CODE_RUNTIMES = new Set(['shell', 'sh', 'bash', 'python', 'python3', 'node', 'nodejs']);

@customElement('agent-sandbox-status-page')
export class AgentSandboxStatusPage extends LitElement {
  @property({ type: Boolean, attribute: 'status-only' }) statusOnly = false;
  @state() private response: SandboxResponse | null = null;
  @state() private loading = false;
  @state() private canView = false;
  @state() private canManage = false;
  @state() private config: SandboxConfigResponse | null = null;
  @state() private configLoading = false;
  @state() private saving = false;
  @state() private confirmEnable = false;
  private statusRequest = 0;
  private configRequest = 0;
  private permissionsRequest = 0;

  private readonly permissionsChanged = (event: Event) => {
    this.permissionsRequest++;
    this.syncPermissions((event as CustomEvent<{ permissions?: string[] }>).detail?.permissions);
  };
  private readonly clearPermissions = () => {
    this.permissionsRequest++;
    this.syncPermissions([]);
  };

  static styles = [sharedFieldStyles, sharedBtnStyles, css`
    :host { display: block; color: var(--text); }
    .page-header, .status-grid, .policy-grid, .metric, .metric-value { display: flex; }
    .page-header { align-items: center; justify-content: space-between; gap: var(--space-lg); margin-bottom: var(--space-xl); }
    .page-header h1 { margin: 0 0 var(--space-xs); font-size: var(--text-xl); color: var(--text-strong); }
    .page-header p { margin: 0; color: var(--muted); font-size: var(--text-sm); }
    .header-actions { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; }
    button svg { width: 1rem; height: 1rem; }
    .layout { display: grid; gap: var(--space-lg); }
    .status-grid { align-items: stretch; flex-wrap: wrap; gap: var(--space-md); }
    .metric { flex: 1 1 10rem; flex-direction: column; gap: var(--space-sm); min-width: 0; padding: var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elevated); }
    .metric-label { color: var(--muted); font-size: var(--text-xs); }
    .metric-value { align-items: center; gap: var(--space-sm); color: var(--text-strong); font-size: var(--text-lg); font-weight: 600; overflow-wrap: anywhere; }
    .policy-grid { flex-wrap: wrap; gap: var(--space-md); }
    .policy-item { flex: 1 1 14rem; min-width: 0; padding-bottom: var(--space-md); border-bottom: 1px solid var(--border); }
    .policy-item span { display: block; color: var(--muted); font-size: var(--text-xs); }
    .policy-item strong { display: block; margin-top: var(--space-xs); color: var(--text-strong); font-size: var(--text-sm); overflow-wrap: anywhere; }
    .limits { display: flex; flex-wrap: wrap; gap: var(--space-sm); margin-top: var(--space-lg); }
    .limit { padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-sm); background: var(--bg-hover); font-size: var(--text-xs); }
    .mono { font-family: var(--font-mono); font-size: var(--text-xs); overflow-wrap: anywhere; }
    .table-wrap { overflow-x: auto; }
    .config-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-lg); }
    .config-card { display: block; margin-bottom: var(--space-lg); }
    .config-copy { min-width: 0; }
    .config-copy strong { display: block; color: var(--text-strong); font-size: var(--text-base); }
    .config-copy span { display: block; margin-top: var(--space-xs); color: var(--muted); font-size: var(--text-sm); }
    .config-feedback { margin: var(--space-sm) 0 0; color: var(--muted); font-size: var(--text-sm); }
    .toggle { position: relative; display: inline-flex; flex: 0 0 auto; width: 2.75rem; height: 1.5rem; }
    .toggle input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .toggle-track { width: 100%; height: 100%; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-hover); cursor: pointer; transition: background var(--duration-fast), border-color var(--duration-fast); }
    .toggle-track::after { content: ''; position: absolute; top: 0.25rem; left: 0.25rem; width: 1rem; height: 1rem; border-radius: 50%; background: var(--text-strong); transition: transform var(--duration-fast); }
    .toggle input:checked + .toggle-track { border-color: var(--accent); background: var(--accent); }
    .toggle input:checked + .toggle-track::after { transform: translateX(1.25rem); background: var(--card); }
    .toggle input:focus-visible + .toggle-track { outline: 2px solid var(--accent); outline-offset: 2px; }
    .toggle input:disabled + .toggle-track { cursor: not-allowed; opacity: 0.55; }
    .dialog-copy { margin: 0; color: var(--text); line-height: 1.6; }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.permissionsChanged);
    window.addEventListener('slide-session-expired', this.clearPermissions);
    let permissions: unknown;
    try { permissions = JSON.parse(localStorage.getItem('permissions') ?? 'null'); } catch { /* Fail closed. */ }
    this.syncPermissions(permissions, false);
    void this.reloadPermissions();
  }

  override disconnectedCallback(): void {
    window.removeEventListener('slide-permissions-loaded', this.permissionsChanged);
    window.removeEventListener('slide-session-expired', this.clearPermissions);
    this.clearPermissions();
    super.disconnectedCallback();
  }

  private syncPermissions(values: unknown, managementVerified = true): void {
    const permissions = new Set<string>(Array.isArray(values) && values.every(value => typeof value === 'string') ? values : []);
    const canView = permissionMatches(permissions, 'audit:view');
    const canManage = managementVerified && canView && permissionMatches(permissions, 'admin:*');
    if (canView !== this.canView) {
      this.canView = canView;
      if (canView) void this.loadStatus();
      else {
        this.statusRequest++;
        this.response = null;
        this.loading = false;
      }
    }
    if (canManage !== this.canManage) {
      this.canManage = canManage;
      if (canManage && !this.statusOnly) void this.loadConfig();
      else if (!canManage) this.clearConfig();
    }
  }

  private async reloadPermissions(): Promise<void> {
    const request = ++this.permissionsRequest;
    this.canManage = false;
    this.clearConfig();
    if (!apiClient.getToken()) return;
    const session = apiClient.getSessionContext();
    try {
      const permissions = await apiClient.get<unknown>('/auth/permissions');
      if (request === this.permissionsRequest && session === apiClient.getSessionContext()) {
        this.syncPermissions(permissions);
      }
    } catch {
      // The separate sandbox status read still enforces audit:view.
    }
  }

  private clearConfig(): void {
    this.configRequest++;
    this.config = null;
    this.configLoading = false;
    this.saving = false;
    this.confirmEnable = false;
  }

  private async loadStatus(): Promise<void> {
    const request = ++this.statusRequest;
    this.loading = true;
    try {
      const response = await apiClient.get<SandboxResponse>('/agent/security/sandbox');
      if (request !== this.statusRequest) return;
      const status = response?.status;
      this.response = typeof response?.configured === 'boolean' && typeof response.reachable === 'boolean'
        && (!response.reachable || (response.configured && typeof status?.daemon?.reachable === 'boolean'
          && typeof status.daemon.rootless === 'boolean' && typeof status.status === 'string'
          && Array.isArray(status.policy?.runtimes) && status.policy.limits && Array.isArray(status.recentJobs)))
        ? response : null;
    } catch (error) {
      if (request !== this.statusRequest) return;
      if (error instanceof Error && /^HTTP 40[13]:/.test(error.message)) this.clearPermissions();
      else this.response = null;
    } finally {
      if (request === this.statusRequest) this.loading = false;
    }
  }

  private async loadConfig(): Promise<void> {
    const request = ++this.configRequest;
    this.configLoading = true;
    try {
      const config = await apiClient.get<SandboxConfigResponse>('/agent/security/sandbox/config');
      if (request === this.configRequest) {
        this.config = (config?.enabled === true && config.reasonCode === 'SANDBOX_ENABLED')
          || (config?.enabled === false && config.reasonCode === 'SANDBOX_DISABLED') ? config : null;
      }
    } catch (error) {
      if (request === this.configRequest) {
        this.config = null;
        this.clearConfigIfDenied(error);
      }
    } finally {
      if (request === this.configRequest) this.configLoading = false;
    }
  }

  private clearConfigIfDenied(error: unknown): void {
    if (error instanceof Error && /^HTTP 40[13]:/.test(error.message)) {
      this.canManage = false;
      this.clearConfig();
    }
  }

  private refresh(): void {
    if (!this.canView || this.loading) return;
    void this.loadStatus();
    if (!this.configLoading && !this.saving) void this.reloadPermissions();
  }

  private onToggle(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const enabled = input.checked;
    input.checked = this.config?.enabled === true;
    if (!this.canManage || this.statusOnly || !this.config || this.configLoading || this.saving) return;
    if (enabled) {
      this.confirmEnable = true;
      return;
    }
    void this.saveConfig(false);
  }

  private async saveConfig(enabled: boolean): Promise<void> {
    if (!this.canManage || this.statusOnly || !this.config || this.configLoading || this.saving) return;
    const request = ++this.configRequest;
    this.saving = true;
    try {
      const config = await apiClient.put<SandboxConfigResponse>('/agent/security/sandbox/config', { enabled });
      if (request !== this.configRequest) return;
      this.config = config;
      this.confirmEnable = false;
      showToast(enabled ? 'Agent Sandbox 已启用' : 'Agent Sandbox 已禁用', 'success');
    } catch (error) {
      if (request !== this.configRequest) return;
      this.clearConfigIfDenied(error);
      const detail = error instanceof Error ? error.message : '';
      showToast(detail.includes('SANDBOX_NOT_READY')
        ? 'Sandbox Controller 未就绪，请检查 Controller 地址、rootless Docker 和运行时镜像'
        : '更新 Agent Sandbox 设置失败', 'error');
    } finally {
      if (request === this.configRequest) this.saving = false;
    }
  }

  private jobRows(status: SandboxStatus): Record<string, unknown>[] {
    return status.recentJobs.map((job) => ({
      createdAt: new Date(job.createdAt).toLocaleString(),
      jobId: html`<span class="mono">${job.jobId}</span>`,
      runtime: job.runtime,
      status: html`<app-badge variant=${job.status === 'succeeded' ? 'ok' : job.status === 'timed_out' ? 'warn' : 'danger'}>${job.status === 'succeeded' ? '成功' : job.status === 'timed_out' ? '超时' : '失败'}</app-badge>`,
      exitCode: job.exitCode ?? '-',
      duration: `${job.durationMs} ms`,
      truncated: job.outputTruncated ? '是' : '否',
    }));
  }

  private renderConfig() {
    return html`
      <app-card class="config-card">
        <span slot="header">系统全局设置</span>
        ${this.config ? html`
          <div class="config-row">
            <div class="config-copy">
              <strong>Agent 沙箱代码执行</strong>
              <span id="sandbox-config-scope">此开关对平台中的所有 Agent 生效。Shell、Python 和 Node 代码只能通过隔离 Sandbox Controller 执行，不会直接运行在宿主机。执行审批由 Agent 安全策略控制。</span>
            </div>
            <label class="toggle" title=${this.config.enabled ? '禁用 Agent 沙箱代码执行' : '启用 Agent 沙箱代码执行'}>
              <input data-action="sandbox-toggle" type="checkbox" .checked=${this.config.enabled}
                .disabled=${this.configLoading || this.saving} @change=${this.onToggle}
                aria-label="Agent 沙箱代码执行全局开关" aria-describedby="sandbox-config-scope">
              <span class="toggle-track"></span>
            </label>
          </div>
        ` : nothing}
        ${this.configLoading ? html`<p class="config-feedback" role="status">正在读取全局设置…</p>`
          : !this.config ? html`<p class="config-feedback" role="alert">暂时无法读取全局设置，请刷新重试。</p>` : nothing}
      </app-card>`;
  }

  private renderStatus() {
    if (this.loading) return html`<p role="status">正在读取沙箱状态…</p>`;
    if (!this.response) return html`<app-card><app-empty-state role="alert" icon="circle-alert"
      title="暂时无法读取沙箱状态" description="当前无法确认沙箱是否可用，请重试读取。"></app-empty-state></app-card>`;
    if (!this.response.configured) return html`<app-card><app-empty-state icon="terminal" title="Sandbox Controller 未配置"
      description="沙箱当前不可用。请联系部署管理员核对 Controller 地址和签名密钥是否已按部署要求设置。"></app-empty-state></app-card>`;
    if (!this.response.reachable || !this.response.status) return html`<app-card><app-empty-state icon="circle-alert"
      title="Sandbox Controller 不可达" description="后端已配置 Controller，当前无法取得其运行状态。"></app-empty-state></app-card>`;
    const status = this.response.status;
    const ready = status.status === 'ok' && status.daemon.reachable && status.daemon.rootless
      && status.policy.runtimes.some((runtime) => CODE_RUNTIMES.has(runtime));
    return html`
        <div class="layout">
          <app-card><span slot="header">运行状态</span><div class="status-grid">
            <div class="metric"><span class="metric-label">执行环境</span><span class="metric-value"><app-badge variant=${ready ? 'ok' : 'warn'}>${ready ? '就绪' : '未就绪'}</app-badge></span></div>
            <div class="metric"><span class="metric-label">Controller</span><span class="metric-value"><app-badge variant="ok">可达</app-badge></span></div>
            <div class="metric"><span class="metric-label">Docker Daemon</span><span class="metric-value"><app-badge variant=${status.daemon.reachable ? 'ok' : 'danger'}>${status.daemon.reachable ? '可达' : '不可达'}</app-badge></span></div>
            <div class="metric"><span class="metric-label">Rootless</span><span class="metric-value"><app-badge variant=${status.daemon.rootless ? 'ok' : 'danger'}>${status.daemon.rootless ? '已启用' : '不合格'}</app-badge></span></div>
            <div class="metric"><span class="metric-label">并发作业</span><span class="metric-value">${status.activeJobs} / ${status.maxConcurrentJobs}</span></div>
          </div></app-card>
          <app-card><span slot="header">隔离策略</span><div class="policy-grid">
            <div class="policy-item"><span>网络</span><strong>${status.policy.network}</strong></div>
            <div class="policy-item"><span>根文件系统</span><strong>${status.policy.rootFilesystem}</strong></div>
            <div class="policy-item"><span>容器用户</span><strong>${status.policy.user}</strong></div>
            <div class="policy-item"><span>Linux Capabilities</span><strong>${status.policy.capabilities}</strong></div>
            <div class="policy-item"><span>No New Privileges</span><strong>${status.policy.noNewPrivileges ? '启用' : '未启用'}</strong></div>
            <div class="policy-item"><span>允许的 Runtime</span><strong>${status.policy.runtimes.join(', ') || '-'}</strong></div>
          </div><div class="limits">${Object.entries(status.policy.limits).map(([key, value]) => html`<span class="limit">${key}: ${value}</span>`)}</div></app-card>
          <app-card><span slot="header">近期作业</span><div class="table-wrap"><app-data-table .columns=${[{ key: 'createdAt', label: '时间' }, { key: 'jobId', label: '作业 ID' }, { key: 'runtime', label: 'Runtime' }, { key: 'status', label: '状态' }, { key: 'exitCode', label: '退出码' }, { key: 'duration', label: '耗时' }, { key: 'truncated', label: '输出截断' }]} .rows=${this.jobRows(status)} .loading=${false} .dense=${true} emptyMessage="暂无 Sandbox 作业"></app-data-table></div></app-card>
        </div>`;
  }

  override render() {
    if (!this.canView) return html`<app-empty-state role="status" title="无权读取沙箱状态"></app-empty-state>`;
    const settingsPath = settingsItemById('security')?.path;
    const configLink = `${inferBasePathFromPathname(window.location.pathname)}${settingsPath}?view=sandbox`;
    return html`
      <div class="page-header">
        <div><h1>Agent 沙箱</h1><p>查看 Controller、隔离策略和近期作业。</p></div>
        <div class="header-actions">
          ${this.statusOnly && this.canManage && settingsPath ? html`<a href=${configLink} class="btn">前往沙箱配置</a>` : nothing}
          <button type="button" class="btn btn-refresh" aria-busy=${String(this.loading)}
            aria-disabled=${String(this.loading)} @click=${this.refresh}>
            ${this.loading ? '读取中…' : this.response ? '刷新' : '重试读取'}
          </button>
        </div>
      </div>
      ${!this.statusOnly && this.canManage ? this.renderConfig() : nothing}
      ${this.renderStatus()}
      ${this.confirmEnable ? html`<app-dialog .open=${true} size="sm" title="启用 Agent 沙箱代码执行" @app-dialog-close=${() => { this.confirmEnable = false; }}>
        <p class="dialog-copy">启用后，Agent 可执行 Shell、Python 和 Node 代码，但所有执行必须经过隔离 Sandbox Controller，不会直接运行在宿主机。是否需要审批由 Agent 安全策略中的“执行审批”开关决定；Controller 不可用时将直接拒绝。</p>
        <div slot="footer"><button class="btn" @click=${() => { this.confirmEnable = false; }} .disabled=${this.saving}>取消</button><button class="btn-primary" data-action="confirm-enable" @click=${() => void this.saveConfig(true)} .disabled=${this.saving}>确认启用</button></div>
      </app-dialog>` : ''}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'agent-sandbox-status-page': AgentSandboxStatusPage } }
