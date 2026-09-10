import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";
import { icons } from "../../../icons.js";
import type { NetworkDevice, NetworkDeviceStatus, NetworkDeviceSnmpCredential, NetworkDeviceSnmpV2Credential, NetworkDeviceVendor } from "../../../api/generated/public-api.js";
import { showToast } from "../components/app-toast-container.js";
import { sharedResourceToolbarCssText } from "../../styles/shared-resource-toolbar-styles.ts";
import "../components/app-badge.js";
import "../components/app-card.js";
import "../components/app-data-table.js";
import "../components/app-dialog.js";
import "../components/app-empty-state.js";
import "../components/app-form-field.js";
import "../components/app-ssh-auth-selector.js";

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
  vendor: NetworkDeviceVendor;
  snmpVersion: 2 | 3;
  username: string;
  community: string;
  securityLevel: NetworkDeviceSnmpCredential["securityLevel"];
  authProtocol: "SHA" | "MD5";
  authSecret: string;
  privacyProtocol: "AES" | "DES";
  privacySecret: string;
  sshCredentialType: "password" | "key";
  sshUsername: string;
  sshCredentialValue: string;
};

const EMPTY_FORM: DeviceForm = {
  name: "", label: "", host: "", site: "", model: "", osVersion: "", serialNumber: "",
  snmpPort: 161, sshPort: 22, collectionEnabled: true, vendor: "huawei", snmpVersion: 2, username: "", community: "", securityLevel: "authPriv",
  authProtocol: "SHA", authSecret: "", privacyProtocol: "AES", privacySecret: "", sshCredentialType: "password",
  sshUsername: "", sshCredentialValue: "",
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
  @state() private testingSsh = false;
  @state() private testingDeviceId: number | null = null;
  @state() private deletingDevice: NetworkDevice | null = null;
  @state() private deleting = false;
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
      vendor: device.vendor === "cisco" ? "cisco" : "huawei",
    };
    this.formError = null;
    this.showDialog = true;
  }

  private closeDialog() {
    if (!this.saving && !this.testing && !this.testingSsh) this.showDialog = false;
  }

  private updateForm<K extends keyof DeviceForm>(key: K, value: DeviceForm[K]) {
    this.form = { ...this.form, [key]: value };
  }

  private credentialPayload(): NetworkDeviceSnmpCredential | NetworkDeviceSnmpV2Credential | undefined {
    if (this.form.snmpVersion === 2) {
      if (!this.form.community.trim()) return undefined;
      return { version: 2, community: this.form.community.trim() };
    }
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
    const hasAny = this.form.sshUsername.trim() || this.form.sshCredentialValue;
    if (!hasAny) return undefined;
    return {
      protocol: "ssh" as const,
      credentialType: this.form.sshCredentialType,
      username: this.form.sshUsername.trim(),
      credentialValue: this.form.sshCredentialValue,
    };
  }

  private requestPayload() {
    const credential = this.credentialPayload();
    const ssh = this.sshPayload();
    return {
      name: this.form.name.trim(), label: this.form.label.trim() || null, host: this.form.host.trim(),
      site: this.form.site.trim() || null, vendor: this.form.vendor, model: this.form.model.trim() || null,
      osVersion: this.form.osVersion.trim() || null, serialNumber: this.form.serialNumber.trim() || null,
      snmpPort: Number(this.form.snmpPort), sshPort: Number(this.form.sshPort),
      collectionEnabled: this.form.collectionEnabled, ...(credential ? (this.form.snmpVersion === 2 ? { snmpv2c: credential } : { snmpv3: credential }) : {}), ...(ssh ? { ssh } : {}),
    };
  }

  private async saveDevice() {
    if (this.saving) return;
    if (!this.form.name.trim() || !this.form.host.trim()) {
      this.formError = "名称和主机不能为空";
      return;
    }
    if (!this.editingId && !this.credentialPayload()) {
      this.formError = `请配置 SNMPv${this.form.snmpVersion === 2 ? "2c" : "3"} 凭据`;
      return;
    }
    const ssh = this.sshPayload();
    if (ssh && (!ssh.username || !ssh.credentialValue)) {
      this.formError = "请完整填写 SSH 用户名和凭据，或全部留空";
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
      this.formError = `探测需要填写主机和 SNMPv${this.form.snmpVersion === 2 ? "2c" : "3"} 凭据`;
      return;
    }
    this.testing = true;
    this.formError = null;
    try {
      const ssh = this.sshPayload();
      if (ssh && (!ssh.username || !ssh.credentialValue)) {
        this.formError = "请完整填写 SSH 用户名和凭据，或全部留空";
        return;
      }
      const response = await authFetch("/api/network-devices/test-connection", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: this.form.host.trim(), vendor: this.form.vendor, version: this.form.snmpVersion, snmpPort: Number(this.form.snmpPort), ...(this.form.snmpVersion === 2 ? { snmpv2c: this.credentialPayload() } : { snmpv3: this.credentialPayload() }), ...(ssh ? { ssh } : {}) }),
      });
      const body = await responseBody(response);
      if (!response.ok || body.success === false) throw new Error(String(body.error || "探测失败"));
      showToast(`SNMPv${this.form.snmpVersion === 2 ? "2c" : "3"} 探测成功`, "success");
    } catch (error) {
      this.formError = error instanceof Error ? error.message : "探测失败";
    } finally {
      this.testing = false;
    }
  }

  private async testSshConnection() {
    if (this.testingSsh) return;
    const ssh = this.sshPayload();
    if (!this.form.host.trim() || !ssh?.username || !ssh.credentialValue) {
      this.formError = "SSH 测试需要填写主机、用户名和凭据";
      return;
    }
    this.testingSsh = true;
    this.formError = null;
    try {
      const response = await authFetch("/api/network-devices/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "ssh", host: this.form.host.trim(), sshPort: Number(this.form.sshPort), ssh }),
      });
      const body = await responseBody(response);
      if (!response.ok || body.success === false) throw new Error(String(body.error || "SSH 连接失败"));
      showToast("SSH 连接成功", "success");
    } catch (error) {
      this.formError = error instanceof Error ? error.message : "SSH 连接失败";
    } finally {
      this.testingSsh = false;
    }
  }

  private async testDevice(device: NetworkDevice) {
    if (this.testingDeviceId !== null) return;
    this.testingDeviceId = device.id;
    try {
      const response = await authFetch(`/api/network-devices/${device.id}/probe`, { method: "POST" });
      const body = await responseBody(response);
      if (!response.ok || body.success === false) throw new Error(String(body.error || "测试失败"));
      showToast("连接测试成功，指标已刷新", "success");
      await this.loadDevices();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "测试失败", "error");
    } finally {
      this.testingDeviceId = null;
    }
  }

  private confirmDelete(device: NetworkDevice) {
    this.deletingDevice = device;
  }

  private closeDeleteDialog() {
    if (!this.deleting) this.deletingDevice = null;
  }

  private async deleteDevice() {
    const device = this.deletingDevice;
    if (!device || this.deleting) return;
    this.deleting = true;
    try {
      const response = await authFetch(`/api/network-devices/${device.id}`, { method: "DELETE" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(String(body.error || "删除失败"));
      this.deletingDevice = null;
      await this.loadDevices();
      showToast("网络设备已删除", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "删除失败", "error");
    } finally {
      this.deleting = false;
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
        <button class="btn-sm" type="button" @click=${() => this.navigate(device.id)}>详情</button>
        <button class="btn-sm" type="button" @click=${() => this.openEdit(device)}>编辑</button>
        <button class="btn-sm" type="button" @click=${() => this.testDevice(device)} .disabled=${this.testingDeviceId === device.id}>${this.testingDeviceId === device.id ? "测试中…" : "测试"}</button>
        <button class="btn-sm danger" type="button" @click=${() => this.confirmDelete(device)}>删除</button>
      </div>`,
    }));
  }

  private renderDialog() {
    if (!this.showDialog) return nothing;
    return html`<app-dialog .open=${true} size="xl" title=${this.editingId ? "编辑网络设备" : "添加网络设备"} .closeOnOverlay=${false} @app-dialog-close=${this.closeDialog}>
      <div class="device-form">
        <section class="device-form-section">
          <div class="section-heading">
            <h3>基本信息</h3>
            <span>用于识别和定位网络设备</span>
          </div>
          <div class="device-form-row"><app-form-field label="名称" required .inline=${true}><input class="field" .value=${this.form.name} @input=${(e: Event) => this.updateForm("name", (e.target as HTMLInputElement).value)}></app-form-field>
          <app-form-field label="主机" required .inline=${true}><input class="field" .value=${this.form.host} @input=${(e: Event) => this.updateForm("host", (e.target as HTMLInputElement).value)}></app-form-field></div>
          <div class="device-form-row"><app-form-field label="厂商" .inline=${true}><select class="field" .value=${this.form.vendor} @change=${(e: Event) => this.updateForm("vendor", (e.target as HTMLSelectElement).value as NetworkDeviceVendor)}><option value="huawei">Huawei</option><option value="cisco">Cisco</option></select></app-form-field>
          <app-form-field label="型号（可选）" .inline=${true}><input class="field" .value=${this.form.model} @input=${(e: Event) => this.updateForm("model", (e.target as HTMLInputElement).value)}></app-form-field></div>
          <div class="device-form-row"><app-form-field label="OS 版本（可选）" .inline=${true}><input class="field" .value=${this.form.osVersion} @input=${(e: Event) => this.updateForm("osVersion", (e.target as HTMLInputElement).value)}></app-form-field></div>
          <div class="device-form-row"><app-form-field label="SNMP 端口" .inline=${true}><input class="field" type="number" .value=${String(this.form.snmpPort)} @input=${(e: Event) => this.updateForm("snmpPort", Number((e.target as HTMLInputElement).value) || 161)}></app-form-field>
          <app-form-field label="SSH 端口" .inline=${true}><input class="field" type="number" .value=${String(this.form.sshPort)} @input=${(e: Event) => this.updateForm("sshPort", Number((e.target as HTMLInputElement).value) || 22)}></app-form-field></div>
        </section>
        <section class="device-form-section">
          <div class="section-heading">
            <h3>SNMP 监控</h3>
            <span>协议版本与厂商无关，用于只读指标采集</span>
          </div>
          <div class="device-form-row"><app-form-field label="SNMP 版本" .inline=${true}><select class="field" .value=${String(this.form.snmpVersion)} @change=${(e: Event) => this.updateForm("snmpVersion", Number((e.target as HTMLSelectElement).value) as 2 | 3)}><option value="2">SNMPv2c</option><option value="3">SNMPv3</option></select></app-form-field>
          ${this.form.snmpVersion === 2 ? html`<app-form-field label="Community" required .inline=${true}><input class="field" autocomplete="off" type="password" .value=${this.form.community} @input=${(e: Event) => this.updateForm("community", (e.target as HTMLInputElement).value)}></app-form-field>` : html`<app-form-field label="SNMPv3 用户名" required .inline=${true}><input class="field" autocomplete="off" .value=${this.form.username} @input=${(e: Event) => this.updateForm("username", (e.target as HTMLInputElement).value)}></app-form-field>`}</div>
          ${this.form.snmpVersion === 3 ? html`<div class="device-form-row"><app-form-field label="安全级别" .inline=${true}><select class="field" .value=${this.form.securityLevel} @change=${(e: Event) => this.updateForm("securityLevel", (e.target as HTMLSelectElement).value as DeviceForm["securityLevel"])}><option value="authPriv">authPriv</option><option value="authNoPriv">authNoPriv</option><option value="noAuthNoPriv">noAuthNoPriv</option></select></app-form-field>
          <app-form-field label="认证协议" .inline=${true}><select class="field" .value=${this.form.authProtocol} @change=${(e: Event) => this.updateForm("authProtocol", (e.target as HTMLSelectElement).value as DeviceForm["authProtocol"])}><option value="SHA">SHA</option><option value="MD5">MD5</option></select></app-form-field></div>
          <div class="device-form-row"><app-form-field label="认证密钥" .inline=${true}><input class="field" type="password" autocomplete="new-password" .value=${this.form.authSecret} @input=${(e: Event) => this.updateForm("authSecret", (e.target as HTMLInputElement).value)}></app-form-field>
          <app-form-field label="隐私密钥" .inline=${true}><input class="field" type="password" autocomplete="new-password" .value=${this.form.privacySecret} @input=${(e: Event) => this.updateForm("privacySecret", (e.target as HTMLInputElement).value)}></app-form-field></div>` : nothing}
        </section>
        <section class="device-form-section device-form-section--ssh credential-section">
          <div class="section-heading">
            <h3>SSH 凭据</h3>
            <span>监控可选；加密配置备份需要填写</span>
          </div>
          <div class="device-form-row"><app-form-field label="SSH 认证方式" .inline=${true}><app-ssh-auth-selector .value=${this.form.sshCredentialType} @ssh-auth-change=${(event: CustomEvent<{ value: DeviceForm["sshCredentialType"] }>) => this.updateForm("sshCredentialType", event.detail.value)}></app-ssh-auth-selector></app-form-field>
          <app-form-field label="SSH 用户名" .inline=${true}><input class="field" autocomplete="off" .value=${this.form.sshUsername} @input=${(e: Event) => this.updateForm("sshUsername", (e.target as HTMLInputElement).value)}></app-form-field></div>
          <div class="device-form-row"><app-form-field label=${this.form.sshCredentialType === "key" ? "SSH 私钥" : "SSH 密码"} .inline=${true}><input class="field" type=${this.form.sshCredentialType === "key" ? "text" : "password"} autocomplete="new-password" .value=${this.form.sshCredentialValue} @input=${(e: Event) => this.updateForm("sshCredentialValue", (e.target as HTMLInputElement).value)}></app-form-field></div>
        </section>
        ${this.formError ? html`<div class="form-error" role="alert">${this.formError}</div>` : nothing}
      </div>
      <div slot="footer" class="dialog-actions"><div class="dialog-test-actions"><button class="btn" type="button" @click=${this.testConnection} .disabled=${this.testing || this.testingSsh}>${this.testing ? "探测中…" : `测试 SNMPv${this.form.snmpVersion === 2 ? "2c" : "3"}`}</button><button class="btn" type="button" @click=${this.testSshConnection} .disabled=${this.testing || this.testingSsh}>${this.testingSsh ? "测试中…" : "测试 SSH"}</button></div><span class="dialog-spacer" aria-hidden="true"></span><button class="btn" type="button" @click=${this.closeDialog}>取消</button><button class="btn-primary" type="button" @click=${this.saveDevice} .disabled=${this.saving}>${this.saving ? "保存中…" : "保存"}</button></div>
    </app-dialog>`;
  }

  private renderDeleteDialog() {
    const device = this.deletingDevice;
    if (!device) return nothing;
    return html`<app-dialog .open=${true} size="sm" title="确认删除网络设备" .closeOnOverlay=${false} @app-dialog-close=${this.closeDeleteDialog}>
      <p>确定删除“${device.label || device.name}”吗？此操作不可撤销。</p>
      <div slot="footer" class="dialog-actions">
        <button class="btn" type="button" @click=${this.closeDeleteDialog} .disabled=${this.deleting}>取消</button>
        <button class="btn-primary btn-danger" type="button" @click=${this.deleteDevice} .disabled=${this.deleting}>${this.deleting ? "删除中…" : "确认删除"}</button>
      </div>
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
      .device-form { display:grid; gap:var(--space-lg); max-width:760px; margin:0 auto; --app-form-field-label-width:160px; }
      .device-form-section { display:grid; gap:var(--space-md); padding:var(--space-md); border:1px solid var(--border); border-radius:var(--radius-md); background:var(--bg-elevated); }
      .device-form-section--ssh { background:color-mix(in srgb, var(--bg-elevated) 72%, var(--accent-subtle)); }
      .section-heading { display:flex; align-items:baseline; justify-content:space-between; gap:var(--space-md); padding-bottom:var(--space-sm); border-bottom:1px solid var(--border); }
      .section-heading h3 { margin:0; color:var(--text-strong); font-size:var(--text-md); font-weight:600; }
      .section-heading span { color:var(--muted); font-size:var(--text-xs); text-align:right; }
      .device-form-row { display:contents; }
      .device-form-row app-form-field { min-width:0; margin-bottom:0; }
      .device-form-row .field { width:100%; min-width:0; }
      .dialog-actions { display:flex; align-items:center; justify-content:flex-end; gap:var(--space-sm); }
      .dialog-test-actions { display:flex; align-items:center; gap:var(--space-sm); }
      .dialog-actions > .dialog-spacer { flex:1; }
      .dialog-actions .btn,
      .dialog-actions .btn-primary { min-height:40px; }
      .dialog-actions .btn-primary { min-width:88px; }
      .form-error { color:var(--danger); font-size:var(--text-sm); overflow-wrap:anywhere; }
      @media (max-width:680px) {
        .network-device-table .data-table th:nth-child(2),
        .network-device-table .data-table td:nth-child(2) { display:none; }
        .network-device-table .data-table th:nth-child(7),
        .network-device-table .data-table td:nth-child(7) { display:table-cell; }
        .network-device-table .actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }
        .device-form { gap:var(--space-md); }
        .device-form-section { padding:var(--space-sm); }
        .section-heading { align-items:flex-start; flex-direction:column; gap:var(--space-xs); }
        .section-heading span { text-align:left; }
        .dialog-actions { flex-wrap:wrap; }
        .dialog-test-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); width:100%; }
        .dialog-actions > .dialog-spacer { display:none; }
      }
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
            <button class="btn resource-action resource-action--refresh" type="button" .disabled=${this.loading} @click=${this.loadDevices}>${icons.refresh} 刷新</button>
            <button class="btn-primary resource-action resource-action--add" type="button" @click=${this.openCreate}>${icons.plus} 添加设备</button>
          </div>
        </div>
        <div class="resource-toolbar-meta" aria-live="polite">
          <span class="resource-result-count">共 ${filtered.length} 台网络设备</span>
          ${this.activeFilterCount > 0 ? html`<span class="resource-filter-state">已启用 ${this.activeFilterCount} 项筛选</span>` : html`<span>指标由后台按计划自动采集</span>`}
        </div>
        ${filtered.length ? html`<app-data-table class="network-device-table" .columns=${this.columns()} .rows=${this.rows()}></app-data-table>` : html`<app-empty-state title="暂无网络设备" description="添加网络设备以开始只读采集。" icon="globe"></app-empty-state>`}
      </app-card>`}
    ${this.renderDialog()}
    ${this.renderDeleteDialog()}`;
  }
}
