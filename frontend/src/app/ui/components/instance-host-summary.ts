import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type {
  InstanceHost,
  InstanceHostEvidenceResponse,
  InstanceHostsResponse,
  LinuxHostEvidence,
} from '../../../api/generated/public-api.js';
import { authFetch } from '../../../api/index.js';
import './app-badge.js';
import './app-card.js';
import './app-empty-state.js';

type Freshness = 'fresh' | 'expired' | 'missing';

@customElement('instance-host-summary')
export class InstanceHostSummary extends LitElement {
  @property({ type: Number }) instanceId: number | null = null;

  @state() private hosts: InstanceHost[] | null = null;
  @state() private hostsLoading = false;
  @state() private hostsError: string | null = null;
  @state() private evidence: InstanceHostEvidenceResponse | null = null;
  @state() private evidenceLoading = false;
  @state() private evidenceError: string | null = null;
  private requestVersion = 0;
  private freshnessTimer: ReturnType<typeof setTimeout> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated && this.evidence) {
      this.requestUpdate();
      this.scheduleFreshnessUpdate();
    }
  }

  override disconnectedCallback(): void {
    this.clearFreshnessTimer();
    super.disconnectedCallback();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('instanceId')) {
      this.clearFreshnessTimer();
      const id = this.instanceId;
      if (id != null && Number.isInteger(id) && id > 0) {
        queueMicrotask(() => {
          if (this.instanceId === id) void this.load(id);
        });
      } else {
        this.requestVersion += 1;
        this.hosts = null;
        this.evidence = null;
      }
    }
    if (changed.has('evidence')) this.scheduleFreshnessUpdate();
  }

  private clearFreshnessTimer(): void {
    if (this.freshnessTimer !== null) {
      clearTimeout(this.freshnessTimer);
      this.freshnessTimer = null;
    }
  }

  private scheduleFreshnessUpdate(): void {
    this.clearFreshnessTimer();
    if (!this.isConnected || !this.evidence) return;
    const now = Date.now();
    const expirations = this.evidence.hosts
      .map((item) => item.evidence ? Date.parse(item.evidence.expiresAt) : Number.NaN)
      .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > now);
    if (expirations.length === 0) return;
    const delay = Math.min(Math.min(...expirations) - now, 2_147_483_647);
    this.freshnessTimer = setTimeout(() => {
      this.freshnessTimer = null;
      this.requestUpdate();
      this.scheduleFreshnessUpdate();
    }, delay);
  }

  private async load(instanceId: number): Promise<void> {
    const version = ++this.requestVersion;
    this.hosts = null;
    this.hostsError = null;
    this.hostsLoading = true;
    this.evidence = null;
    this.evidenceError = null;
    this.evidenceLoading = false;

    try {
      const response = await authFetch(`/api/database/instances/${instanceId}/hosts`);
      if (!response.ok) {
        throw new Error(response.status === 401 || response.status === 403
          ? '没有权限查看实例关联主机'
          : '关联主机请求失败');
      }
      const data = await response.json() as InstanceHostsResponse;
      if (version !== this.requestVersion) return;
      this.hosts = data.hosts;
      this.hostsLoading = false;

      if (data.hosts.length === 0) return;

      this.evidenceLoading = true;
      try {
        const evidenceResponse = await authFetch(`/api/database/instances/${instanceId}/host-evidence`);
        if (!evidenceResponse.ok) {
          throw new Error(evidenceResponse.status === 401 || evidenceResponse.status === 403
            ? '没有权限查看 Linux 主机证据'
            : 'Linux 主机证据请求失败');
        }
        const evidence = await evidenceResponse.json() as InstanceHostEvidenceResponse;
        if (version === this.requestVersion) this.evidence = evidence;
      } catch (error) {
        if (version === this.requestVersion) {
          this.evidenceError = error instanceof Error ? error.message : 'Linux 主机证据请求失败';
        }
      } finally {
        if (version === this.requestVersion) this.evidenceLoading = false;
      }
    } catch (error) {
      if (version === this.requestVersion) {
        this.hostsError = error instanceof Error ? error.message : '关联主机请求失败';
        this.hostsLoading = false;
      }
    }
  }

  private freshness(evidence: LinuxHostEvidence | null): Freshness {
    if (!evidence) return 'missing';
    return Date.parse(evidence.expiresAt) > Date.now() ? 'fresh' : 'expired';
  }

  private freshnessBadge(evidence: LinuxHostEvidence | null) {
    const freshness = this.freshness(evidence);
    const label = freshness === 'fresh' ? '证据新鲜' : freshness === 'expired' ? '证据已过期' : '暂无证据';
    const variant = freshness === 'fresh' ? 'ok' : freshness === 'expired' ? 'warn' : 'muted';
    return html`
      <span class="evidence-status" data-freshness=${freshness}>
        <app-badge variant=${variant}>${label}</app-badge>
      </span>
    `;
  }

  private formatBytes(bytes: number | undefined): string {
    if (bytes == null || !Number.isFinite(bytes)) return '--';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = units[0];
    for (let index = 1; value >= 1024 && index < units.length; index += 1) {
      value /= 1024;
      unit = units[index];
    }
    return `${value.toFixed(1)} ${unit}`;
  }

  private formatMetric(value: number, digits: number): string {
    const factor = 10 ** digits;
    return (Math.round((value + Number.EPSILON) * factor) / factor).toFixed(digits);
  }

  private roleLabel(role: string): string {
    const labels: Record<string, string> = {
      standalone: '独立节点', primary: '主节点', replica: '副本', shard: '分片', arbiter: '仲裁节点', unknown: '未知角色',
    };
    return labels[role] || role;
  }

  private renderEvidence(evidence: LinuxHostEvidence) {
    const metrics = [
      { label: 'CPU 使用率', value: evidence.metrics.values.cpu_usage, digits: 1, suffix: '%' },
      { label: '内存使用率', value: evidence.metrics.values.memory_usage, digits: 1, suffix: '%' },
      { label: '1 分钟负载', value: evidence.metrics.values.load_1min, digits: 2, suffix: '' },
    ].filter((metric) => Number.isFinite(metric.value));
    return html`
      <div class="evidence-grid">
        ${metrics.length > 0 ? html`
          <section class="evidence-section">
            <h4>主机指标</h4>
            <div class="evidence-list">
              ${metrics.map((metric) => html`
                <div class="evidence-line">
                  <span class="line-label">${metric.label}</span>
                  <span class="line-value">${this.formatMetric(metric.value, metric.digits)}${metric.suffix}</span>
                </div>
              `)}
            </div>
          </section>
        ` : nothing}
        <section class="evidence-section">
          <h4>系统日志摘要</h4>
          ${evidence.systemLogs.entries.length > 0 ? html`
            <div class="evidence-list">
              ${evidence.systemLogs.entries.slice(0, 3).map((entry) => html`
                <div class="evidence-line log-line">
                  <span class="line-label">${entry.severity}${entry.unit ? ` · ${entry.unit}` : ''}</span>
                  <span class="line-value">${entry.message}</span>
                </div>
              `)}
            </div>
          ` : html`<div class="section-empty">暂无系统日志</div>`}
        </section>

        <section class="evidence-section">
          <h4>文件系统</h4>
          ${evidence.filesystems.items.length > 0 ? html`
            <div class="evidence-list">
              ${evidence.filesystems.items.map((filesystem) => html`
                <div class="evidence-line">
                  <span class="line-label path">${filesystem.mount}</span>
                  <span class="line-value path">${filesystem.device} · ${filesystem.usagePercent.toFixed(1)}%</span>
                </div>
              `)}
            </div>
          ` : html`<div class="section-empty">暂无文件系统证据</div>`}
        </section>

        <section class="evidence-section evidence-section--wide">
          <h4>物理数据文件</h4>
          ${evidence.physicalFiles.items.length > 0 ? html`
            <div class="evidence-list">
              ${evidence.physicalFiles.items.map((file) => html`
                <div class="evidence-line">
                  <span class="line-label path">${file.path}</span>
                  <span class="line-value">${file.type || file.quality} · ${this.formatBytes(file.sizeBytes)}</span>
                </div>
              `)}
            </div>
          ` : html`<div class="section-empty">暂无物理文件证据</div>`}
        </section>

        ${evidence.gaps.length > 0 ? html`
          <section class="evidence-section evidence-section--wide gap-section">
            <h4>主机证据缺口</h4>
            ${evidence.gaps.map((gap) => html`<div class="gap-line"><app-badge variant="warn">${gap.section}</app-badge><span>${gap.reason}</span></div>`)}
          </section>
        ` : nothing}
      </div>
    `;
  }

  private renderBody() {
    if (this.hostsLoading || this.hosts === null && !this.hostsError) {
      return html`<div class="summary-skeleton"><div class="skeleton"></div><div class="skeleton"></div></div>`;
    }
    if (this.hostsError) {
      return html`<app-empty-state title="关联主机不可用" .description=${this.hostsError} icon="triangle-alert"></app-empty-state>`;
    }
    if (this.hosts?.length === 0) {
      return html`<app-empty-state title="未关联 Linux 主机" description="当前实例没有已知的 Linux 主机关联关系" icon="server"></app-empty-state>`;
    }

    const evidenceHosts = new Map(this.evidence?.hosts.map((item) => [item.server.serverId, item.evidence]) ?? []);
    const noEvidence = Boolean(this.evidence) && this.evidence!.hosts.every((item) => item.evidence === null);
    return html`
      ${this.evidenceError ? html`<div class="evidence-error" role="alert">${this.evidenceError}</div>` : nothing}
      <div class="host-list">
        ${this.hosts?.map((host) => {
          const hostEvidence = evidenceHosts.get(host.serverId) ?? null;
          return html`
            <article class="host-row">
              <div class="host-header">
                <div class="host-identity">
                  <strong>${host.label || host.host}</strong>
                  <span>${host.host}:${host.port} · ${host.osType}</span>
                </div>
                <div class="host-badges">
                  <app-badge variant="info">${this.roleLabel(host.role)}</app-badge>
                  ${this.freshnessBadge(hostEvidence)}
                </div>
              </div>
              ${this.evidenceLoading ? html`<div class="host-evidence-skeleton skeleton"></div>` : hostEvidence ? this.renderEvidence(hostEvidence) : nothing}
            </article>
          `;
        })}
      </div>
      ${noEvidence ? html`<app-empty-state title="暂无主机证据" description="关联关系存在，但尚未采集到 Linux 主机证据" icon="file-search"></app-empty-state>` : nothing}
      ${this.evidence && this.evidence.storage.length > 0 ? html`
        <section class="storage-section">
          <h4>数据库物理路径</h4>
          ${this.evidence.storage.map((item) => html`
            <div class="storage-line"><span class="path">${item.path}</span><app-badge variant=${item.hostInspectable ? 'ok' : 'muted'}>${item.kind}</app-badge></div>
          `)}
        </section>
      ` : nothing}
      ${this.evidence && this.evidence.gaps.length > 0 ? html`
        <section class="diagnostic-gaps">
          <h4>诊断证据缺口</h4>
          ${this.evidence.gaps.map((gap) => html`<div class="gap-line"><app-badge variant="warn">${gap.scope}</app-badge><span>${gap.code}</span></div>`)}
        </section>
      ` : nothing}
    `;
  }

  override render() {
    return html`
      <style>
        :host { display: block; min-width: 0; margin-top: var(--space-lg); }
        app-card { display: block; min-width: 0; }
        .summary-skeleton { display: grid; gap: var(--space-sm); }
        .summary-skeleton .skeleton { min-height: 84px; border-radius: var(--radius-sm); }
        .skeleton { background: var(--skeleton, var(--border)); animation: skeleton-pulse 1.5s ease-in-out infinite; }
        @keyframes skeleton-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
        .host-list { display: grid; gap: var(--space-md); min-width: 0; }
        .host-row { min-width: 0; border-bottom: 1px solid var(--border); padding-bottom: var(--space-md); }
        .host-row:last-child { border-bottom: 0; padding-bottom: 0; }
        .host-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-md); min-width: 0; }
        .host-identity { display: flex; flex-direction: column; gap: var(--space-xs); min-width: 0; }
        .host-identity strong { color: var(--text-strong); font-size: var(--text-md); overflow-wrap: anywhere; }
        .host-identity span { color: var(--muted); font-size: var(--text-xs); overflow-wrap: anywhere; }
        .host-badges { display: flex; gap: var(--space-sm); flex-wrap: wrap; justify-content: flex-end; }
        .evidence-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-md); margin-top: var(--space-md); min-width: 0; }
        .evidence-section { min-width: 0; padding: var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elevated); }
        .evidence-section--wide { grid-column: 1 / -1; }
        h4 { margin: 0 0 var(--space-sm); color: var(--text-strong); font-size: var(--text-sm); font-weight: 600; }
        .evidence-list { display: grid; gap: var(--space-sm); min-width: 0; }
        .evidence-line { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-md); min-width: 0; font-size: var(--text-xs); }
        .line-label { color: var(--text-strong); min-width: 0; }
        .line-value { color: var(--muted); min-width: 0; text-align: right; }
        .log-line { display: grid; grid-template-columns: minmax(88px, auto) minmax(0, 1fr); }
        .path, .log-line .line-value, .gap-line span { overflow-wrap: anywhere; word-break: break-word; }
        .section-empty { color: var(--muted); font-size: var(--text-xs); }
        .gap-line, .storage-line { display: flex; align-items: flex-start; gap: var(--space-sm); min-width: 0; color: var(--text); font-size: var(--text-xs); }
        .gap-line + .gap-line, .storage-line + .storage-line { margin-top: var(--space-sm); }
        .storage-line { justify-content: space-between; }
        .storage-line .path { min-width: 0; }
        .storage-section, .diagnostic-gaps { margin-top: var(--space-md); padding-top: var(--space-md); border-top: 1px solid var(--border); min-width: 0; }
        .evidence-error { margin-bottom: var(--space-md); padding: var(--space-md); border: 1px solid var(--danger); border-radius: var(--radius-sm); background: var(--danger-subtle); color: var(--danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
        .host-evidence-skeleton { min-height: 96px; margin-top: var(--space-md); border-radius: var(--radius-sm); }
        @media (max-width: 600px) {
          .host-header { flex-direction: column; }
          .host-badges { justify-content: flex-start; }
          .evidence-grid { grid-template-columns: minmax(0, 1fr); }
          .evidence-section--wide { grid-column: auto; }
          .evidence-line, .log-line { display: grid; grid-template-columns: minmax(0, 1fr); }
          .line-value { text-align: left; }
        }
      </style>
      <app-card>
        <span slot="header">关联 Linux 主机与证据</span>
        ${this.renderBody()}
      </app-card>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'instance-host-summary': InstanceHostSummary;
  }
}
