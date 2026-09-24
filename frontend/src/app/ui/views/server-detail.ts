import "../components/semantic-metrics.js";
import "../components/metric-configuration.js";
import { returnToDashboard } from './dashboard-model.js';
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import * as echarts from "echarts";
import { icons } from "../../../icons.js";
import "../components/app-badge.js";
import "../components/app-card.js";
import "../components/app-empty-state.js";
import "../components/server-diagnostic-panel.js";
import { showToast } from "../components/app-toast-container.js";
import { authFetch } from "../../../api/index.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import type { HostedInstance, HostedInstancesResponse } from "../../../api/generated/public-api.js";
import type { ServerDiagnosticEvidence } from "../components/server-diagnostic-panel.js";

interface ServerDetail {
  id: number;
  host: string;
  port: number;
  label: string | null;
  os_type: string;
  credential_type: "password" | "key";
  status: "online" | "offline" | "error" | "unreachable";
  last_check_at: string | null;
  collection_enabled: number;
  created_at: string;
  updated_at: string;
}

@customElement("server-detail")
export class ServerDetailPage extends LitElement {
  static override styles = [sharedBtnStyles, css`
    :host { display: block; animation: fade-in 0.3s ease-out; }
    @keyframes fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes spinner { to { transform: rotate(360deg); } }

    .page {
      padding: 0;
      min-width: 0;
      max-width: 100%;
      overflow-x: hidden;
    }
    .loading { display:flex;align-items:center;justify-content:center;min-height:300px;color:var(--muted); }
    .loading-pulse { animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

    .header {
      display:flex;justify-content:space-between;align-items:center;
      flex-wrap:wrap;gap:var(--space-md);min-width:0;
      margin-bottom:var(--space-xl);padding-bottom:16px;border-bottom:1px solid var(--border);
    }
    .header-left { display:flex;align-items:center;gap:var(--space-lg);min-width:0;flex-wrap:wrap; }
    .header-left .btn svg { width:16px;height:16px;flex-shrink:0; }
    .title-copy { min-width:0; }

    .server-title { font-size:var(--text-2xl);font-weight:600;color:var(--text-strong);overflow-wrap:anywhere; }
    .server-subtitle { font-size:var(--text-sm);color:var(--muted);margin-top:var(--space-xs);overflow-wrap:anywhere; }

    .header-right { display:flex;align-items:center;gap:var(--space-md);min-width:0;flex-wrap:wrap; }
    .last-updated { font-size:var(--text-sm);color:var(--muted); }
    .tabs {
      display:flex;gap:var(--space-xs);margin-bottom:var(--space-xl);
      border-bottom:1px solid var(--border);overflow-x:auto;
    }
    .tab {
      padding:var(--space-md) var(--space-xl);font-size:var(--text-md);font-weight:500;
      color:var(--muted);background:transparent;border:none;
      border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;
    }
    .tab:hover { color:var(--text); }
    .tab.active { color:var(--accent-text);border-bottom-color:var(--accent); }

    /* Status section */
    .status-grid {
      display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:var(--space-md);
    }
    .status-item {
      padding:var(--space-md) 0;
      border-bottom:1px solid var(--border);
    }
    .status-item:last-child { border-bottom:none; }
    .status-label { font-size:var(--text-sm);color:var(--muted);margin-bottom:var(--space-xs); }
    .status-value { font-size:var(--text-md);color:var(--text-strong);font-weight:500; }

    /* Config section */
    .config-grid {
      display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:var(--space-md);
    }
    .config-item { padding:var(--space-md) 0;border-bottom:1px solid var(--border); }
    .config-label { font-size:var(--text-sm);color:var(--muted);margin-bottom:var(--space-xs); }
    .config-value { font-size:var(--text-md);color:var(--text-strong); }

    /* Spinner for chart loading */
    .spinner { width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spinner 0.8s linear infinite;display:inline-block; }
    .hosted-card { display:block;margin-top:var(--space-lg);min-width:0; }
    .hosted-list { display:grid;gap:var(--space-sm);min-width:0; }
    .hosted-instance {
      display:grid;
      grid-template-columns:minmax(0, 1fr) auto auto;
      align-items:center;
      gap:var(--space-md);
      min-width:0;
      padding:var(--space-md) 0;
      border-bottom:1px solid var(--border);
    }
    .hosted-instance:last-child { border-bottom:0; }
    .hosted-copy { display:flex;flex-direction:column;gap:var(--space-xs);min-width:0; }
    .hosted-name { color:var(--text-strong);font-size:var(--text-md);font-weight:600;overflow-wrap:anywhere; }
    .hosted-meta { color:var(--muted);font-size:var(--text-xs);overflow-wrap:anywhere; }
    .hosted-badges { display:flex;align-items:center;justify-content:flex-end;gap:var(--space-sm);flex-wrap:wrap; }
    .hosted-error { display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-md);padding:var(--space-md);border:1px solid var(--danger);border-radius:var(--radius-sm);background:var(--danger-subtle);color:var(--danger);font-size:var(--text-sm);overflow-wrap:anywhere; }
    .hosted-skeleton { display:grid;gap:var(--space-sm); }
    .hosted-skeleton-row { min-height:52px;border-radius:var(--radius-sm); }
    .skeleton { background:var(--skeleton,var(--border));animation:pulse 1.5s ease-in-out infinite; }
    .hosted-instance .btn-ghost svg { width:16px;height:16px; }
    .header-right .btn svg,.header-right .btn-primary svg { width:16px;height:16px;flex-shrink:0; }

    @media (max-width: 600px) {
      :host { max-width:100%;overflow-x:hidden; }
      .header { align-items:flex-start; }
      .header-left,.header-right { width:100%;min-width:0; }
      .header-right { align-items:flex-start; }
      .last-updated { width:100%; }
      .status-grid,.config-grid { grid-template-columns:minmax(0, 1fr); }
      .status-item,.config-item { min-width:0; }
      .tabs { max-width:100%;flex-wrap:wrap; }
      .hosted-instance { grid-template-columns:minmax(0, 1fr);align-items:flex-start; }
      .hosted-badges { justify-content:flex-start; }
      .hosted-instance .btn-ghost { justify-self:start; }
    }
  `];

  @property({ type: Number }) serverId: number | null = null;
  @state() private server: ServerDetail | null = null;
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private activeTab: string = new URL(location.href).searchParams.get('metricResource')?.startsWith('server:') ? 'metrics' : 'overview' ;
  @state() private lastUpdated: Date | null = null;
  @state() private isRefreshing = false;
  @state() private hostedInstances: HostedInstance[] = [];
  @state() private hostedInstancesLoading = false;
  @state() private hostedInstancesError: string | null = null;
  @state() private diagnostics: ServerDiagnosticEvidence | null = null;
  @state() private diagnosticsLoading = false;
  @state() private diagnosticsError: string | null = null;
  @state() private diagnosticsCollecting = false;
  private _navHandler: ((e: any) => void) | null = null;
  private contextVersion = 0;

  override firstUpdated() {
    this._navHandler = (e: any) => {
      if (e.detail.tab === "server-detail" && e.detail.serverId != null) {
        this.serverId = Number(e.detail.serverId);
        this.activeTab = "overview";
      }
    };
    window.addEventListener("slide-navigate", this._navHandler);
    this.loadFromUrl();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("serverId")) {
      const id = this.serverId;
      if (id != null && Number.isInteger(id) && id > 0) {
        queueMicrotask(() => {
          if (this.serverId === id) void this.loadServerContext(id);
        });
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._navHandler) {
      window.removeEventListener("slide-navigate", this._navHandler);
      this._navHandler = null;
    }
  }

  private loadFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    const tab = params.get("tab");
    if (id && (tab === "server-detail" || location.pathname === "/server-detail") && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))) {
      this.serverId = Number(id);
    }
  }

  private async loadServerContext(id: number): Promise<void> {
    const version = ++this.contextVersion;
    this.server = null;
    this.error = null;
    this.loading = true;
    void this.loadHostedInstances(id, version);
    await this.loadServer(id, version);
    if (version === this.contextVersion) {
      this.lastUpdated = new Date();
      this.loading = false;
    }
  }

  private async loadServer(id: number, version = this.contextVersion) {
    try {
      const res = await authFetch(`/api/servers/${id}`);
      if (res.ok) {
        const server = await res.json();
        if (version === this.contextVersion) this.server = server;
      }
      else {
        if (version === this.contextVersion) this.error = "获取服务器详情失败";
      }
    } catch (err: any) {
      if (version === this.contextVersion) this.error = err.message;
    }
  }

  private async loadHostedInstances(id: number, version = this.contextVersion): Promise<void> {
    this.hostedInstances = [];
    this.hostedInstancesLoading = true;
    this.hostedInstancesError = null;
    try {
      const response = await authFetch(`/api/servers/${id}/instances`);
      if (!response.ok) {
        throw new Error(response.status === 401 || response.status === 403
          ? "没有权限查看该服务器托管的数据库实例"
          : "托管数据库实例加载失败");
      }
      const data = await response.json() as HostedInstancesResponse;
      if (version === this.contextVersion) this.hostedInstances = data.instances;
    } catch (error) {
      if (version === this.contextVersion) {
        this.hostedInstancesError = error instanceof Error ? error.message : "托管数据库实例加载失败";
      }
    } finally {
      if (version === this.contextVersion) this.hostedInstancesLoading = false;
    }
  }

  private async loadDiagnostics(id: number, version = this.contextVersion): Promise<void> {
    this.diagnosticsLoading = true;
    this.diagnosticsError = null;
    try {
      const response = await authFetch(`/api/servers/${id}/diagnostics`);
      if (response.status === 404) {
        // Older backends may not expose the optional evidence route yet.
        if (version === this.contextVersion) this.diagnostics = null;
        return;
      }
      if (!response.ok) throw new Error("服务器诊断证据加载失败");
      const payload = await response.json();
      const evidence = payload?.evidence ?? payload;
      if (version === this.contextVersion) this.diagnostics = evidence as ServerDiagnosticEvidence;
    } catch (error) {
      if (version === this.contextVersion) {
        this.diagnosticsError = error instanceof Error ? error.message : "服务器诊断证据加载失败";
      }
    } finally {
      if (version === this.contextVersion) this.diagnosticsLoading = false;
    }
  }

  private async collectDiagnostics() {
    if (!this.serverId || this.diagnosticsCollecting) return;
    this.diagnosticsCollecting = true;
    try {
      const response = await authFetch(`/api/servers/${this.serverId}/collect-diagnostics`, { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "诊断采集失败");
      }
      await this.loadDiagnostics(this.serverId);
      showToast("诊断证据已更新", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "诊断采集失败", "error");
    } finally {
      this.diagnosticsCollecting = false;
    }
  }

  private async refreshCurrentTab() {
    if (!this.serverId || this.isRefreshing) return;
    this.isRefreshing = true;
    const serverId = this.serverId;
    const hostedRefresh = this.loadHostedInstances(serverId);
    try {
      const serverRes = await authFetch(`/api/servers/${serverId}`);
      if (serverRes.ok) this.server = await serverRes.json();
      this.lastUpdated = new Date();
      if (["network", "processes", "services", "logs"].includes(this.activeTab)) await this.loadDiagnostics(serverId);
    } catch (err: any) {
      console.warn('[server-detail] refresh failed:', err);
      showToast(err.message || '刷新失败', 'error');
    }
    finally {
      await hostedRefresh;
      this.isRefreshing = false;
    }
  }

  private _goBack() { if (returnToDashboard()) return;
    window.dispatchEvent(new CustomEvent("slide-navigate", {
      detail: { tab: "servers" },
    }));
  }

  private async _oneClickInspection() {
    if (!this.serverId) return;
    try {
      const res = await authFetch(`/api/servers/reports/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: this.serverId }),
      });
      if (res.ok) {
        showToast('巡检报告已生成', 'success');
        window.dispatchEvent(new CustomEvent("slide-navigate", {
          detail: { tab: "reports" },
        }));
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || '巡检失败', 'error');
      }
    } catch (err: any) {
      showToast(err.message || '巡检失败', 'error');
    }
  }

  private _viewInstance(instanceId: number) {
    window.dispatchEvent(new CustomEvent("slide-navigate", {
      detail: { tab: "instance-detail", id: instanceId },
    }));
  }

  private _setTab(tab: string) {
    const configuration = this.renderRoot.querySelector('metric-configuration') as import('../components/metric-configuration.js').MetricConfiguration | null;
    if (configuration) { configuration.confirmDiscard(() => this._applyTab(tab)); return; }
    this._applyTab(tab);
  }
  private _applyTab(tab: string) {
    this.activeTab = tab;
    if (["diagnostics", "network", "processes", "services", "logs"].includes(tab) && this.serverId && !this.diagnostics) {
      this.loadDiagnostics(this.serverId);
    }
  }

  private _formatTimeAgo(date: Date | null): string {
    if (!date) return "从未更新";
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return "刚刚更新";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    return `${Math.floor(seconds / 3600)} 小时前`;
  }

  private _statusBadgeVariant(status: string) {
    switch (status) {
      case "online": return "ok";
      case "offline": return "muted";
      case "error": return "danger";
      case "unreachable": return "warn";
      default: return "muted";
    }
  }

  private _statusLabel(status: string) {
    switch (status) {
      case "online": return "在线";
      case "offline": return "离线";
      case "error": return "异常";
      case "unreachable": return "不可达";
      default: return status;
    }
  }

  // ── Render ──

  override render() {
    if (this.loading && !this.server) {
      return html`<div class="page"><div class="loading loading-pulse">加载中...</div></div>`;
    }
    if (this.error) {
      return html`<div class="page"><div class="loading">${this.error}</div></div>`;
    }
    if (!this.server) {
      return html`<div class="page"><div class="loading">服务器不存在</div></div>`;
    }

    return html`
      <div class="page">
        <div class="header">
          <div class="header-left">
            <button class="btn" @click=${this._goBack}>${icons['chevron-left']} 返回列表</button>
            <div class="title-copy">
              <span class="server-title">${this.server.host}</span>
              ${this.server.label
                ? html`<div class="server-subtitle">${this.server.label}</div>`
                : nothing}
            </div>
            <app-badge variant=${this._statusBadgeVariant(this.server.status)}>
              ${this._statusLabel(this.server.status)}
            </app-badge>
          </div>
          <div class="header-right">
            <span class="last-updated">${this._formatTimeAgo(this.lastUpdated)}</span>
            <button class="btn" @click=${() => this._oneClickInspection()} .disabled=${this.isRefreshing}>${icons['clipboard']} 一键巡检</button>
            <button class="btn-primary" @click=${this.refreshCurrentTab} .disabled=${this.isRefreshing}>
              ${this.isRefreshing ? html`<span class="spinner" style="width:14px;height:14px;border-width:1.5px;"></span>` : icons['refresh']} 刷新
            </button>
          </div>
        </div>

        <div class="tabs">
          ${[
            { key: "overview", label: "概览" },
            { key: "collection", label: "采集配置" },
            { key: "metrics", label: "指标与趋势" },
            { key: "config", label: "配置" },
            { key: "diagnostics", label: "诊断" },
            { key: "network", label: "网络" },
            { key: "processes", label: "进程" },
            { key: "services", label: "服务" },
            { key: "logs", label: "日志" },
            { key: "related", label: "关联资源" },
          ].map(t => html`
            <button class="tab ${this.activeTab === t.key ? "active" : ""}" @click=${() => this._setTab(t.key)}>
              ${t.label}
            </button>
          `)}
        </div>

        ${this._renderTabContent()}
      </div>
    `;
  }

  private _renderTabContent() {
    if (this.activeTab === "collection") return html`<metric-configuration resourceType="server" .resourceId=${this.serverId}></metric-configuration>`;
    switch (this.activeTab) {
      case "overview": return this._renderOverview();
      case "metrics": return html`<semantic-metrics resourceType="server" .resourceId=${this.serverId}></semantic-metrics>`;
      case "config": return this._renderConfig();
      case "diagnostics": return this._renderDiagnosticSection(null);
      case "network": return this._renderDiagnosticSection("network");
      case "processes": return this._renderDiagnosticSection("processes");
      case "services": return this._renderDiagnosticSection("services");
      case "logs": return this._renderDiagnosticSection("logs");
      case "related": return this._renderRelatedResources();
      default: return this._renderOverview();
    }
  }

  private _renderDiagnosticSection(section: string | null) {
    return html`
      <app-card>
        <span slot="header">${section === "network" ? "网络证据" : section === "processes" ? "进程证据" : section === "services" ? "服务证据" : section === "logs" ? "系统日志" : "服务器诊断证据"}</span>
        <server-diagnostic-panel
          .evidence=${this.diagnostics}
          .loading=${this.diagnosticsLoading}
          .error=${this.diagnosticsError}
          .sectionFilter=${section}
        ></server-diagnostic-panel>
        <div slot="footer">
          <button class="btn" type="button" @click=${this.collectDiagnostics} .disabled=${this.diagnosticsCollecting}>
            ${this.diagnosticsCollecting ? "采集中…" : "采集诊断证据"}
          </button>
        </div>
      </app-card>
    `;
  }

  private _renderRelatedResources() {
    return html`
      <app-card>
        <span slot="header">关联资源</span>
        ${this._renderHostedInstances()}
      </app-card>
    `;
  }

  private _renderOverview() {
    return html`
      <semantic-metrics resourceType="server" .resourceId=${this.serverId}></semantic-metrics>
      <app-card>
        <span slot="header">服务器状态</span>
        <div class="status-grid">
          <div class="status-item">
            <div class="status-label">操作系统</div>
            <div class="status-value">${this.server!.os_type}</div>
          </div>
          <div class="status-item">
            <div class="status-label">连接状态</div>
            <div class="status-value">
              <app-badge variant=${this._statusBadgeVariant(this.server!.status)}>
                ${this._statusLabel(this.server!.status)}
              </app-badge>
            </div>
          </div>
          <div class="status-item">
            <div class="status-label">上次采集</div>
            <div class="status-value">${this._formatLastCheck()}</div>
          </div>
        </div>
      </app-card>

      <app-card class="hosted-card">
        <span slot="header">托管数据库实例</span>
        ${this._renderHostedInstances()}
      </app-card>
    `;
  }

  private _renderHostedInstances() {
    if (this.hostedInstancesLoading) {
      return html`
        <div class="hosted-skeleton" aria-label="托管数据库实例加载中">
          <div class="hosted-skeleton-row skeleton"></div>
          <div class="hosted-skeleton-row skeleton"></div>
        </div>
      `;
    }
    if (this.hostedInstancesError) {
      return html`
        <div class="hosted-error" role="alert">
          <span>${this.hostedInstancesError}</span>
          <button class="btn" type="button" @click=${() => this.serverId && this.loadHostedInstances(this.serverId)}>重试</button>
        </div>
      `;
    }
    if (this.hostedInstances.length === 0) {
      return html`
        <app-empty-state
          title="暂无托管实例"
          description="当前服务器没有已知的数据库实例关联关系"
          icon="database"
        ></app-empty-state>
      `;
    }
    return html`
      <div class="hosted-list">
        ${this.hostedInstances.map((instance) => html`
          <div class="hosted-instance">
            <div class="hosted-copy">
              <span class="hosted-name">${instance.name}</span>
              <span class="hosted-meta">${instance.dbType.toUpperCase()} · ${instance.environment || '未标注环境'} · ${instance.status}</span>
            </div>
            <div class="hosted-badges">
              <app-badge variant="info">${this._roleLabel(instance.role)}</app-badge>
              <app-badge variant=${this._healthVariant(instance.healthStatus)}>${instance.healthStatus}</app-badge>
            </div>
            <button
              class="btn-ghost"
              type="button"
              data-instance-id=${instance.instanceId}
              title="查看实例详情"
              aria-label="查看 ${instance.name} 详情"
              @click=${() => this._viewInstance(instance.instanceId)}
            >${icons['chevron-right']}</button>
          </div>
        `)}
      </div>
    `;
  }

  private _healthVariant(status: string): "ok" | "danger" | "warn" | "muted" {
    if (status === "healthy") return "ok";
    if (status === "critical") return "danger";
    if (status === "warning") return "warn";
    return "muted";
  }

  private _roleLabel(role: string): string {
    const labels: Record<string, string> = {
      standalone: "独立节点",
      primary: "主节点",
      replica: "副本",
      shard: "分片",
      arbiter: "仲裁节点",
      unknown: "未知角色",
    };
    return labels[role] || role;
  }

  private _renderConfig() {
    if (!this.server) return nothing;

    return html`
      <app-card>
        <span slot="header">服务器配置</span>
        <div class="config-grid">
          <div class="config-item">
            <div class="config-label">主机地址</div>
            <div class="config-value">${this.server.host}</div>
          </div>
          <div class="config-item">
            <div class="config-label">SSH 端口</div>
            <div class="config-value">${this.server.port}</div>
          </div>
          <div class="config-item">
            <div class="config-label">标签</div>
            <div class="config-value">${this.server.label || "--"}</div>
          </div>
          <div class="config-item">
            <div class="config-label">操作系统</div>
            <div class="config-value">${this.server.os_type}</div>
          </div>
          <div class="config-item">
            <div class="config-label">认证方式</div>
            <div class="config-value">${this.server.credential_type === "password" ? "密码" : "SSH密钥"}</div>
          </div>
          <div class="config-item">
            <div class="config-label">采集状态</div>
            <div class="config-value">${this.server.collection_enabled ? "已启用" : "已禁用"}</div>
          </div>
          <div class="config-item" style="grid-column:1/-1;">
            <div class="config-label">上次采集时间</div>
            <div class="config-value">${this._formatLastCheck()}</div>
          </div>
        </div>
      </app-card>
    `;
  }

  private _formatLastCheck(): string {
    if (!this.server || !this.server.last_check_at) return "从未采集";
    const d = new Date(this.server.last_check_at);
    return d.toLocaleString("zh-CN");
  }
}

if (!customElements.get("server-detail")) {
  customElements.define("server-detail", ServerDetailPage);
}
