import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";
import { icons } from "../../../icons.js";
import type {
  ConfigBackupDetail,
  ConfigBackupSummary,
  NetworkDevice,
  NetworkDeviceInterface,
  NetworkDeviceMetric,
  NetworkDeviceRelation,
} from "../../../api/generated/public-api.js";
import { showToast } from "../components/app-toast-container.js";
import "../components/app-badge.js";
import "../components/app-card.js";
import "../components/app-data-table.js";
import "../components/app-dialog.js";
import "../components/app-empty-state.js";

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
    return `in ${formatRate(incoming, "count")} / out ${formatRate(outgoing, "count")}`;
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

  override firstUpdated() { void this.loadContext(); }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("deviceId") && changed.get("deviceId") !== undefined) void this.loadContext();
  }

  private validId(): number | null {
    return this.deviceId != null && Number.isSafeInteger(this.deviceId) && this.deviceId > 0 ? this.deviceId : null;
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
      this.error = "Invalid network device id";
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
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Unable to load network device";
    } finally {
      this.loading = false;
    }
  }

  private navigateBack() {
    window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab: "network-devices" } }));
  }

  private async collect() {
    const id = this.validId();
    if (id === null || this.collecting) return;
    this.collecting = true;
    try {
      const body = await this.json<{ success?: boolean; error?: string }>(`/api/network-devices/${id}/probe`, { method: "POST" });
      if (body.success === false) throw new Error(body.error || "Collection failed");
      showToast("Collection completed", "success");
      await this.loadContext();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Collection failed", "error");
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
      showToast(`Backup v${body.versionNo ?? "?"} captured`, "success");
      await this.loadContext();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const message = code === "SSH_CREDENTIAL_REQUIRED"
        ? "请先编辑网络设备并配置 SSH 用户名和密码或私钥"
        : code === "SSH_HOST_KEY_FINGERPRINT_REQUIRED"
          ? "SSH 主机密钥指纹格式无效，请修正或留空"
          : code || "Backup failed";
      showToast(message, "error");
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
      showToast(error instanceof Error ? error.message : "Unable to open backup", "error");
    } finally {
      this.selectedBackupLoading = false;
    }
  }

  private formatMetric(value: number | null, unit = "") {
    return value == null ? "--" : `${value.toFixed(unit === "%" ? 1 : 0)}${unit}`;
  }

  private statusLabel(status: string) {
    return ({ online: "Online", offline: "Offline", unreachable: "Unreachable", error: "Error", unknown: "Unknown" } as Record<string, string>)[status] ?? status;
  }

  private renderSummary() {
    const uptime = metricValue(this.metrics, "device_uptime_seconds");
    const cpu = metricValue(this.metrics, "device_cpu_percent");
    const memory = metricValue(this.metrics, "device_memory_percent");
    const temperature = metricValue(this.metrics, "device_temperature_celsius");
    const reachability = metricValue(this.metrics, "device_reachability");
    return html`<div class="summary-grid">
      ${[
        ["Uptime", uptime == null ? "--" : `${Math.floor(uptime / 86400)}d ${Math.floor(uptime / 3600) % 24}h`, ""],
        ["CPU", this.formatMetric(cpu, "%"), "%"],
        ["Memory", this.formatMetric(memory, "%"), "%"],
        ["Temperature", this.formatMetric(temperature, "°C"), "°C"],
      ].map(([label, value]) => html`<app-card><div class="summary-label">${label}</div><div class="summary-value">${value}</div></app-card>`)}
    </div>
    <app-card><span slot="header">Collection evidence</span><div class="evidence-row">
      <app-badge variant=${reachability === 1 ? "ok" : reachability === 0 ? "danger" : "muted"}>${reachability === 1 ? "Reachable" : reachability === 0 ? "Unreachable" : "Unknown"}</app-badge>
      ${this.metrics.slice(0, 12).map((metric) => html`<span class="metric-chip"><strong>${metric.metricId}</strong><app-badge variant=${qualityVariant(metric.quality)}>${metric.quality}</app-badge></span>`)}
    </div></app-card>`;
  }

  private renderInterfaces() {
    const columns = [
      { key: "index", label: "Index" }, { key: "name", label: "Interface" }, { key: "alias", label: "Alias" },
      { key: "speed", label: "Speed" }, { key: "admin", label: "Admin" }, { key: "oper", label: "Oper" },
      { key: "inTraffic", label: "In traffic" }, { key: "outTraffic", label: "Out traffic" },
      { key: "errors", label: "Errors" }, { key: "drops", label: "Drops" }, { key: "seen", label: "Last seen" },
    ];
    const rows = this.interfaces.map((item) => ({
      index: item.ifIndex, name: item.ifName, alias: item.ifAlias || "--", speed: item.speedBps == null ? "--" : `${(item.speedBps / 1e9).toFixed(1)} Gbps`,
      admin: html`<app-badge variant=${item.adminStatus === "up" ? "ok" : "muted"}>${item.adminStatus}</app-badge>`,
      oper: html`<app-badge variant=${item.operStatus === "up" ? "ok" : "danger"}>${item.operStatus}</app-badge>`,
      inTraffic: formatRate(interfaceMetricValue(this.metrics, item, "interface_in_bps", "in") ?? interfaceMetricValue(this.metrics, item, "interface_in_bps"), "bps"),
      outTraffic: formatRate(interfaceMetricValue(this.metrics, item, "interface_out_bps", "out") ?? interfaceMetricValue(this.metrics, item, "interface_out_bps"), "bps"),
      errors: formatDirectionalRate(this.metrics, item, "interface_error_rate"),
      drops: formatDirectionalRate(this.metrics, item, "interface_drop_rate"),
      seen: item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : "--",
    }));
    return html`<app-card><span slot="header">Interfaces (${this.interfaces.length})</span>${rows.length ? html`<app-data-table .columns=${columns} .rows=${rows} dense></app-data-table>` : html`<app-empty-state title="No interface observations" description="Run a collection to populate interface status." icon="network"></app-empty-state>`}</app-card>`;
  }

  private renderRelations() {
    const columns = [{ key: "source", label: "Source" }, { key: "target", label: "Target" }, { key: "type", label: "Relation" }, { key: "provenance", label: "Provenance" }, { key: "valid", label: "Valid until" }];
    const rows = this.relations.map((relation) => ({
      source: `${relation.source.type}#${relation.source.id}`,
      target: `${relation.target.type}#${relation.target.id}`,
      type: relation.relationType,
      provenance: relation.provenance,
      valid: relation.validUntil ? new Date(relation.validUntil).toLocaleString() : "Current",
    }));
    return html`<app-card><span slot="header">Related resources (${this.relations.length})</span>${rows.length ? html`<app-data-table .columns=${columns} .rows=${rows}></app-data-table>` : html`<app-empty-state title="No active relations" description="Link this device to a server; database impact is shown through the server relationship." icon="link"></app-empty-state>`}</app-card>`;
  }

  private renderBackups() {
    const columns = [{ key: "version", label: "Version" }, { key: "collected", label: "Collected" }, { key: "size", label: "Size" }, { key: "hash", label: "SHA-256" }, { key: "redaction", label: "Redaction" }, { key: "action", label: "Action", textAlign: "center" }];
    const rows = this.backups.map((backup) => ({
      version: `v${backup.versionNo}`,
      collected: new Date(backup.collectedAt).toLocaleString(),
      size: `${Math.max(0, Number(backup.sizeBytes || 0) / 1024).toFixed(1)} KB`,
      hash: `${backup.contentSha256.slice(0, 12)}…`,
      redaction: html`<app-badge variant=${backup.redactionStatus === "redacted" ? "ok" : "warn"}>${backup.redactionStatus}</app-badge>`,
      action: html`<button class="btn" type="button" @click=${() => this.openBackup(backup)}>View summary</button>`,
    }));
    return html`<app-card><span slot="header">Encrypted configuration backups</span><div class="backup-note">Backups are read-only. The UI exposes a redacted preview; configuration restore and write operations are unavailable.</div>${rows.length ? html`<app-data-table .columns=${columns} .rows=${rows} dense></app-data-table>` : html`<app-empty-state title="No backups" description="Capture an encrypted SSH configuration backup when the device is reachable." icon="archive"></app-empty-state>`}</app-card>`;
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
    ${id === null ? html`<div class="error">Invalid network device id</div>` : this.loading ? html`<div class="loading" role="status">Loading device evidence…</div>` : this.error ? html`<div class="error" role="alert">${this.error}<br><button class="btn" type="button" @click=${this.loadContext}>Retry</button></div>` : this.device ? html`<div class="page">
      <div class="header"><div class="title"><button class="btn-ghost" type="button" @click=${this.navigateBack}>${icons["chevron-left"]} Network devices</button><h1>${this.device.label || this.device.name}</h1><div class="meta">${this.device.host}:${this.device.snmp_port} · ${this.device.vendor === "cisco" ? "Cisco" : "Huawei"} ${this.device.os_version || ""}</div></div><div class="header-actions"><app-badge variant=${qualityVariant(this.device.status === "online" ? "good" : this.device.status === "error" ? "error" : "unknown")}>${this.statusLabel(this.device.status)}</app-badge><button class="btn" type="button" @click=${this.collect} .disabled=${this.collecting}>${icons.refresh} ${this.collecting ? "Collecting…" : "Collect now"}</button><button class="btn-primary" type="button" @click=${this.captureBackup} .disabled=${this.backupLoading}>${icons.save} ${this.backupLoading ? "Capturing…" : "Capture backup"}</button></div></div>
      <div class="tabs">${(["overview", "interfaces", "relations", "backups"] as DetailTab[]).map((tab) => html`<button class="tab ${this.activeTab === tab ? "active" : ""}" type="button" @click=${() => (this.activeTab = tab)}>${tab === "overview" ? "Overview" : tab === "interfaces" ? "Interfaces" : tab === "relations" ? "Relations" : "Backups"}</button>`)}</div>
      ${this.activeTab === "overview" ? this.renderSummary() : this.activeTab === "interfaces" ? this.renderInterfaces() : this.activeTab === "relations" ? this.renderRelations() : this.renderBackups()}
    </div>` : nothing}
    ${this.selectedBackup ? html`<app-dialog .open=${true} size="xl" title=${`Configuration backup v${this.selectedBackup.versionNo}`} @app-dialog-close=${() => (this.selectedBackup = null)}><p class="meta">Collected ${new Date(this.selectedBackup.collectedAt).toLocaleString()} · SHA-256 ${this.selectedBackup.contentSha256}</p><pre class="preview">${this.selectedBackup.preview}</pre><div slot="footer"><button class="btn" type="button" @click=${() => (this.selectedBackup = null)}>Close</button></div></app-dialog>` : nothing}`;
  }
}
