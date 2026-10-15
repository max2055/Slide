import '../components/resource-investigation-links.js';
import "../components/semantic-metrics.js";
import "../components/metric-configuration.js";
import { freshness, runState, type Overview, type OverviewItem, returnToDashboard } from './dashboard-model.js';
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";
import { icons } from "../../../icons.js";
import type {
  ConfigBackupDetail,
  ConfigBackupSchedule as BackupSchedule,
  ConfigBackupSummary,
  NetworkDevice,
  NetworkDeviceRelation,
  NetworkDeviceInterface,
} from "../../../api/generated/public-api.js";
import { showToast } from "../components/app-toast-container.js";
import { networkDeviceLabel, networkDeviceError } from './network-device-labels.js';
import "../components/app-badge.js";
import "../components/app-card.js";
import "../components/app-data-table.js";
import "../components/app-dialog.js";
import "../components/app-empty-state.js";
import "../components/app-form-field.js";

type DetailTab = "metrics" | "overview" | "interfaces" | "relations" | "backups" | "collection";

function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({}));
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
  @state() private relations: NetworkDeviceRelation[] = [];
  @state() private backups: ConfigBackupSummary[] = [];
  @state() private activeTab: DetailTab = new URL(location.href).searchParams.get('metricResource')?.startsWith('network_device:') ? 'metrics' : 'overview' ;
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private backupLoading = false;
  @state() private selectedBackup: ConfigBackupDetail | null = null;
  @state() private selectedBackupLoading = false;
  @state() private backupSchedule: BackupSchedule | null = null;
  @state() private scheduleError = '';
  @state() private scheduleSaving = false;

  private contextVersion = 0;
  private interfaceRequest = 0;
  private overviewRequest = 0;
  @state() private interfaces: NetworkDeviceInterface[] = [];
  @state() private interfacesLoading = false;
  @state() private interfacesError = '';
  @state() private interfaceSearch = '';
  @state() private interfaceStatus = '';
  @state() private overview: OverviewItem | null = null;
  @state() private overviewLoading = false;
  @state() private overviewError = '';
  @state() private lastRead: string | null = null;
  private onAccessChanged = () => {
    ++this.contextVersion; ++this.interfaceRequest; ++this.overviewRequest;
    this.device = null; this.relations = []; this.backups = []; this.selectedBackup = null; this.backupSchedule = null;
    this.interfaces = []; this.overview = null; this.lastRead = null; this.loading = false;
    this.error = '权限或登录状态已变更，请重新打开资源。';
  };
  override firstUpdated() {
    window.addEventListener('slide-permissions-loaded', this.onAccessChanged);
    window.addEventListener('slide-session-expired', this.onAccessChanged);
    void this.loadContext();
  }
  override disconnectedCallback() {
    this.onAccessChanged();
    window.removeEventListener('slide-permissions-loaded', this.onAccessChanged);
    window.removeEventListener('slide-session-expired', this.onAccessChanged);
    super.disconnectedCallback();
  }

  override willUpdate(changed: Map<string, unknown>) {
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
    if (!response.ok) throw new Error(String(body.error || (response.status === 403 ? '没有访问此资源的权限' : response.status === 401 ? '登录已失效' : `HTTP ${response.status}`)));
    return body as T;
  }

  async loadContext(): Promise<void> {
    const id = this.validId();
    if (id === null) {
      this.onAccessChanged();
      this.loading = false;
      this.error = "网络设备 ID 无效";
      return;
    }
    const version = ++this.contextVersion;
    this.device = null; this.relations = []; this.backups = []; this.backupSchedule = null; this.selectedBackup = null;
    this.interfaces = []; ++this.interfaceRequest; this.interfacesError = ''; this.interfacesLoading = false;
    this.interfaceSearch = ''; this.interfaceStatus = ''; this.lastRead = null;
    this.backupLoading = false; this.selectedBackupLoading = false; this.scheduleSaving = false;
    void this.loadOverview(id, version);
    if (this.activeTab === 'interfaces') void this.loadInterfaces(id, version);
    this.loading = true;
    this.error = null;
    try {
      const [device, relations, backups] = await Promise.all([
        this.json<NetworkDevice>(`/api/network-devices/${id}`),
        this.json<{ relations?: NetworkDeviceRelation[] }>(`/api/network-devices/${id}/relations`),
        this.json<{ backups?: ConfigBackupSummary[] }>(`/api/network-devices/${id}/config-backups`),
      ]);
      if (version !== this.contextVersion || id !== this.validId()) return;
      this.device = device; this.lastRead = new Date().toISOString();
      this.relations = Array.isArray(relations.relations) ? relations.relations : [];
      this.backups = Array.isArray(backups.backups) ? backups.backups : [];
      await this.loadBackupSchedule(id);
    } catch (error) {
      if (version === this.contextVersion) this.error = networkDeviceError(error, '无法加载网络设备');
    } finally {
      if (version === this.contextVersion) this.loading = false;
    }
  }

  private async loadOverview(id: number, version = this.contextVersion) {
    const request = ++this.overviewRequest;
    const current = () => version === this.contextVersion && id === this.validId() && request === this.overviewRequest;
    this.overview = null; this.overviewError = ''; this.overviewLoading = true;
    try {
      const body = await this.json<Overview>('/api/resources/overview');
      if (!current()) return;
      const item = body.items?.find(row => row?.resource?.type === 'network_device' && row.resource.id === id);
      if (item && (!Array.isArray(item.gaps) || typeof item.status !== 'string' || typeof item.quality !== 'string' || !Number.isFinite(item.unresolvedAlerts))) throw new Error('资源概览格式异常');
      this.overview = item ?? null;
      if (!item) this.overviewError = '当前快照未包含此资源，状态无法确认。';
    } catch (error) { if (current()) this.overviewError = networkDeviceError(error, '资源概览读取失败'); }
    finally { if (current()) this.overviewLoading = false; }
  }
  private async loadInterfaces(id = this.validId(), version = this.contextVersion) {
    if (!id) return;
    const request = ++this.interfaceRequest;
    const current = () => version === this.contextVersion && id === this.validId() && request === this.interfaceRequest;
    this.interfaces = []; this.interfacesLoading = true; this.interfacesError = '';
    try {
      const body = await this.json<{interfaces: NetworkDeviceInterface[]}>(`/api/network-devices/${id}/interfaces`);
      if (!current()) return;
      if (!Array.isArray(body.interfaces)) throw new Error('接口列表格式异常');
      this.interfaces = body.interfaces;
    } catch (error) { if (current()) this.interfacesError = networkDeviceError(error, '接口读取失败'); }
    finally { if (current()) this.interfacesLoading = false; }
  }
  private renderInterfaces() {
    const rows = this.interfaces.filter(row => (!this.interfaceStatus || row.operStatus === this.interfaceStatus) && `${row.ifName} ${row.ifAlias ?? ''} ${row.ifIndex}`.toLowerCase().includes(this.interfaceSearch.trim().toLowerCase()));
    const status = (value: string) => ({up:'已启用',down:'已停用',testing:'测试中',unknown:'未知',notPresent:'不存在',lowerLayerDown:'下层链路中断',dormant:'休眠'}[value] ?? value);
    return html`<app-card><h2 slot="header">网络接口</h2><div class="interface-filters">
      <label>名称或别名 <input aria-label="接口名称或别名" .value=${this.interfaceSearch} @input=${(e:Event)=>this.interfaceSearch=(e.target as HTMLInputElement).value}></label>
      <label>运行状态 <select aria-label="接口运行状态" .value=${this.interfaceStatus} @change=${(e:Event)=>this.interfaceStatus=(e.target as HTMLSelectElement).value}><option value="">全部状态</option>${[...new Set(this.interfaces.map(row=>row.operStatus))].map(value=>html`<option value=${value}>${status(value)}</option>`)}</select></label>
      <button class="btn" ?disabled=${this.interfacesLoading} @click=${()=>this.loadInterfaces()}>刷新接口</button>
    </div><p class="meta">显示 ${rows.length} / ${this.interfaces.length} 个已保存接口。速率为接口标称容量，不代表实测流量；最后发现时间不代表当前在线。</p>
      ${this.interfacesError ? html`<p role="alert" class="error">${this.interfacesError}</p>` : this.interfacesLoading ? html`<p role="status">正在读取接口…</p>` : rows.length ? html`<app-data-table tabindex="0" role="region" aria-label="接口列表，可横向滚动" .dense=${true} .columns=${[{key:'name',label:'接口 / 别名'},{key:'status',label:'管理 / 运行状态'},{key:'speed',label:'标称容量'},{key:'seen',label:'最后发现'}]}
        .rows=${rows.map(row=>({name:html`<strong>${row.ifName}</strong><div>${row.ifAlias || '无别名'} · #${row.ifIndex}</div>`,status:`${status(row.adminStatus)} / ${status(row.operStatus)}`,speed:row.speedBps === null ? '未知' : `${row.speedBps} bit/s`,seen:row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString('zh-CN') : '未知'}))}></app-data-table>` : html`<app-empty-state title=${this.interfaces.length ? '没有匹配的接口' : '尚未取得接口记录'} description="接口记录缺失不代表设备没有接口，也不能推断设备健康。"></app-empty-state>`}
    </app-card>`;
  }
  private renderOverview() {
    const item = this.overview, state = item ? runState(item) : 'unknown';
    return html`<div class="overview-grid"><app-card><h2 slot="header">当前需要关注</h2>
      ${this.overviewLoading ? html`<p role="status">正在读取资源状态与证据…</p>` : nothing}${this.overviewError ? html`<p role="alert">${this.overviewError}</p>` : nothing}
      <h3>${({normal:'当前观测未提示运行异常',abnormal:'存在需要核对的异常',unavailable:'资源当前不可用',unknown:'当前证据不足以判断运行状态'})[state]}</h3>
      <p>${item && !item.gaps.includes('ALERTS_UNAVAILABLE') ? `未解决告警 ${item.alertsTruncated ? '至少 ' : ''}${item.unresolvedAlerts} 项。` : '告警证据尚不可用。'} 状态只反映已有观测。</p>
      <button class="btn" @click=${()=>this.activeTab='metrics'}>核对指标与时间范围</button><button class="btn" @click=${()=>{this.activeTab='interfaces';void this.loadInterfaces();}}>查看接口维度</button>
      <section><h3>证据缺口</h3><p>${!item ? '尚未取得此资源的证据快照。' : freshness(item)!=='fresh' ? '观测缺失、过期或读取失败，请核对观测时间与采集配置。' : item.quality!=='good' || item.gaps.length ? '当前证据不完整，请核对指标能力、告警与关联关系。' : '当前快照未报告缺口；不代表已覆盖全部信号。'}</p>
      <button class="btn" @click=${()=>this.activeTab='collection'}>查看采集配置</button>${item?.gaps.length ? html`<details><summary>查看缺口原始标识</summary>${item.gaps.join(' · ')}</details>` : nothing}</section>
    </app-card><app-card><h2 slot="header">资源与能力</h2><dl><dt>设备</dt><dd>${this.device!.host}:${this.device!.snmp_port}</dd><dt>型号</dt><dd>${this.device!.model || '未知'}</dd><dt>最近状态检查（含失败尝试）</dt><dd>${this.device!.last_check_at ? new Date(this.device!.last_check_at).toLocaleString('zh-CN') : '未知'}</dd><dt>可用证据</dt><dd>指标、接口、关联关系、配置备份；以各页实际读取结果为准。</dd></dl></app-card></div>`;
  }

  private async loadBackupSchedule(id: number) {
    const version = this.contextVersion;
    this.scheduleError = '';
    try { const schedule = await this.json<BackupSchedule>(`/api/network-devices/${id}/backup-schedule`); if (version === this.contextVersion && id === this.validId()) this.backupSchedule = schedule; }
    catch (error) { if (version === this.contextVersion) { this.backupSchedule = null; this.scheduleError = networkDeviceError(error, '无法加载定时备份设置'); } }
  }

  private async saveBackupSchedule() {
    const id = this.validId();
    if (id === null || !this.backupSchedule || this.scheduleSaving) return;
    const { enabled, dailyTime } = this.backupSchedule;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyTime)) {
      this.scheduleError = '请选择有效的每日执行时间'; return;
    }
    const version = this.contextVersion;
    this.scheduleSaving = true;
    this.scheduleError = '';
    try {
      const saved = await this.json<BackupSchedule>(`/api/network-devices/${id}/backup-schedule`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, dailyTime }),
      });
      if (version !== this.contextVersion || id !== this.validId()) return;
      this.backupSchedule = saved;
      showToast('定时备份设置已保存', 'success');
    } catch (error) { if (version === this.contextVersion) this.scheduleError = networkDeviceError(error, '保存定时备份设置失败'); }
    finally { if (version === this.contextVersion) this.scheduleSaving = false; }
  }

  private navigateBack() { if (returnToDashboard()) return;
    window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab: "network-devices" } }));
  }

  private async captureBackup() {
    const id = this.validId();
    if (id === null || this.backupLoading) return;
    const version = this.contextVersion;
    this.backupLoading = true;
    try {
      const body = await this.json<ConfigBackupSummary>(`/api/network-devices/${id}/config-backups`, { method: "POST" });
      if (version !== this.contextVersion || id !== this.validId()) return;
      showToast(`配置备份 v${body.versionNo ?? "?"} 已完成`, "success");
      await this.loadContext();
    } catch (error) {
      if (version === this.contextVersion) showToast(networkDeviceError(error, '配置备份失败'), 'error');
    } finally {
      if (version === this.contextVersion) this.backupLoading = false;
    }
  }

  private async openBackup(backup: ConfigBackupSummary) {
    const id = this.validId();
    if (id === null || this.selectedBackupLoading) return;
    const version = this.contextVersion;
    this.selectedBackupLoading = true;
    try {
      const detail = await this.json<ConfigBackupDetail>(`/api/network-devices/${id}/config-backups/${backup.id}`);
      if (version === this.contextVersion && id === this.validId()) this.selectedBackup = detail;
    } catch (error) {
      if (version === this.contextVersion) showToast(networkDeviceError(error, '无法打开备份'), "error");
    } finally {
      if (version === this.contextVersion) this.selectedBackupLoading = false;
    }
  }

  private statusLabel(status: string) {
    return ({ online: "在线", offline: "离线", unreachable: "不可达", error: "异常", unknown: "未知" } as Record<string, string>)[status] ?? status;
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
      network-device-detail { display:block; min-width:0; }
      network-device-detail .overview-grid { display:grid;grid-template-columns:2fr 1fr;gap:var(--space-md); }
      network-device-detail h2 { margin:0;font-size:16px; }
      network-device-detail h3 { font-size:14px; }
      network-device-detail p, network-device-detail dd { overflow-wrap:anywhere; }
      network-device-detail section { border-top:1px solid var(--border);margin-top:var(--space-md); }
      network-device-detail .interface-filters { display:flex;flex-wrap:wrap;gap:var(--space-sm);align-items:end; }
      network-device-detail .interface-filters label { display:grid;gap:var(--space-xs);max-width:100%;font-size:12px; }
      network-device-detail .interface-filters input, network-device-detail .interface-filters select { min-width:0;max-width:100%;box-sizing:border-box;background:var(--card);color:var(--text);padding:var(--space-sm);border:1px solid var(--border);border-radius:var(--radius-sm); }
      @media(max-width:800px) {network-device-detail .overview-grid { grid-template-columns:minmax(0,1fr); } }
      network-device-detail .page { display:grid; grid-template-columns:minmax(0,1fr); gap:var(--space-lg); min-width:0; width:100%; }
      network-device-detail .page > * { min-width:0; max-width:100%; }
      network-device-detail .header-actions { box-sizing:border-box; }
      network-device-detail .header-actions svg, network-device-detail .title .btn-ghost svg { width:16px; height:16px; flex-shrink:0; }
      network-device-detail app-data-table { overflow-wrap:anywhere; }
      network-device-detail .header { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--space-md); flex-wrap:wrap; border-bottom:1px solid var(--border); padding-bottom:var(--space-md); }
      network-device-detail .title { min-width:0; }
      network-device-detail .title h1 { margin:0; font-size:24px; color:var(--text-strong); overflow-wrap:anywhere; }
      network-device-detail .meta { font-size:12px; white-space:normal; margin-top:var(--space-xs); color:var(--muted); overflow-wrap:anywhere; }
      network-device-detail .header-actions { display:flex; flex-wrap:wrap; gap:var(--space-sm); align-items:center; }
      network-device-detail .tabs { display:flex; gap:var(--space-xs); overflow-x:auto; border-bottom:1px solid var(--border); }
      network-device-detail .tab { border:0; border-bottom:2px solid transparent; background:transparent; color:var(--muted); padding:var(--space-sm) var(--space-md); cursor:pointer; white-space:nowrap; }
      network-device-detail .tab.active { color:var(--accent-text); border-bottom-color:var(--accent); }
      network-device-detail .summary-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:var(--space-md); }
      network-device-detail .summary-grid app-card { text-align:center; }
      network-device-detail .summary-label { color:var(--muted); font-size:var(--text-sm); }
      network-device-detail .summary-value { color:var(--text-strong); font-size:var(--text-xl); font-weight:700; margin-top:var(--space-sm); }
      network-device-detail .evidence-row { display:flex; gap:var(--space-sm); flex-wrap:wrap; align-items:center; }
      network-device-detail .metric-chip { display:inline-flex; align-items:center; gap:var(--space-xs); border:1px solid var(--border); border-radius:var(--radius-sm); padding:var(--space-xs) var(--space-sm); color:var(--muted); font-size:var(--text-xs); }
      network-device-detail /* Keep dense evidence tables usable on phones without widening the page. */
      .page app-data-table { display:block; max-width:100%; overflow-x:auto; }
      network-device-detail .page app-data-table .data-table { min-width:640px; }
      network-device-detail /* The legacy sessions responsive rules are global; infrastructure tables
         must retain relation/action columns so their workflows remain usable. */
      .page app-data-table .data-table th:nth-child(3), network-device-detail .page app-data-table .data-table td:nth-child(3), network-device-detail .page app-data-table .data-table th:nth-child(6), network-device-detail .page app-data-table .data-table td:nth-child(6) { display:table-cell; }
      network-device-detail .backup-note { color:var(--muted); font-size:var(--text-sm); margin-bottom:var(--space-md); }
      network-device-detail .loading, network-device-detail .error { padding:var(--space-xl); text-align:center; color:var(--muted); }
      network-device-detail .error { color:var(--danger); }
      network-device-detail .preview { white-space:pre-wrap; overflow:auto; max-height:55vh; background:var(--bg-elevated); border:1px solid var(--border); padding:var(--space-md); border-radius:var(--radius-sm); font-family:var(--font-mono, monospace); font-size:var(--text-xs); }
      @media (max-width:800px) {network-device-detail .summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
      @media (max-width:520px) {network-device-detail .title h1 { font-size:22px; }
      network-device-detail .summary-grid { grid-template-columns:minmax(0,1fr); }
      network-device-detail .header-actions { width:100%; }
      network-device-detail .header-actions .btn, network-device-detail .header-actions .btn-primary { flex:1; justify-content:center; } }
    </style>
    ${id === null ? html`<div class="error">网络设备 ID 无效</div>` : this.loading ? html`<div class="loading" role="status">正在加载设备数据…</div>` : this.error ? html`<div class="error" role="alert">${this.error}<br><button class="btn" type="button" @click=${this.loadContext}>重试</button></div>` : this.device ? html`<div class="page">
      <div class="header"><div class="title"><button class="btn-ghost" type="button" @click=${this.navigateBack}>${icons["chevron-left"]} 网络设备</button><h1>${this.device.label || this.device.name}</h1><div class="meta">${this.device.host}:${this.device.snmp_port} · ${this.device.vendor === "cisco" ? "Cisco" : "Huawei"} ${this.device.os_version || ""} · 观测于 ${this.overview?.observedAt ? new Date(this.overview.observedAt).toLocaleString('zh-CN') : '未知'}</div><div class="meta">详情成功读取：${this.lastRead ? new Date(this.lastRead).toLocaleString('zh-CN') : '未知'}（非资源观测）</div></div><div class="header-actions"><app-badge variant=${this.overview && ['abnormal','unavailable'].includes(runState(this.overview)) ? 'warn' : 'muted'}>${this.overview ? ({normal:'当前观测未提示异常',abnormal:'异常',unavailable:'不可用',unknown:'待确认'})[runState(this.overview)] : '待确认'}</app-badge><button class="btn" type="button" @click=${this.loadContext}>刷新</button><button class="btn-primary" type="button" @click=${this.captureBackup} .disabled=${this.backupLoading}>${icons.save} ${this.backupLoading ? "备份中…" : "立即备份"}</button></div></div>
      <resource-investigation-links resourceType="network_device" .resourceId=${id}></resource-investigation-links>
      <div class="tabs" role="tablist" aria-label="网络设备详情页签">${(["overview", "metrics", "interfaces", "relations", "backups", "collection"] as DetailTab[]).map((tab) => html`<button role="tab" aria-selected=${String(this.activeTab === tab)} class="tab ${this.activeTab === tab ? "active" : ""}" type="button" @click=${() => { const config = this.renderRoot.querySelector("metric-configuration") as import("../components/metric-configuration.js").MetricConfiguration | null; if (config) config.confirmDiscard(() => { this.activeTab = tab; if(tab === 'interfaces') void this.loadInterfaces(); }); else { this.activeTab = tab; if(tab === 'interfaces') void this.loadInterfaces(); } }}>${tab === "metrics" ? "指标与趋势" : tab === "collection" ? "采集配置" : tab === "overview" ? "概览" : tab === "interfaces" ? "接口" : tab === "relations" ? "关联资源" : "配置备份"}</button>`)}</div>
      ${this.activeTab === "collection" ? html`<metric-configuration resourceType="network_device" .resourceId=${this.validId()}></metric-configuration>` : this.activeTab === 'overview' ? this.renderOverview() : this.activeTab === 'interfaces' ? this.renderInterfaces() : this.activeTab === 'metrics' ? html`<semantic-metrics resourceType="network_device" .resourceId=${this.validId()}></semantic-metrics>` : this.activeTab === "relations" ? this.renderRelations() : html`${this.renderBackupSchedule()}${this.renderBackups()}`}
    </div>` : nothing}
    ${this.selectedBackup ? html`<app-dialog .open=${true} size="xl" title=${`配置备份 v${this.selectedBackup.versionNo}`} @app-dialog-close=${() => (this.selectedBackup = null)}><p class="meta">备份时间 ${new Date(this.selectedBackup.collectedAt).toLocaleString()} · SHA-256 ${this.selectedBackup.contentSha256}</p><pre class="preview">${this.selectedBackup.preview}</pre><div slot="footer"><button class="btn" type="button" @click=${() => (this.selectedBackup = null)}>关闭</button></div></app-dialog>` : nothing}`;
  }
}
