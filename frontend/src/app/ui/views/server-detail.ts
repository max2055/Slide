import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import * as echarts from "echarts";
import { icons } from "../../../icons.js";
import "../components/metric-chart.js";
import "../components/app-badge.js";
import "../components/app-card.js";
import "../components/app-empty-state.js";
import { showToast } from "../components/app-toast-container.js";
import { authFetch } from "../../../api/index.js";
import { aggregateServerDiskUsage } from "./server-metric-utils.js";

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

interface MetricEntry {
  server_id: number;
  metric_name: string;
  metric_value: number;
  recorded_at: string;
  dimensions?: Record<string, unknown> | string | null;
}

@customElement("server-detail")
export class ServerDetailPage extends LitElement {
  static override styles = css`
    :host { display: block; animation: fade-in 0.3s ease-out; }
    @keyframes fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes spinner { to { transform: rotate(360deg); } }

    .page { padding: 0; }
    .loading { display:flex;align-items:center;justify-content:center;min-height:300px;color:var(--muted); }
    .loading-pulse { animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

    .header {
      display:flex;justify-content:space-between;align-items:center;
      margin-bottom:var(--space-xl);padding-bottom:16px;border-bottom:1px solid var(--border);
    }
    .header-left { display:flex;align-items:center;gap:var(--space-lg); }
    .back-btn {
      display:inline-flex;align-items:center;gap:var(--space-sm);
      padding:var(--space-sm) var(--space-md);border:1px solid var(--border);border-radius:var(--radius-md);
      font-size:var(--text-base);font-weight:500;color:var(--text);background:var(--secondary);cursor:pointer;
    }
    .back-btn:hover { background:var(--bg-hover);border-color:var(--border-strong); }
    .back-btn svg { width:16px;height:16px;flex-shrink:0; }

    .server-title { font-size:var(--text-2xl);font-weight:600;color:var(--text-strong); }
    .server-subtitle { font-size:var(--text-sm);color:var(--muted);margin-top:var(--space-xs); }

    .header-right { display:flex;align-items:center;gap:var(--space-md); }
    .last-updated { font-size:var(--text-sm);color:var(--muted); }
    .refresh-btn {
      display:inline-flex;align-items:center;gap:var(--space-sm);
      padding:var(--space-sm) var(--space-md);border:1px solid var(--accent);border-radius:var(--radius-sm);
      font-size:var(--text-sm);font-weight:500;color:var(--accent);background:transparent;cursor:pointer;
    }
    .refresh-btn:hover { background:var(--accent);color:var(--accent-foreground); }
    .refresh-btn:disabled { opacity:0.6;cursor:not-allowed; }

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
    .tab.active { color:var(--accent);border-bottom-color:var(--accent); }

    /* Summary cards grid */
    .summary-grid {
      display:grid;grid-template-columns:repeat(2, 1fr);gap:var(--space-md);
      margin-bottom:var(--space-xl);
    }
    .summary-card { text-align:center;padding:var(--space-lg); }
    .summary-value { font-size:var(--text-2xl);font-weight:700;color:var(--text-strong); }
    .summary-unit { font-size:var(--text-sm);color:var(--muted);margin-left:var(--space-xs); }
    .summary-label { font-size:var(--text-md);color:var(--muted);margin-top:var(--space-sm); }
    .summary-sub { font-size:var(--text-sm);color:var(--muted);margin-top:var(--space-xs); }

    .metric-value-ok { color:var(--ok); }
    .metric-value-warn { color:var(--warn); }
    .metric-value-danger { color:var(--danger); }

    /* Status section */
    .status-grid {
      display:grid;grid-template-columns:1fr 1fr;gap:var(--space-md);
    }
    .status-item {
      padding:var(--space-md) 0;
      border-bottom:1px solid var(--border);
    }
    .status-item:last-child { border-bottom:none; }
    .status-label { font-size:var(--text-sm);color:var(--muted);margin-bottom:var(--space-xs); }
    .status-value { font-size:var(--text-md);color:var(--text-strong);font-weight:500; }

    /* Time range selector */
    .range-selector {
      display:flex;gap:var(--space-xs);margin-bottom:var(--space-md);
    }
    .range-btn {
      padding:var(--space-sm) var(--space-md);border:1px solid var(--border);border-radius:var(--radius-sm);
      font-size:var(--text-sm);font-weight:500;color:var(--muted);background:var(--secondary);
      cursor:pointer;transition:all 0.15s ease;
    }
    .range-btn:hover { border-color:var(--accent);color:var(--accent); }
    .range-btn.active { background:var(--accent);color:var(--accent-foreground);border-color:var(--accent); }

    /* Config section */
    .config-grid {
      display:grid;grid-template-columns:1fr 1fr;gap:var(--space-md);
    }
    .config-item { padding:var(--space-md) 0;border-bottom:1px solid var(--border); }
    .config-label { font-size:var(--text-sm);color:var(--muted);margin-bottom:var(--space-xs); }
    .config-value { font-size:var(--text-md);color:var(--text-strong); }

    /* Chart wrapper */
    .chart-wrapper { margin-top:var(--space-md); }
    .chart-empty {
      display:flex;align-items:center;justify-content:center;
      min-height:200px;color:var(--muted);font-size:var(--text-md);
    }

    /* Spinner for chart loading */
    .spinner { width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spinner 0.8s linear infinite;display:inline-block; }
  `;

  @state() private serverId: number | null = null;
  @state() private server: ServerDetail | null = null;
  @state() private metrics: MetricEntry[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private activeTab: string = "overview";
  @state() private activeRange: string = "1h";
  @state() private historyLoading = false;
  @state() private historyData: { time: string[]; metrics: Record<string, number[]> } | null = null;
  @state() private lastUpdated: Date | null = null;
  @state() private isRefreshing = false;
  private _navHandler: ((e: any) => void) | null = null;

  override firstUpdated() {
    this._navHandler = (e: any) => {
      if (e.detail.tab === "server-detail" && e.detail.serverId != null) {
        this.serverId = Number(e.detail.serverId);
        this.activeTab = "overview";
        this.loadServer(this.serverId);
        this.loadLatestMetrics(this.serverId);
      }
    };
    window.addEventListener("slide-navigate", this._navHandler);
    // Also try reading URL params
    this.loadFromUrl();
    // If serverId was set via property binding (not URL/event), load directly
    if (this.serverId && !this.server) {
      this.loadServer(this.serverId);
      this.loadLatestMetrics(this.serverId);
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
    if (id && tab === "server-detail") {
      this.serverId = parseInt(id, 10);
      this.loadServer(this.serverId);
      this.loadLatestMetrics(this.serverId);
    }
  }

  private async loadServer(id: number) {
    try {
      const res = await authFetch(`/api/servers/${id}`);
      if (res.ok) this.server = await res.json();
      else {
        this.error = "获取服务器详情失败";
        this.loading = false;
      }
    } catch (err: any) {
      this.error = err.message;
      this.loading = false;
    }
  }

  private async loadLatestMetrics(id: number) {
    try {
      const res = await authFetch(`/api/servers/${id}/metrics`);
      if (res.ok) {
        const data = await res.json();
        this.metrics = data.metrics || [];
      }
      this.lastUpdated = new Date();

      // Load history for current range if on metrics tab
      if (this.activeTab === "metrics") {
        await this.loadMetricHistory(id, this.activeRange);
      }

      this.loading = false;
    } catch (err: any) {
      if (!this.error) {
        this.error = err.message;
        showToast(err.message || "加载失败", "error");
      }
      this.loading = false;
    }
  }

  private async loadMetricHistory(id: number, range: string) {
    this.historyLoading = true;
    try {
      const res = await authFetch(
        `/api/servers/${id}/metrics/history?range=${range}`
      );
      if (res.ok) {
        const data = await res.json();
        const metrics = data.metrics || [];

        // Group by metric_name, extract time/value arrays
        const timeMap = new Map<string, string[]>();
        const valueMap = new Map<string, number[]>();

        for (const entry of metrics) {
          const name = entry.metric_name;
          const time = entry.recorded_at ? entry.recorded_at.substring(0, 16).replace("T", " ") : "";
          const val = Number(entry.metric_value);
          if (!timeMap.has(name)) timeMap.set(name, []);
          if (!valueMap.has(name)) valueMap.set(name, []);
          timeMap.get(name)!.push(time);
          valueMap.get(name)!.push(val);
        }

        // Use the first metric's time array as the common time axis
        const firstKey = timeMap.keys().next().value;
        const commonTime = firstKey ? timeMap.get(firstKey) || [] : [];

        this.historyData = { time: commonTime, metrics: Object.fromEntries(valueMap) };
      }
    } catch (err: any) {
      // Silently fail for history
    } finally {
      this.historyLoading = false;
    }
  }

  private async refreshCurrentTab() {
    if (!this.serverId || this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      const [serverRes, metricsRes] = await Promise.all([
        authFetch(`/api/servers/${this.serverId}`),
        authFetch(`/api/servers/${this.serverId}/metrics`),
      ]);
      if (serverRes.ok) this.server = await serverRes.json();
      if (metricsRes.ok) {
        const d = await metricsRes.json();
        this.metrics = d.metrics || [];
      }
      this.lastUpdated = new Date();
      if (this.activeTab === "metrics") await this.loadMetricHistory(this.serverId, this.activeRange);
    } catch (err: any) {
      console.warn('[server-detail] refresh failed:', err);
      showToast(err.message || '刷新失败', 'error');
    }
    finally { this.isRefreshing = false; }
  }

  private _goBack() {
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

  private _viewAlerts() {
    if (!this.serverId) return;
    window.dispatchEvent(new CustomEvent("slide-navigate", {
      detail: { tab: "alerts", serverId: this.serverId },
    }));
  }

  private _setTab(tab: string) {
    if (tab === 'alerts' && this.serverId) {
      this._viewAlerts();
      return;
    }
    this.activeTab = tab;
    if (tab === "metrics" && this.serverId) {
      this.loadMetricHistory(this.serverId, this.activeRange);
    }
  }

  private _setRange(range: string) {
    this.activeRange = range;
    if (this.serverId) this.loadMetricHistory(this.serverId, range);
  }

  private _usageVariant(value: number | null): string {
    if (value === null) return "muted";
    if (value >= 80) return "danger";
    if (value >= 50) return "warn";
    return "ok";
  }

  private _metricValue(name: string): number | null {
    const entry = this.metrics.find(m => m.metric_name === name);
    return entry ? entry.metric_value : null;
  }

  private _aggregateDiskUsage(): number | null {
    return aggregateServerDiskUsage(this.metrics);
  }

  private _formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
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
            <button class="back-btn" @click=${this._goBack}>${icons['chevron-left']} 返回列表</button>
            <div>
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
            <button class="action-btn" style="display:inline-flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm) var(--space-md);border:1px solid var(--accent);border-radius:var(--radius-sm);font-size:var(--text-sm);font-weight:500;color:var(--accent);background:transparent;cursor:pointer;" @click=${() => this._oneClickInspection()} ?disabled=${this.isRefreshing}>一键巡检</button>
            <button class="action-btn" style="display:inline-flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm) var(--space-md);border:1px solid var(--warn);border-radius:var(--radius-sm);font-size:var(--text-sm);font-weight:500;color:var(--warn);background:transparent;cursor:pointer;" @click=${() => this._viewAlerts()}>查看告警</button>
            <button class="refresh-btn" @click=${this.refreshCurrentTab} ?disabled=${this.isRefreshing}>
              ${this.isRefreshing ? html`<span class="spinner" style="width:14px;height:14px;border-width:1.5px;"></span>` : icons['refresh']} 刷新
            </button>
          </div>
        </div>

        <div class="tabs">
          ${[
            { key: "overview", label: "概览" },
            { key: "metrics", label: "指标" },
            { key: "config", label: "配置" },
            { key: "alerts", label: "告警" },
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
    switch (this.activeTab) {
      case "overview": return this._renderOverview();
      case "metrics": return this._renderMetrics();
      case "config": return this._renderConfig();
      default: return this._renderOverview();
    }
  }

  private _renderOverview() {
    const cpu = this._metricValue("cpu_usage");
    const mem = this._metricValue("memory_usage");
    const memUsed = this._metricValue("memory_used");
    const memTotal = this._metricValue("memory_total");
    const disk = this._aggregateDiskUsage();
    const load1 = this._metricValue("load_1min");
    const load5 = this._metricValue("load_5min");
    const load15 = this._metricValue("load_15min");
    const uptime = this._metricValue("uptime");

    return html`
      <!-- Summary cards -->
      <div class="summary-grid">
        <app-card variant="bordered">
          <div class="summary-card">
            <div class="summary-value ${this._usageVariant(cpu)}">
              ${cpu != null ? cpu.toFixed(1) : "--"}<span class="summary-unit">%</span>
            </div>
            <div class="summary-label">CPU 使用率</div>
          </div>
        </app-card>
        <app-card variant="bordered">
          <div class="summary-card">
            <div class="summary-value ${this._usageVariant(mem)}">
              ${mem != null ? mem.toFixed(1) : "--"}<span class="summary-unit">%</span>
            </div>
            <div class="summary-label">内存使用率</div>
            ${memUsed != null && memTotal != null
              ? html`<div class="summary-sub">${this._formatBytes(memUsed)} / ${this._formatBytes(memTotal)}</div>`
              : nothing}
          </div>
        </app-card>
        <app-card variant="bordered">
          <div class="summary-card">
            <div class="summary-value ${this._usageVariant(disk)}">
              ${disk != null ? disk.toFixed(1) : "--"}<span class="summary-unit">%</span>
            </div>
            <div class="summary-label">磁盘使用率</div>
          </div>
        </app-card>
        <app-card variant="bordered">
          <div class="summary-card">
            <div class="summary-value">
              ${load1 != null ? load1.toFixed(2) : "--"}
            </div>
            <div class="summary-label">系统负载</div>
            ${load5 != null && load15 != null
              ? html`<div class="summary-sub">1min: ${load1?.toFixed(2) || "--"} / 5min: ${load5.toFixed(2)} / 15min: ${load15.toFixed(2)}</div>`
              : nothing}
          </div>
        </app-card>
      </div>

      <!-- Status section -->
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
            <div class="status-label">运行时间</div>
            <div class="status-value">${uptime != null ? `${Math.floor(uptime / 3600)} 小时 ${Math.floor((uptime % 3600) / 60)} 分钟` : "--"}</div>
          </div>
          <div class="status-item">
            <div class="status-label">上次采集</div>
            <div class="status-value">${this._formatLastCheck()}</div>
          </div>
        </div>
      </app-card>
    `;
  }

  private _renderMetrics() {
    const cpu = this._metricValue("cpu_usage");
    const mem = this._metricValue("memory_usage");

    // Build series data for metric-chart
    const series: { name: string; data: number[]; color?: string }[] = [];
    if (this.historyData) {
      const metrics = this.historyData.metrics;
      if (metrics.cpu_usage) {
        series.push({ name: "CPU", data: metrics.cpu_usage, color: "#3b82f6" });
      }
      if (metrics.memory_usage) {
        series.push({ name: "内存", data: metrics.memory_usage, color: "#22c55e" });
      }
      if (metrics.load_1min) {
        series.push({ name: "Load 1min", data: metrics.load_1min, color: "#f59e0b" });
      }
      if (metrics.load_5min) {
        series.push({ name: "Load 5min", data: metrics.load_5min, color: "#f97316" });
      }
      if (metrics.load_15min) {
        series.push({ name: "Load 15min", data: metrics.load_15min, color: "#ef4444" });
      }
    }

    return html`
      <!-- Current values -->
      <div style="display:flex;gap:var(--space-md);margin-bottom:var(--space-md);flex-wrap:wrap;">
        <app-badge variant=${this._usageVariant(cpu)}>CPU ${cpu != null ? cpu.toFixed(1) + "%" : "--"}</app-badge>
        <app-badge variant=${this._usageVariant(mem)}>内存 ${mem != null ? mem.toFixed(1) + "%" : "--"}</app-badge>
      </div>

      <div class="range-selector">
        ${["1h", "6h", "24h", "7d", "30d"].map(r => html`
          <button class="range-btn ${this.activeRange === r ? "active" : ""}" @click=${() => this._setRange(r)}>
            ${r === "1h" ? "1小时" : r === "6h" ? "6小时" : r === "24h" ? "24小时" : r === "7d" ? "7天" : "30天"}
          </button>
        `)}
      </div>

      <div class="chart-wrapper">
        ${this.historyLoading
          ? html`<div class="chart-empty"><span class="spinner" style="margin-right:8px;"></span> 加载趋势数据...</div>`
          : series.length > 0 && this.historyData && this.historyData.time.length > 0
            ? html`
                <metric-chart
                  title="指标趋势"
                  height="320px"
                  .timeData=${this.historyData.time}
                  .series=${series}
                ></metric-chart>
              `
            : html`<app-card><div class="chart-empty">暂无历史指标数据</div></app-card>`
        }
      </div>
    `;
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
