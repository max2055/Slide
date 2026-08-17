import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { showToast } from '../components/app-toast-container.js';
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

@customElement('agent-sandbox-status-page')
export class AgentSandboxStatusPage extends LitElement {
  @state() private response: SandboxResponse | null = null;
  @state() private loading = true;
  @state() private config: SandboxConfigResponse | null = null;
  @state() private configLoading = true;
  @state() private saving = false;
  @state() private confirmEnable = false;

  static styles = [sharedBtnStyles, css`
    :host { display: block; color: var(--text); }
    .page-header, .status-grid, .policy-grid, .metric, .metric-value { display: flex; }
    .page-header { align-items: center; justify-content: space-between; gap: var(--space-lg); margin-bottom: var(--space-xl); }
    .page-header h1 { margin: 0 0 var(--space-xs); font-size: var(--text-xl); color: var(--text-strong); }
    .page-header p { margin: 0; color: var(--muted); font-size: var(--text-sm); }
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
    .config-copy { min-width: 0; }
    .config-copy strong { display: block; color: var(--text-strong); font-size: var(--text-base); }
    .config-copy span { display: block; margin-top: var(--space-xs); color: var(--muted); font-size: var(--text-sm); }
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
    void this.load();
  }

  private hasAdminAccess(): boolean {
    try {
      const raw = localStorage.getItem('permissions');
      if (!raw) return true;
      const permissions = JSON.parse(raw);
      return Array.isArray(permissions) && (permissions.includes('*') || permissions.includes('admin:*'));
    } catch {
      return false;
    }
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.configLoading = true;
    await Promise.all([
      apiClient.get<SandboxResponse>('/agent/security/sandbox')
        .then((response) => { this.response = response; })
        .catch(() => {
          this.response = null;
          showToast('加载 Sandbox Controller 状态失败', 'error');
        })
        .finally(() => { this.loading = false; }),
      (this.hasAdminAccess() ? apiClient.get<SandboxConfigResponse>('/agent/security/sandbox/config') : Promise.resolve(null))
        .then((config) => { this.config = config; })
        .catch(() => {
          this.config = null;
          showToast('加载 Agent Sandbox 设置失败', 'error');
        })
        .finally(() => { this.configLoading = false; }),
    ]);
  }

  private onToggle(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const enabled = input.checked;
    input.checked = this.config?.enabled === true;
    if (enabled) {
      this.confirmEnable = true;
      return;
    }
    void this.saveConfig(false);
  }

  private async saveConfig(enabled: boolean): Promise<void> {
    this.saving = true;
    try {
      this.config = await apiClient.put<SandboxConfigResponse>('/agent/security/sandbox/config', { enabled });
      this.confirmEnable = false;
      showToast(enabled ? 'Agent Sandbox 已启用' : 'Agent Sandbox 已禁用', 'success');
    } catch {
      showToast('更新 Agent Sandbox 设置失败', 'error');
    } finally {
      this.saving = false;
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

  override render() {
    const status = this.response?.status;
    return html`
      <div class="page-header"><div><h1>Agent Sandbox</h1><p>只读展示 Controller 健康、rootless 资格、不可变隔离策略和近期作业元数据</p></div><button class="btn-icon" title="刷新" aria-label="刷新" @click=${this.load} .disabled=${this.loading}>${icons.refresh}</button></div>
      ${this.hasAdminAccess() ? html`<div class="layout">
        <app-card><span slot="header">系统全局设置</span><div class="config-row">
          <div class="config-copy"><strong>Agent 任意代码执行</strong><span>仅允许经过审批的 Shell、Python 和 Node 代码通过隔离 Sandbox Controller 执行</span></div>
          <label class="toggle" title=${this.config?.enabled ? '禁用 Agent Sandbox' : '启用 Agent Sandbox'}>
            <input data-action="sandbox-toggle" type="checkbox" .checked=${this.config?.enabled === true} .disabled=${this.configLoading || this.saving || this.config === null} @change=${this.onToggle} aria-label="Agent Sandbox 全局开关">
            <span class="toggle-track"></span>
          </label>
        </div></app-card>
      </div>` : ''}
      ${this.loading ? html`<div class="skeleton"></div>` : !this.response?.configured ? html`<app-card><app-empty-state icon="terminal" title="Sandbox Controller 未配置" description="当前环境未设置 Controller 地址或签名密钥。生产环境必须通过部署配置启用。"></app-empty-state></app-card>` : !this.response.reachable || !status ? html`<app-card><app-empty-state icon="circle-alert" title="Sandbox Controller 不可达" description="后端已配置 Controller，但状态检查失败。"></app-empty-state></app-card>` : html`
        <div class="layout">
          <app-card><span slot="header">运行状态</span><div class="status-grid">
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
        </div>
      `}
      ${this.confirmEnable ? html`<app-dialog .open=${true} size="sm" title="启用 Agent Sandbox" @app-dialog-close=${() => { this.confirmEnable = false; }}>
        <p class="dialog-copy">启用后，Agent 可以在每次获得明确审批后执行 Shell、Python 和 Node 代码。所有执行必须经过隔离 Controller；Controller 不可用时将直接拒绝，不会在宿主机执行。</p>
        <div slot="footer"><button class="btn" @click=${() => { this.confirmEnable = false; }} .disabled=${this.saving}>取消</button><button class="btn-primary" data-action="confirm-enable" @click=${() => void this.saveConfig(true)} .disabled=${this.saving}>确认启用</button></div>
      </app-dialog>` : ''}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'agent-sandbox-status-page': AgentSandboxStatusPage } }
