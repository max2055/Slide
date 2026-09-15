import { returnToDashboard } from './dashboard-model.js';
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";
import { icons } from "../../../icons.js";
import type {
  ConfigBackupDetail,
  ConfigBackupSchedule as BackupSchedule,
  ConfigBackupSummary,
  NetworkDevice,
  NetworkDeviceInterface,
  NetworkDeviceMetric,
  NetworkDeviceRelation,
} from "../../../api/generated/public-api.js";
import { showToast } from "../components/app-toast-container.js";
import { networkDeviceLabel, networkDeviceError } from './network-device-labels.js';
import "../components/app-badge.js";
import "../components/app-card.js";
import "../components/app-data-table.js";
import "../components/app-dialog.js";
import "../components/app-empty-state.js";
import "../components/app-form-field.js";

type DetailTab = "overview" | "interfaces" | "relations" | "backups";

function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({}));
}

function metricValue(metrics: NetworkDeviceMetric[], id: string): number | null {
  const row = metrics.find((item) => item.metricId === id);
  return row?.value == null || !Number.isFinite(Number(row.value)) ? null : Number(row.value);
}

function interfaceMetricValue(
  metrics: NetworkDeviceMetric[],
  item: NetworkDeviceInterface,
  metricId: string,
  direction?: "in" | "out",
): number | null {
  const candidates = metrics
    .filter((metric) => metric.metricId === metricId)
    .filter((metric) => {
      const dimensions = metric.dimensions ?? {};
      const matchesIndex = dimensions.if_index === String(item.ifIndex) || dimensions.interface === item.ifName;
      return matchesIndex && (direction === undefined || dimensions.direction === direction);
    })
    .sort((left, right) => String(right.observedAt ?? "").localeCompare(String(left.observedAt ?? "")));
  const value = candidates[0]?.value;
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function formatRate(value: number | null, unit: "bps" | "count"): string {
  if (value == null) return "--";
  if (unit === "count") return `${value.toFixed(1)}/s`;
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} Gbps`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mbps`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)} Kbps`;
  return `${value.toFixed(1)} bps`;
}

function formatDirectionalRate(metrics: NetworkDeviceMetric[], item: NetworkDeviceInterface, metricId: string): string {
  const incoming = interfaceMetricValue(metrics, item, metricId, "in");
  const outgoing = interfaceMetricValue(metrics, item, metricId, "out");
  if (incoming != null && outgoing != null) {
    return `入站 ${formatRate(incoming, "count")} / 出站 ${formatRate(outgoing, "count")}`;
  }
  return formatRate(incoming ?? outgoing, "count");
}

function qualityVariant(value: string): "ok" | "warn" | "danger" | "muted" {
  if (value === "good") return "ok";
  if (value === "partial") return "warn";
  if (value === "unknown" || value === "unsupported") return "muted";
  return "danger";
}

@customElement("network-device-detail")
export class NetworkDeviceDetail extends LitElement {
  createRenderRoot() { return this; }

  @property({ type: Number }) deviceId: number | null = null;
  @state() private device: NetworkDevice | null = null;
  @state() private metrics: NetworkDeviceMetric[] = [];
  @state() private interfaces: NetworkDeviceInterface[] = [];
  @state() private relations: NetworkDeviceRelation[] = [];
  @state() private backups: ConfigBackupSummary[] = [];
  @state() private activeTab: DetailTab = "overview";
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private collecting = false;
  @state() private backupLoading = false;
  @state() private selectedBackup: ConfigBackupDetail | null = null;
  @state() private selectedBackupLoading = false;
  @state() private backupSchedule: BackupSchedule | null = null;
  @state() private scheduleError = '';
  @state() private scheduleSaving = false;

  override firstUpdated() { void this.loadContext(); }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("deviceId") && changed.get("deviceId") !== undefined) void this.loadContext();
  }

  private validId(): number | null {
    const raw = location.pathname === "/network-device-detail" ? new URL(location.href).searchParams.get("networkDeviceId") : null;
    const id = this.deviceId ?? (raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : null);
    return id != null && Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await authFetch(url, init);
    const body = await bodyOf(response);
    if (!response.ok) throw new Error(String(body.error || `HTTP ${response.status}`));
    return body as T;
  }

  async loadContext(): Promise<void> {
    const id = this.validId();
    if (id === null) {
      this.loading = false;
      this.error = "网络设备 ID 无效";
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const [device, metrics, interfaces, relations, backups] = await Promise.all([
        this.json<NetworkDevice>(`/api/network-devices/${id}`),
        this.json<{ metrics?: NetworkDeviceMetric[] }>(`/api/network-devices/${id}/metrics`),
        this.json<{ interfaces?: NetworkDeviceInterface[] }>(`/api/network-devices/${id}/interfaces`),
        this.json<{ relations?: NetworkDeviceRelation[] }>(`/api/network-devices/${id}/relations`),
        this.json<{ backups?: ConfigBackupSummary[] }>(`/api/network-devices/${id}/config-backups`),
      ]);
      this.device = device;
      this.metrics = Array.isArray(metrics.metrics) ? metrics.metrics : [];
      this.interfaces = Array.isArray(interfaces.interfaces) ? interfaces.interfaces : [];
      this.relations = Array.isArray(relations.relations) ? relations.relations : [];
      this.backups = Array.isArray(backups.backups) ? backups.backups : [];
      await this.loadBackupSchedule(id);
    } catch (error) {
      this.error = networkDeviceError(error, '无法加载网络设备');
    } finally {
      this.loading = false;
    }
  }

  private async loadBackupSchedule(id: number) {
    this.scheduleError = '';
    try { this.backupSchedule = await this.json<BackupSchedule>(`/api/network-devices/${id}/backup-schedule`); }
    catch (error) { this.backupSchedule = null; this.scheduleError = networkDeviceError(error, '无法加载定时备份设置'); }
  }

  private async saveBackupSchedule() {
    const id = this.validId();
    if (id === null || !this.backupSchedule || this.scheduleSaving) return;
    const { enabled, dailyTime } = this.backupSchedule;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyTime)) {
      this.scheduleError = '请选择有效的每日执行时间'; return;
    }
    this.scheduleSaving = true;
    this.scheduleError = '';
    try {
      this.backupSchedule = await this.json<BackupSchedule>(`/api/network-devices/${id}/backup-schedule`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, dailyTime }),
      });
      showToast('定时备份设置已保存', 'success');
    } catch (error) { this.scheduleError = networkDeviceError(error, '保存定时备份设置失败'); }
    finally { this.scheduleSaving = false; }
  }

  private navigateBack() { if (returnToDashboard()) return;
    window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab: "network-devices" } }));
  }

  private async collect() {
    const id = this.validId();
    if (id === null || this.collecting) return;
    this.collecting = true;
    try {
      const body = await this.json<{ success?: boolean; error?: string }>(`/api/network-devices/${id}/probe`, { method: "POST" });
      if (body.success === false) throw new Error(body.error || "采集失败");
      showToast("采集完成", "success");
      await this.loadContext();
    } catch (error) {
      showToast(networkDeviceError(error, '采集失败'), "error");
    } finally {
      this.collecting = false;
    }
  }

  private async captureBackup() {
    const id = this.validId();
    if (id === null || this.backupLoading) return;
    this.backupLoading = true;
    try {
      const body = await this.json<ConfigBackupSummary>(`/api/network-devices/${id}/config-backups`, { method: "POST" });
      showToast(`配置备份 v${body.versionNo ?? "?"} 已完成`, "success");
      await this.loadContext();
    } catch (error) {
      showToast(networkDeviceError(error, '配置备份失败'), 'error');
    } finally {
      this.backupLoading = false;
    }
  }

  private async openBackup(backup: ConfigBackupSummary) {
    const id = this.validId();
    if (id === null || this.selectedBackupLoading) return;
    this.selectedBackupLoading = true;
    try {
      const detail = await this.json<ConfigBackupDetail>(`/api/network-devices/${id}/config-backups/${backup.id}`);
      this.selectedBackup = detail;
    } catch (error) {
      showToast(networkDeviceError(error, '无法打开备份'), "error");
    } finally {
      this.selectedBackupLoading = false;
    }
  }

  private formatMetric(value: number | null, unit = "") {
    return value == null ? "--" : `${value.toFixed(unit === "%" ? 1 : 0)}${unit}`;
  }

  private statusLabel(status: string) {
    return ({ online: "在线", offline: "离线", unreachable: "不可达", error: "异常", unknown: "未知" } as Record<string, string>)[status] ?? status;
  }

  private renderSummary() {
    const uptime = metricValue(this.metrics, "device_uptime_seconds");
    const cpu = metricValue(this.metrics, "device_cpu_percent");
    const memory = metricValue(this.metrics, "device_memory_percent");
    const temperature = metricValue(this.metrics, "device_temperature_celsius");
    const reachability = metricValue(this.metrics, "device_reachability");
    return html`<div class="summary-grid">
      ${[
        ["运行时长", uptime == null ? "--" : `${Math.floor(uptime / 86400)} 天 ${Math.floor(uptime / 3600) % 24} 小时`, ""],
        ["CPU", this.formatMetric(cpu, "%"), "%"],
        ["内存", this.formatMetric(memory, "%"), "%"],
        ["温度", this.formatMetric(temperature, "°C"), "°C"],
      ].map(([label, value]) => html`<app-card><div class="summary-label">${label}</div><div class="summary-value">${value}</div></app-card>`)}
    </div>
    <app-card><span slot="header">自动采集</span><p>${this.device?.collection_enabled ? '已启用，后台按指标配置的间隔定期采集。' : '已暂停，请在网络设备编辑页面启用采集。'}</p>
      <p class="meta">在「指标注册表」选择「网络设备」，编辑指标的「采集间隔（秒）」即可调整频率，保存后自动生效。默认网络指标间隔为 300 秒。</p>
      <p class="meta">最近检查：${this.device?.last_check_at ? new Date(this.device.last_check_at).toLocaleString('zh-CN') : '暂无记录'}</p>
    </app-card>
    <app-card><span slot="header">采集指标与质量</span><div class="evidence-row">
      <app-badge variant=${reachability === 1 ? "ok" : reachability === 0 ? "danger" : "muted"}>${reachability === 1 ? "可达" : reachability === 0 ? "不可达" : "未知"}</app-badge>
      ${this.metrics.slice(0, 12).map((metric) => html`<span class="metric-chip"><strong>${networkDeviceLabel(metric.metricId)}</strong><app-badge variant=${qualityVariant(metric.quality)}>${networkDeviceLabel(metric.quality)}</app-badge></span>`)}
    </div></app-card>`;
  }

  private renderInterfaces() {
    const columns = [
      { key: "index", label: "序号" }, { key: "name", label: "接口" }, { key: "alias", label: "别名" },
      { key: "speed", label: "速率" }, { key: "admin", label: "管理状态" }, { key: "oper", label: "运行状态" },
      { key: "inTraffic", label: "入站流量" }, { key: "outTraffic", label: "出站流量" },
      { key: "errors", label: "错包速率" }, { key: "drops", label: "丢包速率" }, { key: "seen", label: "最近采集" },
    ];
    const rows = this.interfaces.map((item) => ({
      index: item.ifIndex, name: item.ifName, alias: item.ifAlias || "--", speed: item.speedBps == null ? "--" : `${(item.speedBps / 1e9).toFixed(1)} Gbps`,
      admin: html`<app-badge variant=${item.adminStatus === "up" ? "ok" : "muted"}>${networkDeviceLabel(item.adminStatus)}</app-badge>`,
      oper: html`<app-badge variant=${item.operStatus === "up" ? "ok" : "danger"}>${networkDeviceLabel(item.operStatus)}</app-badge>`,
      inTraffic: formatRate(interfaceMetricValue(this.metrics, item, "interface_in_bps", "in") ?? interfaceMetricValue(this.metrics, item, "interface_in_bps"), "bps"),
      outTraffic: formatRate(interfaceMetricValue(this.metrics, item, "interface_out_bps", "out") ?? interfaceMetricValue(this.metrics, item, "interface_out_bps"), "bps"),
      errors: formatDirectionalRate(this.metrics, item, "interface_error_rate"),
      drops: formatDirectionalRate(this.metrics, item, "interface_drop_rate"),
      seen: item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : "--",
    }));
    return html`<app-card><span slot="header">接口（${this.interfaces.length}）</span>${rows.length ? html`<app-data-table .columns=${columns} .rows=${rows} dense></app-data-table>` : html`<app-empty-state title="暂无接口数据" description="自动采集后将显示接口状态，也可点击立即采集。" icon="network"></app-empty-state>`}</app-card>`;
  }

  private renderRelations() {
    const columns = [{ key: "source", label: "源资源" }, { key: "target", label: "目标资源" }, { key: "type", label: "关系" }, { key: "provenance", label: "来源" }, { key: "valid", label: "有效期至" }];
    const rows = this.relations.map((relation) => ({
      source: `${networkDeviceLabel(relation.source.type)}#${relation.source.id}`,
      target: `${networkDeviceLabel(relation.target.type)}#${relation.target.id}`,
      type: networkDeviceLabel(relation.relationType),
      provenance: networkDeviceLabel(relation.provenance),
      valid: relation.validUntil ? new Date(relation.validUntil).toLocaleString() : "当前有效",
    }));
    return html`<app-card><span slot="header">关联资源（${this.relations.length}）</span>${rows.length ? html`<app-data-table .columns=${columns} .rows=${rows}></app-data-table>` : html`<app-empty-state title="暂无关联资源" description="将此设备关联到服务器，可通过服务器关系查看受影响的数据库。" icon="link"></app-empty-state>`}</app-card>`;
  }

  private renderBackups() {
    const columns = [{ key: "version", label: "版本" }, { key: "collected", label: "备份时间" }, { key: "size", label: "大小" }, { key: "hash", label: "SHA-256" }, { key: "redaction", label: "脱敏状态" }, { key: "action", label: "操作", textAlign: "center" }];
    const rows = this.backups.map((backup) => ({
      version: `v${backup.versionNo}`,
      collected: new Date(backup.collectedAt).toLocaleString(),
      size: `${Math.max(0, Number(backup.sizeBytes || 0) / 1024).toFixed(1)} KB`,
      hash: `${backup.contentSha256.slice(0, 12)}…`,
      redaction: html`<app-badge variant=${backup.redactionStatus === "redacted" ? "ok" : "warn"}>${networkDeviceLabel(backup.redactionStatus)}</app-badge>`,
      action: html`<button class="btn" type="button" @click=${() => this.openBackup(backup)}>查看摘要</button>`,
    }));
    return html`<app-card><span slot="header">加密配置备份</span><div class="backup-note">备份内容加密保存，预览已脱敏。</div>${rows.length ? html`<app-data-table .columns=${columns} .rows=${rows} dense></app-data-table>` : html`<app-empty-state title="暂无配置备份" description="配置 SSH 凭据后可定时备份，也可点击立即备份。" icon="archive"></app-empty-state>`}</app-card>`;
  }

  private renderBackupSchedule() {
    const schedule = this.backupSchedule;
    return html`<app-card><span slot="header">每日定时备份</span>
      <p class="backup-note">默认每天 00:00（北京时间）执行。服务恢复时补做当天到期任务；当天已执行过则不重复，修改时间从下次未执行的日期生效。</p>
      ${!this.device?.hasSshCredential ? html`<p class="backup-note">尚未配置 SSH 凭据，自动备份暂不执行。请先编辑网络设备，配置 SSH 用户名和密码或私钥。</p>` : nothing}
      ${schedule ? html`<form @submit=${(event: SubmitEvent) => { event.preventDefault(); void this.saveBackupSchedule(); }}>
        <app-form-field label="自动备份"><input aria-label="启用每日定时备份" type="checkbox" .checked=${schedule.enabled} .disabled=${this.scheduleSaving} @change=${(event: Event) => { this.backupSchedule = { ...schedule, enabled: (event.target as HTMLInputElement).checked }; }}></app-form-field>
        <app-form-field label="每日执行时间" hint="北京时间（UTC+8）" .required=${true}><input aria-label="每日执行时间" type="time" step="60" required .value=${schedule.dailyTime} .disabled=${this.scheduleSaving} @input=${(event: Event) => { this.backupSchedule = { ...this.backupSchedule!, dailyTime: (event.target as HTMLInputElement).value }; }}></app-form-field>
        <button type="submit" class="btn-primary" .disabled=${this.scheduleSaving}>${this.scheduleSaving ? '保存中…' : '保存定时设置'}</button>
      </form>
      <p class="meta">最近自动备份：${schedule.lastRun ? `${schedule.lastRun.date} · ${networkDeviceLabel(schedule.lastRun.status)}${schedule.lastRun.errorCode ? ` · ${networkDeviceError(schedule.lastRun.errorCode)}` : ''}` : '尚未执行'}</p>` : nothing}
      ${this.scheduleError ? html`<p role="alert" class="error">${this.scheduleError}</p>${!schedule ? html`<button class="btn" @click=${() => this.loadBackupSchedule(this.validId()!)}>重新加载定时设置</button>` : nothing}` : nothing}
    </app-card>`;
  }

  render() {
    const id = this.validId();
    return html`<style>
      :host { display:block; min-width:0; }
      .page { display:grid; gap:var(--space-lg); min-width:0; }
      .header { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--space-md); flex-wrap:wrap; border-bottom:1px solid var(--border); padding-bottom:var(--space-md); }
      .title { min-width:0; }
      .title h1 { margin:0; font-size:var(--text-2xl); color:var(--text-strong); overflow-wrap:anywhere; }
      .meta { margin-top:var(--space-xs); color:var(--muted); overflow-wrap:anywhere; }
      .header-actions { display:flex; flex-wrap:wrap; gap:var(--space-sm); align-items:center; }
      .tabs { display:flex; gap:var(--space-xs); overflow-x:auto; border-bottom:1px solid var(--border); }
      .tab { border:0; border-bottom:2px solid transparent; background:transparent; color:var(--muted); padding:var(--space-sm) var(--space-md); cursor:pointer; white-space:nowrap; }
      .tab.active { color:var(--accent); border-bottom-color:var(--accent); }
      .summary-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:var(--space-md); }
      .summary-grid app-card { text-align:center; }
      .summary-label { color:var(--muted); font-size:var(--text-sm); }
      .summary-value { color:var(--text-strong); font-size:var(--text-xl); font-weight:700; margin-top:var(--space-sm); }
      .evidence-row { display:flex; gap:var(--space-sm); flex-wrap:wrap; align-items:center; }
      .metric-chip { display:inline-flex; align-items:center; gap:var(--space-xs); border:1px solid var(--border); border-radius:var(--radius-sm); padding:var(--space-xs) var(--space-sm); color:var(--muted); font-size:var(--text-xs); }
      /* Keep dense evidence tables usable on phones without widening the page. */
      .page app-data-table { display:block; max-width:100%; overflow-x:auto; }
      .page app-data-table .data-table { min-width:640px; }
      /* The legacy sessions responsive rules are global; infrastructure tables
         must retain relation/action columns so their workflows remain usable. */
      .page app-data-table .data-table th:nth-child(3),
      .page app-data-table .data-table td:nth-child(3),
      .page app-data-table .data-table th:nth-child(6),
      .page app-data-table .data-table td:nth-child(6) { display:table-cell; }
      .backup-note { color:var(--muted); font-size:var(--text-sm); margin-bottom:var(--space-md); }
      .loading, .error { padding:var(--space-xl); text-align:center; color:var(--muted); }
      .error { color:var(--danger); }
      .preview { white-space:pre-wrap; overflow:auto; max-height:55vh; background:var(--bg-elevated); border:1px solid var(--border); padding:var(--space-md); border-radius:var(--radius-sm); font-family:var(--font-mono, monospace); font-size:var(--text-xs); }
      @media (max-width:800px) { .summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
      @media (max-width:520px) { .summary-grid { grid-template-columns:minmax(0,1fr); } .header-actions { width:100%; } .header-actions .btn, .header-actions .btn-primary { flex:1; justify-content:center; } }
    </style>
    ${id === null ? html`<div class="error">网络设备 ID 无效</div>` : this.loading ? html`<div class="loading" role="status">正在加载设备数据…</div>` : this.error ? html`<div class="error" role="alert">${this.error}<br><button class="btn" type="button" @click=${this.loadContext}>重试</button></div>` : this.device ? html`<div class="page">
      <div class="header"><div class="title"><button class="btn-ghost" type="button" @click=${this.navigateBack}>${icons["chevron-left"]} 网络设备</button><h1>${this.device.label || this.device.name}</h1><div class="meta">${this.device.host}:${this.device.snmp_port} · ${this.device.vendor === "cisco" ? "Cisco" : "Huawei"} ${this.device.os_version || ""}</div></div><div class="header-actions"><app-badge variant=${qualityVariant(this.device.status === "online" ? "good" : this.device.status === "error" ? "error" : "unknown")}>${this.statusLabel(this.device.status)}</app-badge><button class="btn" type="button" @click=${this.collect} .disabled=${this.collecting}>${icons.refresh} ${this.collecting ? "采集中…" : "立即采集"}</button><button class="btn-primary" type="button" @click=${this.captureBackup} .disabled=${this.backupLoading}>${icons.save} ${this.backupLoading ? "备份中…" : "立即备份"}</button></div></div>
      <div class="tabs">${(["overview", "interfaces", "relations", "backups"] as DetailTab[]).map((tab) => html`<button class="tab ${this.activeTab === tab ? "active" : ""}" type="button" @click=${() => (this.activeTab = tab)}>${tab === "overview" ? "概览" : tab === "interfaces" ? "接口" : tab === "relations" ? "关联资源" : "配置备份"}</button>`)}</div>
      ${this.activeTab === "overview" ? this.renderSummary() : this.activeTab === "interfaces" ? this.renderInterfaces() : this.activeTab === "relations" ? this.renderRelations() : html`${this.renderBackupSchedule()}${this.renderBackups()}`}
    </div>` : nothing}
    ${this.selectedBackup ? html`<app-dialog .open=${true} size="xl" title=${`配置备份 v${this.selectedBackup.versionNo}`} @app-dialog-close=${() => (this.selectedBackup = null)}><p class="meta">备份时间 ${new Date(this.selectedBackup.collectedAt).toLocaleString()} · SHA-256 ${this.selectedBackup.contentSha256}</p><pre class="preview">${this.selectedBackup.preview}</pre><div slot="footer"><button class="btn" type="button" @click=${() => (this.selectedBackup = null)}>关闭</button></div></app-dialog>` : nothing}`;
  }
}
