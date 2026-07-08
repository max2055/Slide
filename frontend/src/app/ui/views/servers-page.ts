import { LitElement, html, css, nothing } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state } from "lit/decorators.js";
import "../components/app-dialog.js";
import "../components/app-form-field.js";
import "../components/app-badge.js";
import "../components/app-empty-state.js";
import "../components/app-data-table.js";
import "../components/app-card.js";
import { icons } from "../../../icons.js";
import { authFetch } from "../../../api/index.js";
import { showToast } from "../components/app-toast-container.js";

interface ServerRow {
  id: number;
  host: string;
  port: number;
  label: string | null;
  os_type: string;
  credential_type: "password" | "key";
  status: "online" | "offline" | "error" | "unreachable";
  last_check_at: string | null;
  collection_enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface ServerFormData {
  host: string;
  port: number;
  label: string;
  os_type: string;
  credential_type: "password" | "key";
  credential_username: string;
  credential_value: string;
}

interface KeyRotationForm {
  credential_type: "password" | "key";
  credential_username: string;
  credential_value: string;
}

interface MetricSummaryEntry {
  server_id: number;
  metric_name: string;
  metric_value: number;
  recorded_at: string;
}

interface MetricSummaryData {
  servers: Record<number, { metrics: MetricSummaryEntry[]; recorded_at: string | null }>;
  recorded_at: string | null;
}

@customElement("servers-page")
export class ServersPage extends LitElement {
  static styles = [sharedBtnStyles, css`
    :host {
      display: block;
      animation: fade-in 0.25s var(--ease-out);
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .page {
      padding: 0;
    }

    /* Form styles */
    .form-input,
    .form-select,
    .form-textarea {
      width: 100%;
      box-sizing: border-box;
      padding: var(--space-md) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-base);
      color: var(--text);
      background: var(--card);
      transition: all 0.15s ease;
    }

    .form-input:focus,
    .form-select:focus,
    .form-textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-subtle);
    }

    .form-textarea {
      resize: none;
      min-height: 80px;
    }

    /* Override browser autofill light-blue background */
    .form-input:-webkit-autofill,
    .form-input:-webkit-autofill:hover,
    .form-input:-webkit-autofill:focus {
      -webkit-box-shadow: 0 0 0 30px var(--card, #fff) inset !important;
      -webkit-text-fill-color: var(--text, #1a1a1e) !important;
      caret-color: var(--text, #1a1a1e);
      transition: background-color 5000s ease-in-out 0s;
    }

    /* Actions */
    .actions {
      display: flex;
      gap: var(--space-sm);
      justify-content: center;
    }

    .action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-xs) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      font-weight: 500;
      color: var(--text);
      background: var(--secondary);
      cursor: pointer;
      white-space: nowrap;
      transition: all var(--duration-normal) var(--ease-out);
    }

    .action-btn:hover {
      background: var(--accent);
      color: var(--accent-foreground);
      border-color: var(--accent);
    }

    .action-btn.danger {
      color: var(--danger);
      border-color: var(--danger);
    }

    .action-btn.danger:hover {
      background: var(--danger);
      color: var(--danger-foreground);
      border-color: var(--danger);
    }

    .action-btn.icon-btn {
      padding: var(--space-xs);
      border: none;
      background: none;
      color: var(--muted);
      cursor: pointer;
    }

    .action-btn.icon-btn:hover {
      color: var(--text-strong);
      background: var(--bg-hover);
      border-radius: var(--radius-sm);
    }

    .action-btn.icon-btn.danger:hover {
      color: var(--danger);
    }

    .action-btn.icon-btn svg {
      width: 16px;
      height: 16px;
      display: block;
    }

    /* Loading state */
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 300px;
      color: var(--muted);
    }

    /* Dialog form */
    .form-grid {
      display: grid;
      gap: var(--space-md);
    }

    .form-hint {
      font-size: var(--text-sm);
      color: var(--muted);
      margin-top: var(--space-xs);
      line-height: 1.4;
    }

    .radio-group {
      display: flex;
      gap: var(--space-lg);
      padding: var(--space-xs) 0;
    }

    .radio-option {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      cursor: pointer;
      font-size: var(--text-base);
      color: var(--text);
    }

    .radio-option input[type="radio"] {
      accent-color: var(--accent);
    }

    .dialog-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-md);
      padding: var(--space-lg) var(--space-xl);
      border-top: 1px solid var(--border);
    }

    .dialog-footer-right {
      display: flex;
      gap: var(--space-md);
      align-items: center;
    }

    .test-result {
      margin-top: var(--space-sm);
      padding: var(--space-md) var(--space-md);
      border-radius: var(--radius-sm);
      font-size: var(--text-base);
      display: flex;
      align-items: center;
      gap: var(--space-sm);
    }

    .test-result.success {
      background: var(--ok-subtle);
      color: var(--ok);
    }

    .test-result.error {
      background: var(--danger-subtle);
      color: var(--danger);
    }

    .toolbar {
      display: flex;
      justify-content: flex-end;
      padding: var(--space-md) var(--space-lg);
      border-bottom: 1px solid var(--border);
    }
  `];

  @state() private _servers: ServerRow[] = [];
  @state() private _loading = true;
  @state() private _showDialog = false;
  @state() private _editingId: number | null = null;
  @state() private _showDeleteDialog = false;
  @state() private _deletingServer: ServerRow | null = null;
  @state() private _showKeyRotationDialog = false;
  @state() private _keyRotationServer: ServerRow | null = null;
  @state() private _testingConnection = false;
  @state() private _isSubmitting = false;
  @state() private _form: ServerFormData = {
    host: "",
    port: 22,
    label: "",
    os_type: "CentOS",
    credential_type: "password",
    credential_username: "root",
    credential_value: "",
  };
  @state() private _keyRotationForm: KeyRotationForm = {
    credential_type: "password",
    credential_username: "root",
    credential_value: "",
  };
  @state() private _testConnectionMessage = "";
  @state() private _testConnectionSuccess: boolean | null = null;
  @state() private _metricSummary: MetricSummaryData | null = null;

  override firstUpdated() {
    this._loadServers();
  }

  private async _loadServers() {
    this._loading = true;
    try {
      const [serversRes, metricsRes] = await Promise.all([
        authFetch("/api/servers"),
        authFetch("/api/servers/metrics/summary"),
      ]);
      if (serversRes.status === 401) {
        alert("请先登录");
        window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab: "chat" } }));
        return;
      }
      if (!serversRes.ok) throw new Error("加载服务器列表失败");
      this._servers = await serversRes.json();
      if (metricsRes.ok) {
        this._metricSummary = await metricsRes.json();
      }
    } catch (err: any) {
      showToast(err.message || "网络错误", "error");
    } finally {
      this._loading = false;
    }
  }

  private _openAddDialog() {
    this._editingId = null;
    this._form = {
      host: "",
      port: 22,
      label: "",
      os_type: "CentOS",
      credential_type: "password",
      credential_username: "root",
      credential_value: "",
    };
    this._testConnectionMessage = "";
    this._testConnectionSuccess = null;
    this._testingConnection = false;
    this._showDialog = true;
  }

  private _openEditDialog(server: ServerRow) {
    this._editingId = server.id;
    this._form = {
      host: server.host,
      port: server.port,
      label: server.label || "",
      os_type: server.os_type,
      credential_type: server.credential_type,
      credential_username: "",
      credential_value: "",
    };
    this._testConnectionMessage = "";
    this._testConnectionSuccess = null;
    this._testingConnection = false;
    this._showDialog = true;
  }

  private _closeDialog() {
    this._showDialog = false;
    this._editingId = null;
    this._testConnectionMessage = "";
    this._testConnectionSuccess = null;
  }

  private _updateForm<K extends keyof ServerFormData>(field: K, value: ServerFormData[K]) {
    this._form = { ...this._form, [field]: value };
  }

  private async _handleSubmit() {
    if (this._isSubmitting) return;

    if (!this._form.host || !this._form.credential_username) {
      showToast("请填写主机地址和SSH用户名", "warning");
      return;
    }

    this._isSubmitting = true;
    try {
      const isEdit = this._editingId !== null;
      const url = isEdit ? `/api/servers/${this._editingId}` : "/api/servers";
      const body: Record<string, unknown> = { ...this._form };
      if (isEdit) {
        if (!body.credential_value) delete body.credential_value;
        if (!body.credential_username) delete body.credential_username;
      }

      const res = await authFetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "保存失败");
      }

      this._closeDialog();
      await this._loadServers();
      showToast(isEdit ? "服务器已更新" : "服务器已添加", "success");
    } catch (err: any) {
      showToast(`保存失败: ${err.message}`, "error");
    } finally {
      this._isSubmitting = false;
    }
  }

  private _confirmDelete(server: ServerRow) {
    this._deletingServer = server;
    this._showDeleteDialog = true;
  }

  private _closeDeleteDialog() {
    this._showDeleteDialog = false;
    this._deletingServer = null;
  }

  private async _handleDelete() {
    if (!this._deletingServer) return;

    try {
      const res = await authFetch(`/api/servers/${this._deletingServer.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "删除失败");
      }
      this._closeDeleteDialog();
      await this._loadServers();
      showToast("服务器已删除", "success");
    } catch (err: any) {
      showToast(`删除失败: ${err.message}`, "error");
    }
  }

  private async _handleTestConnection() {
    if (!this._form.host || !this._form.credential_username) {
      showToast("请先填写主机地址和SSH用户名", "warning");
      return;
    }

    this._testingConnection = true;
    this._testConnectionMessage = "";
    this._testConnectionSuccess = null;

    try {
      const res = await authFetch("/api/servers/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: this._form.host,
          port: this._form.port,
          credential_type: this._form.credential_type,
          credential_username: this._form.credential_username,
          credential_value: this._form.credential_value,
        }),
      });
      const result = await res.json();

      if (result.success) {
        this._testConnectionSuccess = true;
        this._testConnectionMessage = `连接成功：${this._form.host}:${this._form.port}`;
        showToast(this._testConnectionMessage, "success");
      } else {
        this._testConnectionSuccess = false;
        this._testConnectionMessage = `连接失败：${result.error || "未知错误"}`;
        showToast(this._testConnectionMessage, "error");
      }
    } catch (err: any) {
      this._testConnectionSuccess = false;
      this._testConnectionMessage = `连接失败：${err.message}`;
      showToast(this._testConnectionMessage, "error");
    } finally {
      this._testingConnection = false;
    }
  }

  private _openKeyRotation(server: ServerRow) {
    this._keyRotationServer = server;
    this._keyRotationForm = {
      credential_type: server.credential_type,
      credential_username: "",
      credential_value: "",
    };
    this._showKeyRotationDialog = true;
  }

  private _closeKeyRotation() {
    this._showKeyRotationDialog = false;
    this._keyRotationServer = null;
  }

  private async _handleKeyRotation() {
    if (!this._keyRotationServer || !this._keyRotationForm.credential_value) {
      showToast("请填写凭据值", "warning");
      return;
    }

    try {
      const res = await authFetch(`/api/servers/${this._keyRotationServer.id}/rotate-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this._keyRotationForm),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "密钥轮换失败");
      }
      this._closeKeyRotation();
      await this._loadServers();
      showToast("密钥已轮换", "success");
    } catch (err: any) {
      showToast(`密钥轮换失败: ${err.message}`, "error");
    }
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

  private _usageVariant(value: number | null): string {
    if (value === null) return "muted";
    if (value >= 80) return "danger";
    if (value >= 50) return "warn";
    return "ok";
  }

  private _getServerMetric(serverId: number, metricName: string): MetricSummaryEntry | null {
    if (!this._metricSummary) return null;
    const serverMetrics = this._metricSummary.servers?.[serverId];
    if (!serverMetrics) return null;
    return serverMetrics.metrics.find(m => m.metric_name === metricName) || null;
  }

  private _navigateToDetail(serverId: number) {
    window.dispatchEvent(new CustomEvent("slide-navigate", {
      detail: { tab: "server-detail", serverId },
    }));
  }

  private _getColumns() {
    return [
      { key: "host", label: "主机" },
      { key: "label", label: "标签" },
      { key: "os_type", label: "操作系统" },
      { key: "cpu", label: "CPU" },
      { key: "memory", label: "内存" },
      { key: "disk", label: "磁盘" },
      { key: "status", label: "状态" },
      { key: "last_collection", label: "上次采集" },
      { key: "actions", label: "操作" },
    ];
  }

  private _getRows() {
    return this._servers.map((srv) => {
      const cpuMetric = this._getServerMetric(srv.id, "cpu_usage");
      const memMetric = this._getServerMetric(srv.id, "memory_usage");
      const diskMetric = this._getServerMetric(srv.id, "disk_usage");
      const cpuValue = cpuMetric?.metric_value ?? null;
      const memValue = memMetric?.metric_value ?? null;
      const diskValue = diskMetric?.metric_value ?? null;

      return {
        host: html`
          <div style="font-weight:600;color:var(--text-strong);font-size:var(--text-md);cursor:pointer;"
               @click=${() => this._navigateToDetail(srv.id)}
               title="查看服务器详情">
            ${srv.host}
          </div>
          ${srv.label ? html`<div style="font-size:var(--text-sm);color:var(--muted);margin-top:var(--space-xs);">${srv.label}</div>` : nothing}`,
        label: srv.label || html`<span style="color:var(--muted);">—</span>`,
        os_type: html`<app-badge variant="muted">${srv.os_type}</app-badge>`,
        cpu: html`<app-badge variant="${this._usageVariant(cpuValue)}">CPU ${cpuValue != null ? cpuValue.toFixed(1) + "%" : "--"}</app-badge>`,
        memory: html`<app-badge variant="${this._usageVariant(memValue)}">内存 ${memValue != null ? memValue.toFixed(1) + "%" : "--"}</app-badge>`,
        disk: html`<app-badge variant="${this._usageVariant(diskValue)}">磁盘 ${diskValue != null ? diskValue.toFixed(1) + "%" : "--"}</app-badge>`,
        status: html`<app-badge variant="${this._statusBadgeVariant(srv.status)}">${this._statusLabel(srv.status)}</app-badge>`,
        last_collection: html`<span style="font-size:var(--text-sm);color:var(--muted);">${this._formatLastCheck(srv.last_check_at)}</span>`,
        actions: html`
          <div class="actions">
            <button class="action-btn icon-btn" @click=${() => this._openEditDialog(srv)} title="编辑">
              ${icons['edit']}
            </button>
            <button class="action-btn icon-btn" @click=${() => this._openKeyRotation(srv)} title="密钥轮换">
              ${icons['refresh-cw']}
            </button>
            <button class="action-btn icon-btn danger" @click=${() => this._confirmDelete(srv)} title="删除">
              ${icons['trash']}
            </button>
          </div>`,
      };
    });
  }

  private _formatLastCheck(lastCheckAt: string | null): string {
    if (!lastCheckAt) return "--";
    const diffMs = Date.now() - new Date(lastCheckAt).getTime();
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return "刚刚";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} 天前`;
    return new Date(lastCheckAt).toLocaleDateString("zh-CN");
  }

  override render() {
    if (this._loading) {
      return html`<div class="page"><div class="loading">加载中...</div></div>`;
    }

    if (this._servers.length === 0) {
      return html`
        <div class="page">
          <app-card>
            <span slot="header">服务器管理</span>
            <div class="toolbar">
              <button class="btn-primary" @click=${this._openAddDialog}>
                + 添加服务器
              </button>
            </div>
            <app-empty-state
              title="暂无服务器"
              description="点击上方添加按钮创建第一个服务器"
              icon="server"
            ></app-empty-state>
          </app-card>
        </div>
      `;
    }

    const columns = this._getColumns();
    const rows = this._getRows();

    return html`
      <div class="page">
        <app-card>
          <span slot="header">服务器管理</span>
          <div class="toolbar">
            <button class="btn-primary" @click=${this._openAddDialog}>
              + 添加服务器
            </button>
          </div>
          <app-data-table .columns=${columns} .rows=${rows}></app-data-table>
        </app-card>

        <!-- Add/Edit Dialog -->
        ${this._renderFormDialog()}

        <!-- Delete Confirmation Dialog -->
        ${this._renderDeleteDialog()}

        <!-- Key Rotation Dialog -->
        ${this._renderKeyRotationDialog()}
      </div>
    `;
  }

  private _renderFormDialog() {
    if (!this._showDialog) return nothing;

    const title = this._editingId ? "编辑服务器" : "添加服务器";

    return html`
      <app-dialog .open=${true} size="md" title=${title} @app-dialog-close=${this._closeDialog}>
        <div class="form-grid">
          <app-form-field label="IP/主机名" required>
            <input class="form-input" type="text" .value=${this._form.host}
              @input=${(e: any) => this._updateForm("host", e.target.value)}
              placeholder="192.168.1.100" />
          </app-form-field>

          <app-form-field label="SSH端口">
            <input class="form-input" type="number" .value=${this._form.port}
              @input=${(e: any) => this._updateForm("port", parseInt(e.target.value) || 22)}
              placeholder="22" />
          </app-form-field>

          <app-form-field label="标签 (可选)">
            <input class="form-input" type="text" .value=${this._form.label}
              @input=${(e: any) => this._updateForm("label", e.target.value)}
              placeholder="例如：生产环境主服务器" />
          </app-form-field>

          <app-form-field label="操作系统">
            <select class="form-select" .value=${this._form.os_type}
              @change=${(e: any) => this._updateForm("os_type", e.target.value)}>
              <option value="CentOS">CentOS</option>
              <option value="Ubuntu">Ubuntu</option>
              <option value="Debian">Debian</option>
              <option value="RHEL">RHEL</option>
              <option value="Other">Other</option>
            </select>
          </app-form-field>

          <app-form-field label="SSH认证方式">
            <div class="radio-group">
              <label class="radio-option">
                <input type="radio" name="credential_type" value="password"
                  ?checked=${this._form.credential_type === "password"}
                  @change=${() => this._updateForm("credential_type", "password")} />
                密码
              </label>
              <label class="radio-option">
                <input type="radio" name="credential_type" value="key"
                  ?checked=${this._form.credential_type === "key"}
                  @change=${() => this._updateForm("credential_type", "key")} />
                SSH密钥
              </label>
            </div>
          </app-form-field>

          <app-form-field label="SSH用户名" required>
            <input class="form-input" type="text" .value=${this._form.credential_username}
              @input=${(e: any) => this._updateForm("credential_username", e.target.value)}
              placeholder="root" />
          </app-form-field>

          <app-form-field
            label=${this._form.credential_type === "password" ? "密码" : "SSH私钥"}
            required=${!this._editingId}>
            ${this._form.credential_type === "password"
              ? html`<input class="form-input" type="password" autocomplete="new-password"
                  .value=${this._form.credential_value}
                  @input=${(e: any) => this._updateForm("credential_value", e.target.value)}
                  placeholder=${this._editingId ? "留空表示不修改" : ""} />`
              : html`<textarea class="form-textarea" .value=${this._form.credential_value}
                  @input=${(e: any) => this._updateForm("credential_value", e.target.value)}
                  placeholder=${this._editingId ? "留空表示不修改" : ""} rows="4"></textarea>`
            }
          </app-form-field>

          <div class="form-hint">凭据将使用 AES-256-CBC 加密存储</div>

          ${this._testConnectionMessage
            ? html`
                <div class="test-result ${this._testConnectionSuccess ? "success" : "error"}">
                  ${this._testConnectionMessage}
                </div>`
            : nothing}
        </div>

        <div slot="footer" class="dialog-footer">
          <div></div>
          <div class="dialog-footer-right">
            <button class="btn" @click=${this._handleTestConnection} ?disabled=${this._testingConnection}>
              ${this._testingConnection ? "测试中..." : "测试连接"}
            </button>
            <button class="btn" @click=${this._closeDialog}>取消</button>
            <button class="btn-primary" @click=${this._handleSubmit} ?disabled=${this._isSubmitting}>
              ${this._isSubmitting ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </app-dialog>
    `;
  }

  private _renderDeleteDialog() {
    if (!this._showDeleteDialog || !this._deletingServer) return nothing;

    return html`
      <app-dialog .open=${true} size="sm" title="确认删除" @app-dialog-close=${this._closeDeleteDialog}>
        <div style="text-align:center;padding:var(--space-md) 0">
          <div style="margin-bottom:var(--space-md);color:var(--warn);display:flex;justify-content:center;">
            ${icons['triangle-alert']}
          </div>
          <div style="font-size:var(--text-md);color:var(--muted);">
            确定要删除服务器 ${this._deletingServer.host} 吗？此操作不可撤销。
          </div>
        </div>
        <div slot="footer" style="display:flex;justify-content:center;gap:var(--space-md);">
          <button class="btn" @click=${this._closeDeleteDialog}>取消</button>
          <button class="btn danger" @click=${this._handleDelete}
            style="background:var(--danger);color:white;border-color:var(--danger);">确认删除</button>
        </div>
      </app-dialog>
    `;
  }

  private _renderKeyRotationDialog() {
    if (!this._showKeyRotationDialog || !this._keyRotationServer) return nothing;

    return html`
      <app-dialog .open=${true} size="sm" title="密钥轮换" @app-dialog-close=${this._closeKeyRotation}>
        <div class="form-grid">
          <div style="font-size:var(--text-base);color:var(--text-strong);font-weight:500;margin-bottom:var(--space-sm);">
            服务器：${this._keyRotationServer.host}
          </div>

          <app-form-field label="新凭据类型">
            <div class="radio-group">
              <label class="radio-option">
                <input type="radio" name="kr_credential_type" value="password"
                  ?checked=${this._keyRotationForm.credential_type === "password"}
                  @change=${() => (this._keyRotationForm = { ...this._keyRotationForm, credential_type: "password" })} />
                密码
              </label>
              <label class="radio-option">
                <input type="radio" name="kr_credential_type" value="key"
                  ?checked=${this._keyRotationForm.credential_type === "key"}
                  @change=${() => (this._keyRotationForm = { ...this._keyRotationForm, credential_type: "key" })} />
                SSH密钥
              </label>
            </div>
          </app-form-field>

          <app-form-field label="新用户名" required>
            <input class="form-input" type="text" .value=${this._keyRotationForm.credential_username}
              @input=${(e: any) => (this._keyRotationForm = { ...this._keyRotationForm, credential_username: e.target.value })} />
          </app-form-field>

          <app-form-field label=${this._keyRotationForm.credential_type === "password" ? "新密码" : "新SSH私钥"} required>
            ${this._keyRotationForm.credential_type === "password"
              ? html`<input class="form-input" type="password" autocomplete="new-password"
                  .value=${this._keyRotationForm.credential_value}
                  @input=${(e: any) => (this._keyRotationForm = { ...this._keyRotationForm, credential_value: e.target.value })} />`
              : html`<textarea class="form-textarea" rows="4"
                  .value=${this._keyRotationForm.credential_value}
                  @input=${(e: any) => (this._keyRotationForm = { ...this._keyRotationForm, credential_value: e.target.value })}></textarea>`
            }
          </app-form-field>
        </div>

        <div slot="footer" style="display:flex;justify-content:flex-end;gap:var(--space-md);">
          <button class="btn" @click=${this._closeKeyRotation}>取消</button>
          <button class="btn-primary" @click=${this._handleKeyRotation}>确认轮换</button>
        </div>
      </app-dialog>
    `;
  }
}

// Guard against duplicate registration during HMR
if (!customElements.get("servers-page")) {
  customElements.define("servers-page", ServersPage);
}
