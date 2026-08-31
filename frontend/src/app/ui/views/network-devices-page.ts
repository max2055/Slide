import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";
import { icons } from "../../../icons.js";
import type { NetworkDevice, NetworkDeviceStatus, NetworkDeviceSnmpCredential } from "../../../api/generated/public-api.js";
import { showToast } from "../components/app-toast-container.js";
import { sharedResourceToolbarCssText } from "../../styles/shared-resource-toolbar-styles.ts";
import "../components/app-badge.js";
import "../components/app-card.js";
import "../components/app-data-table.js";
import "../components/app-dialog.js";
import "../components/app-empty-state.js";
import "../components/app-form-field.js";

type DeviceForm = {
  name: string;
  label: string;
  host: string;
  site: string;
  model: string;
  osVersion: string;
  serialNumber: string;
  snmpPort: number;
  sshPort: number;
  collectionEnabled: boolean;
  username: string;
  securityLevel: NetworkDeviceSnmpCredential["securityLevel"];
  authProtocol: "SHA" | "MD5";
  authSecret: string;
  privacyProtocol: "AES" | "DES";
  privacySecret: string;
  sshCredentialType: "password" | "key";
  sshUsername: string;
  sshCredentialValue: string;
  hostKeyFingerprint: string;
};

const EMPTY_FORM: DeviceForm = {
  name: "", label: "", host: "", site: "", model: "", osVersion: "", serialNumber: "",
  snmpPort: 161, sshPort: 22, collectionEnabled: true, username: "", securityLevel: "authPriv",
  authProtocol: "SHA", authSecret: "", privacyProtocol: "AES", privacySecret: "", sshCredentialType: "password",
  sshUsername: "", sshCredentialValue: "", hostKeyFingerprint: "",
};

function responseBody(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({}));
}

@customElement("network-devices-page")
export class NetworkDevicesPage extends LitElement {
  createRenderRoot() { return this; }

  @state() private devices: NetworkDevice[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private search = "";
  @state() private siteFilter = "all";
  @state() private statusFilter = "all";
  @state() private showDialog = false;
  @state() private editingId: number | null = null;
  @state() private saving = false;
  @state() private testing = false;
  @state() private probingId: number | null = null;
  @state() private form: DeviceForm = { ...EMPTY_FORM };
  @state() private formError: string | null = null;

  override firstUpdated() { void this.loadDevices(); }

  async loadDevices(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const response = await authFetch("/api/network-devices");
      if (!response.ok) {
        const body = await responseBody(response);
        throw new Error(String(body.error || "加载网络设备失败"));
      }
      const value = await response.json();
      this.devices = Array.isArray(value) ? value as NetworkDevice[] : [];
    } catch (error) {
      this.error = error instanceof Error ? error.message : "加载网络设备失败";
    } finally {
      this.loading = false;
    }
  }

  private filteredDevices(): NetworkDevice[] {
    const query = this.search.trim().toLowerCase();
    return this.devices.filter((device) => {
      const matchesQuery = !query || [device.name, device.label, device.host, device.site, device.model]
        .some((value) => String(value ?? "").toLowerCase().includes(query));
      return matchesQuery
        && (this.siteFilter === "all" || (device.site ?? "") === this.siteFilter)
        && (this.statusFilter === "all" || device.status === this.statusFilter);
    });
  }

  private get activeFilterCount(): number {
    return [this.search.trim(), this.siteFilter, this.statusFilter]
      .filter((value) => Boolean(value) && value !== "all").length;
  }

  private resetFilters() {
    this.search = "";
    this.siteFilter = "all";
    this.statusFilter = "all";
  }

  private statusVariant(status: NetworkDeviceStatus): "ok" | "warn" | "danger" | "muted" {
    if (status === "online") return "ok";
    if (status === "error") return "danger";
    if (status === "unreachable") return "warn";
    return "muted";
  }

  private statusLabel(status: NetworkDeviceStatus): string {
    return ({ online: "在线", offline: "离线", unreachable: "不可达", error: "异常", unknown: "未知" } as Record<string, string>)[status] ?? status;
  }

  private openCreate() {
    this.editingId = null;
    this.form = { ...EMPTY_FORM };
    this.formError = null;
    this.showDialog = true;
  }

  private async openEdit(device: NetworkDevice) {
    this.editingId = device.id;
    this.form = {
      ...EMPTY_FORM,
      name: device.name,
      label: device.label ?? "",
      host: device.host,
      site: device.site ?? "",
      model: device.model ?? "",
      osVersion: device.os_version ?? "",
      serialNumber: device.serial_number ?? "",
      snmpPort: device.snmp_port,
      sshPort: device.ssh_port,
      collectionEnabled: device.collection_enabled,
    };
    this.formError = null;
    this.showDialog = true;
  }

  private closeDialog() {
    if (!this.saving && !this.testing) this.showDialog = false;
  }

  private updateForm<K extends keyof DeviceForm>(key: K, value: DeviceForm[K]) {
    this.form = { ...this.form, [key]: value };
  }

  private credentialPayload(): NetworkDeviceSnmpCredential | undefined {
    if (!this.form.username.trim()) return undefined;
    const credential: NetworkDeviceSnmpCredential = {
      username: this.form.username.trim(),
      securityLevel: this.form.securityLevel,
      authProtocol: this.form.authProtocol,
      privacyProtocol: this.form.privacyProtocol,
    };
    if (this.form.authSecret) credential.authSecret = this.form.authSecret;
    if (this.form.privacySecret) credential.privacySecret = this.form.privacySecret;
    return credential;
  }

  private sshPayload() {
    const hasAny = this.form.sshUsername.trim() || this.form.sshCredentialValue || this.form.hostKeyFingerprint.trim();
    if (!hasAny) return undefined;
    return {
      protocol: "ssh" as const,
      credentialType: this.form.sshCredentialType,
      username: this.form.sshUsername.trim(),
      credentialValue: this.form.sshCredentialValue,
      hostKeyFingerprint: this.form.hostKeyFingerprint.trim(),
    };
  }

  private requestPayload() {
    const credential = this.credentialPayload();
    const ssh = this.sshPayload();
    return {
      name: this.form.name.trim(), label: this.form.label.trim() || null, host: this.form.host.trim(),
      site: this.form.site.trim() || null, vendor: "huawei", model: this.form.model.trim() || null,
      osVersion: this.form.osVersion.trim() || null, serialNumber: this.form.serialNumber.trim() || null,
      snmpPort: Number(this.form.snmpPort), sshPort: Number(this.form.sshPort),
      collectionEnabled: this.form.collectionEnabled, ...(credential ? { snmpv3: credential } : {}), ...(ssh ? { ssh } : {}),
    };
  }

  private async saveDevice() {
    if (this.saving) return;
    if (!this.form.name.trim() || !this.form.host.trim()) {
      this.formError = "名称和主机不能为空";
      return;
    }
    if (!this.editingId && !this.credentialPayload()) {
      this.formError = "请配置 SNMPv3 凭据";
      return;
    }
    const ssh = this.sshPayload();
    if (ssh && (!ssh.username || !ssh.credentialValue || !ssh.hostKeyFingerprint)) {
      this.formError = "请完整填写 SSH 凭据和主机密钥指纹，或全部留空";
      return;
    }
    this.saving = true;
    this.formError = null;
    try {
      const response = await authFetch(this.editingId ? `/api/network-devices/${this.editingId}` : "/api/network-devices", {
        method: this.editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.requestPayload()),
      });
      if (!response.ok) {
        const body = await responseBody(response);
        throw new Error(String(body.error || "保存网络设备失败"));
      }
      this.showDialog = false;
      await this.loadDevices();
      showToast(this.editingId ? "网络设备已更新" : "网络设备已添加", "success");
    } catch (error) {
      this.formError = error instanceof Error ? error.message : "保存网络设备失败";
    } finally {
      this.saving = false;
    }
  }

  private async testConnection() {
    if (this.testing) return;
    if (!this.form.host.trim() || !this.credentialPayload()) {
      this.formError = "探测需要填写主机和 SNMPv3 凭据";
      return;
    }
    this.testing = true;
    this.formError = null;
    try {
      const ssh = this.sshPayload();
      if (ssh && (!ssh.username || !ssh.credentialValue || !ssh.hostKeyFingerprint)) {
        this.formError = "请完整填写 SSH 凭据和主机密钥指纹，或全部留空";
        return;
      }
      const response = await authFetch("/api/network-devices/test-connection", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: this.form.host.trim(), vendor: "huawei", version: 3, snmpPort: Number(this.form.snmpPort), snmpv3: this.credentialPayload(), ...(ssh ? { ssh } : {}) }),
      });
      const body = await responseBody(response);
      if (!response.ok || body.success === false) throw new Error(String(body.error || "探测失败"));
      showToast("SNMPv3 探测成功", "success");
    } catch (error) {
      this.formError = error instanceof Error ? error.message : "探测失败";
    } finally {
      this.testing = false;
    }
  }

  private async probe(device: NetworkDevice) {
    if (this.probingId !== null) return;
    this.probingId = device.id;
    try {
      const response = await authFetch(`/api/network-devices/${device.id}/probe`, { method: "POST" });
      const body = await responseBody(response);
      if (!response.ok || body.success === false) throw new Error(String(body.error || "采集失败"));
      showToast("已开始采集", "success");
      await this.loadDevices();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "采集失败", "error");
    } finally {
      this.probingId = null;
    }
  }

  private navigate(deviceId: number) {
    window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab: "network-device-detail", networkDeviceId: deviceId } }));
  }

  private columns() {
    return [
      { key: "device", label: "设备" }, { key: "host", label: "主机" }, { key: "site", label: "站点" },
      { key: "status", label: "状态", textAlign: "center" }, { key: "collection", label: "采集", textAlign: "center" },
      { key: "lastCheck", label: "上次检查", textAlign: "center" }, { key: "actions", label: "操作", textAlign: "center" },
    ];
  }

  private rows() {
    return this.filteredDevices().map((device) => ({
      device: html`<button class="link-button" type="button" @click=${() => this.navigate(device.id)}>${device.label || device.name}</button>`,
      host: device.host,
      site: device.site || "--",
      status: html`<app-badge variant=${this.statusVariant(device.status)}>${this.statusLabel(device.status)}</app-badge>`,
      collection: html`<app-badge variant=${device.collection_enabled ? "ok" : "muted"}>${device.collection_enabled ? "已启用" : "已停用"}</app-badge>`,
      lastCheck: device.last_check_at ? new Date(device.last_check_at).toLocaleString("zh-CN") : "--",
      actions: html`<div class="actions">
        <button class="btn-ghost" type="button" title="查看详情" aria-label="查看 ${device.name} 详情" @click=${() => this.navigate(device.id)}>${icons["chevron-right"]}</button>
        <button class="btn" type="button" @click=${() => this.probe(device)} .disabled=${this.probingId === device.id}>${this.probingId === device.id ? "…" : "采集"}</button>
        <button class="btn" type="button" @click=${() => this.openEdit(device)}>编辑</button>
      </div>`,
    }));
  }

  private renderDialog() {
    if (!this.showDialog) return nothing;
    return html`<app-dialog .open=${true} size="lg" title=${this.editingId ? "编辑网络设备" : "添加网络设备"} .closeOnOverlay=${false} @app-dialog-close=${this.closeDialog}>
      <div class="form-grid">
        <div class="form-row"><app-form-field label="名称" required><input class="field" .value=${this.form.name} @input=${(e: Event) => this.updateForm("name", (e.target as HTMLInputElement).value)}></app-form-field>
          <app-form-field label="主机" required><input class="field" .value=${this.form.host} @input=${(e: Event) => this.updateForm("host", (e.target as HTMLInputElement).value)}></app-form-field></div>
        <div class="form-row"><app-form-field label="标签"><input class="field" .value=${this.form.label} @input=${(e: Event) => this.updateForm("label", (e.target as HTMLInputElement).value)}></app-form-field>
          <app-form-field label="站点"><input class="field" .value=${this.form.site} @input=${(e: Event) => this.updateForm("site", (e.target as HTMLInputElement).value)}></app-form-field></div>
        <div class="form-row"><app-form-field label="型号"><input class="field" .value=${this.form.model} @input=${(e: Event) => this.updateForm("model", (e.target as HTMLInputElement).value)}></app-form-field>
          <app-form-field label="VRP 版本"><input class="field" .value=${this.form.osVersion} @input=${(e: Event) => this.updateForm("osVersion", (e.target as HTMLInputElement).value)}></app-form-field></div>
        <div class="form-row"><app-form-field label="SNMP 端口"><input class="field" type="number" .value=${String(this.form.snmpPort)} @input=${(e: Event) => this.updateForm("snmpPort", Number((e.target as HTMLInputElement).value) || 161)}></app-form-field>
          <app-form-field label="SSH 端口"><input class="field" type="number" .value=${String(this.form.sshPort)} @input=${(e: Event) => this.updateForm("sshPort", Number((e.target as HTMLInputElement).value) || 22)}></app-form-field></div>
        <app-form-field label="SNMPv3 用户名" required><input class="field" autocomplete="off" .value=${this.form.username} @input=${(e: Event) => this.updateForm("username", (e.target as HTMLInputElement).value)}></app-form-field>
        <div class="form-row"><app-form-field label="安全级别"><select class="field" .value=${this.form.securityLevel} @change=${(e: Event) => this.updateForm("securityLevel", (e.target as HTMLSelectElement).value as DeviceForm["securityLevel"])}><option value="authPriv">authPriv</option><option value="authNoPriv">authNoPriv</option><option value="noAuthNoPriv">noAuthNoPriv</option></select></app-form-field>
          <app-form-field label="认证协议"><select class="field" .value=${this.form.authProtocol} @change=${(e: Event) => this.updateForm("authProtocol", (e.target as HTMLSelectElement).value as DeviceForm["authProtocol"])}><option value="SHA">SHA</option><option value="MD5">MD5</option></select></app-form-field></div>
        <div class="form-row"><app-form-field label="认证密钥"><input class="field" type="password" autocomplete="new-password" .value=${this.form.authSecret} @input=${(e: Event) => this.updateForm("authSecret", (e.target as HTMLInputElement).value)}></app-form-field>
          <app-form-field label="隐私密钥"><input class="field" type="password" autocomplete="new-password" .value=${this.form.privacySecret} @input=${(e: Event) => this.updateForm("privacySecret", (e.target as HTMLInputElement).value)}></app-form-field></div>
        <div class="credential-section"><div class="section-title">SSH 凭据 <span class="section-hint">监控可选；加密配置备份需要填写。</span></div>
          <div class="form-row"><app-form-field label="SSH 凭据类型"><select class="field" .value=${this.form.sshCredentialType} @change=${(e: Event) => this.updateForm("sshCredentialType", (e.target as HTMLSelectElement).value as DeviceForm["sshCredentialType"])}><option value="password">密码</option><option value="key">私钥</option></select></app-form-field>
            <app-form-field label="SSH 用户名"><input class="field" autocomplete="off" .value=${this.form.sshUsername} @input=${(e: Event) => this.updateForm("sshUsername", (e.target as HTMLInputElement).value)}></app-form-field></div>
          <div class="form-row"><app-form-field label=${this.form.sshCredentialType === "key" ? "SSH 私钥" : "SSH 密码"}><input class="field" type=${this.form.sshCredentialType === "key" ? "text" : "password"} autocomplete="new-password" .value=${this.form.sshCredentialValue} @input=${(e: Event) => this.updateForm("sshCredentialValue", (e.target as HTMLInputElement).value)}></app-form-field>
            <app-form-field label="主机密钥指纹"><input class="field" placeholder="SHA256:..." autocomplete="off" .value=${this.form.hostKeyFingerprint} @input=${(e: Event) => this.updateForm("hostKeyFingerprint", (e.target as HTMLInputElement).value)}></app-form-field></div>
        </div>
        ${this.formError ? html`<div class="form-error" role="alert">${this.formError}</div>` : nothing}
      </div>
      <div slot="footer" class="dialog-actions"><button class="btn" type="button" @click=${this.testConnection} .disabled=${this.testing}>${this.testing ? "探测中…" : "测试 SNMPv3"}</button><span></span><button class="btn" type="button" @click=${this.closeDialog}>取消</button><button class="btn-primary" type="button" @click=${this.saveDevice} .disabled=${this.saving}>${this.saving ? "保存中…" : "保存"}</button></div>
    </app-dialog>`;
  }

  render() {
    const sites = [...new Set(this.devices.map((device) => device.site).filter((site): site is string => Boolean(site)))].sort();
    const filtered = this.filteredDevices();
    return html`<style>
      ${sharedResourceToolbarCssText}
      :host { display:block; }
      .resource-toolbar { margin-bottom: 0; }
      .field { box-sizing:border-box; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--card); color:var(--text); padding:var(--space-sm) var(--space-md); }
      .actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:var(--space-xs); }
      .link-button { border:0; padding:0; color:var(--accent); background:transparent; cursor:pointer; font:inherit; text-align:left; }
      .loading, .error { padding:var(--space-xl); color:var(--muted); text-align:center; }
      .error { color:var(--danger); }
      .form-grid { display:grid; gap:var(--space-md); }
      .form-row { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-md); }
      .dialog-actions { display:flex; align-items:center; justify-content:flex-end; gap:var(--space-sm); }
      .dialog-actions > span { flex:1; }
      .form-error { color:var(--danger); font-size:var(--text-sm); overflow-wrap:anywhere; }
      .credential-section { border-top:1px solid var(--border); padding-top:var(--space-md); display:grid; gap:var(--space-sm); }
      .section-title { color:var(--text-strong); font-weight:600; }
      .section-hint { color:var(--muted); font-size:var(--text-sm); font-weight:400; }
      @media (max-width:600px) { .form-row { grid-template-columns:minmax(0,1fr); } }
    </style>
    ${this.loading ? html`<div class="loading" role="status">正在加载网络设备…</div>` : this.error ? html`<app-card><div class="error" role="alert">${this.error}<br><button class="btn" type="button" @click=${this.loadDevices}>重试</button></div></app-card>` : html`
      <app-card .compact=${true}>
        <div class="resource-toolbar">
          <div class="resource-search">
            <span class="search-icon">${icons.search}</span>
            <input class="resource-search-input" aria-label="搜索网络设备" placeholder="搜索名称、主机、站点" .value=${this.search} @input=${(e: Event) => (this.search = (e.target as HTMLInputElement).value)}>
          </div>
          <select class="resource-filter" aria-label="站点筛选" .value=${this.siteFilter} @change=${(e: Event) => (this.siteFilter = (e.target as HTMLSelectElement).value)}><option value="all">全部站点</option>${sites.map((site) => html`<option value=${site}>${site}</option>`)}</select>
          <select class="resource-filter" aria-label="状态筛选" .value=${this.statusFilter} @change=${(e: Event) => (this.statusFilter = (e.target as HTMLSelectElement).value)}><option value="all">全部状态</option><option value="online">在线</option><option value="offline">离线</option><option value="unreachable">不可达</option><option value="error">异常</option></select>
          <div class="toolbar-actions">
            ${this.activeFilterCount > 0 ? html`<button class="btn-ghost resource-filter-reset" type="button" @click=${this.resetFilters}>重置筛选</button>` : nothing}
            <button class="btn" type="button" @click=${this.loadDevices}>${icons.refresh} 刷新</button>
            <button class="btn-primary" type="button" @click=${this.openCreate}>${icons.plus} 添加设备</button>
          </div>
        </div>
        <div class="resource-toolbar-meta" aria-live="polite">
          <span class="resource-result-count">共 ${filtered.length} 台网络设备</span>
          ${this.activeFilterCount > 0 ? html`<span class="resource-filter-state">已启用 ${this.activeFilterCount} 项筛选</span>` : html`<span>未启用筛选</span>`}
        </div>
        ${filtered.length ? html`<app-data-table .columns=${this.columns()} .rows=${this.rows()}></app-data-table>` : html`<app-empty-state title="暂无网络设备" description="添加网络设备以开始只读采集。" icon="globe"></app-empty-state>`}
      </app-card>`}
    ${this.renderDialog()}`;
  }
}
