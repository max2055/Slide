import { LitElement, html, css, nothing } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { sharedResourceToolbarStyles } from "../../styles/shared-resource-toolbar-styles.ts";
import { customElement, state } from "lit/decorators.js";
import "../components/app-dialog.js";
import "../components/app-form-field.js";
import "../components/app-empty-state.js";
import "../components/instance-host-field.js";
import { icons } from "../../../icons.js";
import { authFetch } from "../../../api/index.js";
import { showToast } from "../components/app-toast-container.js";
import { resolveHealthScoreState } from "./health-score-state.js";
import type {
  DatabaseInstance,
  InstanceHostMapping,
  InstanceHostsResponse,
  ReplaceInstanceHostsRequest,
  ReplaceInstanceHostsResponse,
} from "../../../api/generated/public-api.js";

interface InstanceFormData {
  name: string;
  environment: string;
  db_type: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database_name: string;
  description: string;
}

export function buildTestConnectionPayload(formData: InstanceFormData) {
  return {
    host: formData.host,
    port: formData.port,
    username: formData.username,
    password: formData.password,
    database_name: formData.database_name,
    db_type: formData.db_type,
  };
}

/** Return a user-facing validation message before sending raw credentials. */
export function validateTestConnectionForm(formData: Pick<InstanceFormData, "host" | "username" | "password">): string | null {
  if (!String(formData.host ?? "").trim()) return "请输入主机地址";
  if (!String(formData.username ?? "").trim()) return "请输入用户名";
  if (!String(formData.password ?? "").trim()) return "请输入密码";
  return null;
}

/** Hide driver-specific authentication wording behind one actionable message. */
export function normalizeConnectionTestMessage(message: unknown): string {
  const text = String(message ?? "").trim();
  if (!text) return "未知错误";
  if (/请输入用户名/i.test(text)) {
    return "请输入用户名";
  }
  if (/(?:ora-(?:01017|24415|28000|28001)|missing\s+or\s+null\s+username|access denied for user[\s\S]*using password|password authentication failed|authentication failed|invalid (?:credentials|username\/?password)|\b(?:er_access_denied(?:_no_password)?_error|er_account_has_been_locked|er_user_access_denied_for_user_account_blocked_by_password_lock|28p0[12]|2800[01]|3118|3955|1698|1045)\b|(?:^|[^\d])-2501(?:\D|$)|用户名或密码错误|认证失败|登录失败)/i.test(text)) {
    return "用户名或密码错误";
  }
  if (/请输入密码/i.test(text)) return "请输入密码";
  return text;
}

function hasStoredPermission(required: string): boolean {
  try {
    const raw = localStorage.getItem("permissions");
    if (!raw) return false;
    const permissions = JSON.parse(raw) as unknown;
    if (!Array.isArray(permissions)) return false;
    const resource = required.split(":", 1)[0];
    return permissions.includes("*")
      || permissions.includes(required)
      || permissions.includes(`${resource}:*`);
  } catch {
    return false;
  }
}

@customElement("instances-page")
export class InstancesPage extends LitElement {
  static styles = [sharedBtnStyles, sharedResourceToolbarStyles, css`
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

    /* 主卡片 */
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      overflow: hidden;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--space-md) var(--space-lg);
      border-bottom: 1px solid var(--border);
      background: var(--bg-elevated);
      flex-wrap: wrap;
      gap: var(--space-md);
    }

    .card-title {
      font-size: var(--text-lg);
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--text-strong);
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }

    .status-dot-ok { background: var(--ok); }
    .status-dot-warn { background: var(--warn); }
    .status-dot-danger { background: var(--danger); }

    /* 表格样式 */
    .table-container {
      overflow-x: auto;
    }

    .table {
      width: 100%;
      min-width: 1200px;
      table-layout: fixed;
      border-collapse: separate;
      border-spacing: 0;
      font-size: var(--text-base);
    }

    .table col.instance-col { width: 15rem; }
    .table col.version-col { width: 12rem; }
    .table col.actions-col { width: 14.5rem; }

    .table th {
      position: sticky;
      top: 0;
      z-index: 3;
      padding: var(--space-md) var(--space-md);
      text-align: center;
      font-weight: 600;
      font-size: var(--text-xs);
      color: var(--muted);
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .table th:first-child {
      text-align: left;
    }
    .table th.sortable {
      cursor: pointer;
      user-select: none;
    }
    .table th.sortable:hover {
      color: var(--text-strong);
    }
    .sort-arrow {
      display: inline-block;
      margin-left: 2px;
      font-size: 10px;
      opacity: 0.4;
    }
    .sort-arrow.active {
      opacity: 1;
    }

    .table td {
      padding: var(--space-md);
      border-bottom: 1px solid var(--border);
      color: var(--text);
      vertical-align: middle;
      text-align: center;
      overflow: hidden;
    }
    .table td:first-child {
      text-align: left;
    }

    .table tbody tr {
      transition: background var(--duration-fast) ease;
    }

    .table tbody tr:hover {
      background: var(--bg-hover);
    }

    .table tbody tr:last-child td {
      border-bottom: none;
    }

    .instance-name {
      font-weight: 600;
      color: var(--text-strong);
      font-size: var(--text-md);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .instance-version {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .instance-meta {
      font-size: var(--text-sm);
      color: var(--muted);
      margin-top: var(--space-xs);
    }

    .type-tag {
      font-size: var(--text-xs);
      font-weight: 500;
      color: var(--muted);
    }

    .type-badge {
      display: inline-flex;
      align-items: center;
      padding: var(--space-xs) var(--space-md);
      background: rgba(59, 130, 246, 0.12);
      color: var(--info);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }


    .indicator {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .health-bar {
      width: 50px;
      height: 4px;
      background: var(--bg-muted);
      border-radius: var(--radius-full);
      overflow: hidden;
    }

    .health-bar-fill {
      height: 100%;
      border-radius: var(--radius-full);
      transition: width 0.3s var(--ease-out);
    }

    .health-score {
      font-weight: 600;
      font-size: var(--text-base);
      min-width: 28px;
      text-align: right;
    }

    .actions {
      display: flex;
      gap: var(--space-sm);
    }

    /* 加载和空状态 */
    .loading, .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 300px;
      color: var(--muted);
    }

    .empty__content {
      text-align: center;
    }

    .empty__icon {
      width: 48px;
      height: 48px;
      margin-bottom: var(--space-md);
      opacity: 0.6;
      color: var(--muted);
    }
    .empty__icon svg {
      width: 16px;
      height: 16px;
    }

    .empty__title {
      font-size: var(--text-lg);
      color: var(--text-strong);
      margin-bottom: var(--space-xs);
    }

    .empty__desc {
      font-size: var(--text-base);
      color: var(--muted);
    }


    .form-group {
      margin-bottom: var(--space-lg);
    }

    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-md) var(--space-lg);
      margin-bottom: var(--space-md);
    }


    .form-label {
      display: block;
      font-size: var(--text-base);
      font-weight: 500;
      color: var(--text);
      margin-bottom: var(--space-sm);
    }

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

    .form-value {
      padding: var(--space-md) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-base);
      color: var(--muted);
      background: var(--bg-app);
    }

    .form-input:focus,
    .form-select:focus,
    .form-textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-subtle);
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

    .form-textarea {
      resize: none;
      min-height: 80px;
    }

    .form-hint {
      font-size: var(--text-sm);
      color: var(--muted);
      margin-top: var(--space-xs);
    }

    .dialog-footer {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-md);
      padding: var(--space-lg) var(--space-xl);
      border-top: 1px solid var(--border);
    }

    .test-result svg {
      width: 14px;
      height: 14px;
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

    /* Confirm Dialog */
    .confirm-dialog .dialog {
      max-width: 400px;
    }

    .confirm-body {
      padding: var(--space-xl) var(--space-xl);
      text-align: center;
    }

    .confirm-icon {
      width: 48px;
      height: 48px;
      margin: 0 auto var(--space-md);
      opacity: 0.6;
      color: var(--warn);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .confirm-icon svg {
      width: 32px;
      height: 32px;
    }

    .confirm-title {
      font-size: var(--text-lg);
      font-weight: 600;
      color: var(--text-strong);
      margin-bottom: var(--space-sm);
    }

    .confirm-text {
      font-size: var(--text-md);
      color: var(--muted);
    }
  `];

  @state() private instances: DatabaseInstance[] = [];
  @state() private loading = true;
  @state() private refreshing = false;
  @state() private error: string | null = null;
  @state() private filter: "all" | "healthy" | "warning" | "critical" = "all";
  @state() private searchQuery = "";
  @state() private sortKey: string = "";
  @state() private sortDir: "asc" | "desc" = "asc";

  @state() private showTestDialog = false;
  @state() private testingInstance: DatabaseInstance | null = null;
  @state() private testPassword = "";
  @state() private listTestStatus: "idle" | "testing" | "success" | "error" = "idle";
  @state() private listTestMessage = "";
  @state() private showEditDialog = false;
  @state() private showDeleteDialog = false;
  @state() private showAddDialog = false;
  @state() private editingInstance: DatabaseInstance | null = null;
  @state() private deletingInstance: DatabaseInstance | null = null;
  @state() private formData: InstanceFormData = {
    name: "",
    environment: "development",
    db_type: "",
    host: "",
    port: 0,
    username: "",
    password: "",
    database_name: "",
    description: "",
  };
  @state() private testStatus: "idle" | "testing" | "success" | "error" = "idle";
  @state() private testMessage = "";
  @state() private isSubmitting = false;
  @state() private instanceHosts: InstanceHostMapping[] | null = [];
  @state() private hostRelationLoading = false;
  @state() private hostRelationError: string | null = null;
  @state() private pendingCreatedInstanceId: number | null = null;
  private hostRelationRequestVersion = 0;
  private readonly handlePermissionsLoaded = () => {
    this.requestUpdate();
    if (this.editingInstance && this.canViewHostRelations) {
      void this._loadInstanceHosts(this.editingInstance.id);
    }
  };

  private get canViewHostRelations(): boolean {
    return hasStoredPermission("servers:view");
  }

  private get canManageHostRelations(): boolean {
    return hasStoredPermission("instance:manage")
      && this.canViewHostRelations
      && hasStoredPermission("servers:manage");
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("slide-permissions-loaded", this.handlePermissionsLoaded);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("slide-permissions-loaded", this.handlePermissionsLoaded);
    super.disconnectedCallback();
  }

  override firstUpdated() {
    this.loadInstances();
  }

  private async loadInstances() {
    try {
      const res = await authFetch("/api/database/instances");
      if (!res.ok) throw new Error("Failed to load instances");
      this.instances = await res.json();
      this.loading = false;
    } catch (err: any) {
      this.error = err.message;
      this.loading = false;
    }
  }

  private async refreshInstances() {
    this.refreshing = true;
    try {
      await this.loadInstances();
    } finally {
      this.refreshing = false;
    }
  }

  private get filteredInstances(): DatabaseInstance[] {
    const filtered = this.instances.filter((inst) => {
      const status = inst.health_status || "unknown";
      const matchesFilter = this.filter === "all" ||
        (this.filter === "healthy" && status === "healthy") ||
        (this.filter === "warning" && status === "warning") ||
        (this.filter === "critical" && (status === "critical" || status === "unknown"));
      const matchesSearch = !this.searchQuery ||
        inst.name.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
        inst.host.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
        inst.db_type.toLowerCase().includes(this.searchQuery.toLowerCase());
      return matchesFilter && matchesSearch;
    });
    if (!this.sortKey) return filtered;
    return [...filtered].sort((a: any, b: any) => {
      const resolveVal = (inst: any, key: string) => {
        if (key === 'addr') return `${inst.host}:${inst.port}`;
        return inst[key] ?? '';
      };
      const va = resolveVal(a, this.sortKey);
      const vb = resolveVal(b, this.sortKey);
      const cmp = typeof va === 'string' ? va.localeCompare(String(vb)) : (va as number) - (vb as number);
      return this.sortDir === 'desc' ? -cmp : cmp;
    });
  }

  private _toggleSort(key: string) {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortKey = key;
      this.sortDir = 'asc';
    }
  }

  private _sortArrow(key: string) {
    if (this.sortKey !== key) return html`<span class="sort-arrow">▾</span>`;
    return html`<span class="sort-arrow active">${this.sortDir === 'asc' ? '▴' : '▾'}</span>`;
  }

  private get stats() {
    return {
      total: this.instances.length,
      healthy: this.instances.filter(i => i.health_status === "healthy").length,
      warning: this.instances.filter(i => i.health_status === "warning").length,
      critical: this.instances.filter(i => i.health_status === "critical" || i.health_status === "unknown").length,
    };
  }

  private get activeFilterCount(): number {
    return [this.searchQuery.trim(), this.filter]
      .filter((value) => Boolean(value) && value !== "all").length;
  }

  private resetFilters() {
    this.searchQuery = "";
    this.filter = "all";
  }

  override render() {
    if (this.loading) {
      return html`<div class="loading">加载中...</div>`;
    }

    if (this.error) {
      return html`<div class="loading" style="color: var(--danger);">${this.error}</div>`;
    }

    const filtered = this.filteredInstances;

    return html`
      <div class="page">
        <!-- 实例列表卡片 -->
        <div class="card">
          <div class="toolbar resource-toolbar">
            <div class="search-box">
              <span class="search-icon"><span style="width:14px;height:14px;display:flex;">${icons['search']}</span></span>
              <input
                class="search-input"
                placeholder="搜索名称、主机、类型..."
                name="search-instances"
                autocomplete="off"
                .value=${this.searchQuery}
                @input=${(e: any) => (this.searchQuery = e.target.value)}
              />
            </div>

            <div class="filter-group">
              <button class="filter-btn ${this.filter === "all" ? "active" : ""}" @click=${() => (this.filter = "all")}>
                全部 (${this.instances.length})
              </button>
              <button class="filter-btn ${this.filter === "healthy" ? "active" : ""}" @click=${() => (this.filter = "healthy")}>
                <span class="status-dot status-dot-ok"></span> 健康 (${this.stats.healthy})
              </button>
              <button class="filter-btn ${this.filter === "warning" ? "active" : ""}" @click=${() => (this.filter = "warning")}>
                <span class="status-dot status-dot-warn"></span> 警告 (${this.stats.warning})
              </button>
              <button class="filter-btn ${this.filter === "critical" ? "active" : ""}" @click=${() => (this.filter = "critical")}>
                <span class="status-dot status-dot-danger"></span> 异常 (${this.stats.critical})
              </button>
            </div>
            <div class="toolbar-actions">
              ${this.activeFilterCount > 0
                ? html`<button class="btn-ghost resource-filter-reset" @click=${this.resetFilters}>重置筛选</button>`
                : nothing}
              <button class="btn resource-action resource-action--refresh" type="button" .disabled=${this.refreshing} @click=${this.refreshInstances}>
                ${icons['refresh']} 刷新
              </button>
              <button class="btn-primary resource-action resource-action--add" type="button" @click=${() => this._addInstance()}>
                ${icons['plus']} 添加实例
              </button>
            </div>
          </div>

          <div class="resource-toolbar-meta" aria-live="polite">
            <span class="resource-result-count">共 ${filtered.length} 个数据库实例</span>
            ${this.activeFilterCount > 0
              ? html`<span class="resource-filter-state">已启用 ${this.activeFilterCount} 项筛选</span>`
              : html`<span>未启用筛选</span>`}
          </div>

          <div class="table-container">
            <table class="table">
                    <colgroup>
                      <col style="width:40px;">
                      <col class="instance-col">
                      <col style="width:72px;">
                      <col class="version-col">
                      <col style="width:90px;">
                      <col style="width:200px;">
                      <col style="width:82px;">
                      <col style="width:80px;">
                      <col class="actions-col">
                    </colgroup>
                    <thead>
                      <tr>
                        <th style="width:40px;text-align:center;">#</th>
                        <th class="sortable" @click=${() => this._toggleSort('name')}>实例 ${this._sortArrow('name')}</th>
                        <th class="sortable" style="width: 60px; text-align:center;" @click=${() => this._toggleSort('db_type')}>类型 ${this._sortArrow('db_type')}</th>
                        <th class="sortable" @click=${() => this._toggleSort('db_version')}>版本 ${this._sortArrow('db_version')}</th>
                        <th class="sortable" style="width: 72px; text-align:center;" @click=${() => this._toggleSort('data_size_gb')}>容量 ${this._sortArrow('data_size_gb')}</th>
                        <th class="sortable" style="width: 170px; text-align:center;" @click=${() => this._toggleSort('addr')}>连接地址 ${this._sortArrow('addr')}</th>
                        <th class="sortable" style="width: 72px; text-align:center;" @click=${() => this._toggleSort('health_status')}>状态 ${this._sortArrow('health_status')}</th>
                        <th class="sortable" style="width: 56px; text-align:center;" @click=${() => this._toggleSort('health_score')}>健康分 ${this._sortArrow('health_score')}</th>
                        <th style="width: 180px; text-align:center;">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${filtered.length > 0 ? filtered.map((inst, idx) => html`
                        <tr class="instance-row">
                          <td style="text-align:center;font-size:var(--text-sm);color:var(--muted);">${idx + 1}</td>
                          <td class="instance-col"><div class="instance-name" title=${inst.name}>${inst.name}</div></td>
                          <td style="text-align:center;">
                            <span class="type-tag">${inst.db_type.toUpperCase()}</span>
                          </td>
                          <td style="text-align:center;">
                            <span class="instance-version" title=${inst.db_version || '—'} style="font-size: var(--text-sm); color: var(--muted);">${inst.db_version || '—'}</span>
                          </td>
                          <td style="text-align:center;">
                            <span style="font-size: var(--text-sm);">${inst.data_size_gb != null ? (inst.data_size_gb === 0 ? '0 GB' : inst.data_size_gb + ' GB') : '—'}</span>
                          </td>
                          <td style="text-align:center;">
                            <span style="font-size: var(--text-base);">${inst.host}<span style="font-weight:500;">:${inst.port}</span></span>
                          </td>
                          <td style="text-align:center;">
                            ${this._renderStatusBadge(inst.health_status)}
                          </td>
                          <td style="text-align:center;">
                            ${(() => {
                              const score = resolveHealthScoreState(inst, inst.health_score);
                              return html`<span style="font-weight: 700; font-size: var(--text-md); color: ${score.score === null ? 'var(--muted)' : this._getHealthColor(score.score)};">${score.score ?? '未知'}</span>`;
                            })()}
                          </td>
                          <td style="text-align:center;">
                            <div class="actions">
                              <button class="btn-sm" @click=${() => this._viewDetail(inst)}>详情</button>
                              <button class="btn-sm" @click=${() => this._editInstance(inst)}>编辑</button>
                              <button class="btn-sm" @click=${() => this._testConnection(inst)}>测试</button>
                              <button class="btn-sm danger" @click=${() => this._deleteInstance(inst)}>删除</button>
                            </div>
                          </td>
                        </tr>
                      `) : html`
                        <tr>
                          <td colspan="9">
                            <app-empty-state
                              title=${this.instances.length === 0 ? "暂无数据库实例" : "没有符合条件的实例"}
                              description=${this.instances.length === 0 ? "点击添加实例开始纳管数据库" : "尝试调整筛选条件"}
                              icon=${this.instances.length === 0 ? "database" : "search"}
                            ></app-empty-state>
                          </td>
                        </tr>
                      `}
                    </tbody>
                  </table>
                </div>
        </div>
      </div>

      ${this._renderAddDialog()}
      ${this._renderEditDialog()}
      ${this._renderDeleteDialog()}
      ${this._renderTestDialog()}
    `;
  }

  private _renderStatusBadge(status: string) {
    const statusMap: Record<string, { class: string; label: string }> = {
      healthy: { class: "ok", label: "健康" },
      warning: { class: "warn", label: "警告" },
      critical: { class: "danger", label: "异常" },
      unknown: { class: "muted", label: "未知" },
    };
    const s = statusMap[status] || { class: "muted", label: status };
    return html`
      <app-badge variant="${status === 'healthy' ? 'ok' : status === 'warning' ? 'warn' : status === 'critical' ? 'danger' : 'muted'}">${s.label}</app-badge>
    `;
  }

  private _getHealthColor(score: number): string {
    if (score >= 80) return "var(--ok)";
    if (score >= 60) return "var(--warn)";
    return "var(--danger)";
  }

  private _viewDetail(inst: DatabaseInstance) {
    // Update URL with instance ID
    const url = new URL(window.location.href);
    url.searchParams.set("id", String(inst.id));
    url.searchParams.set("tab", "instance-detail");
    window.history.pushState({}, "", url);

    // Dispatch navigation event
    window.dispatchEvent(new CustomEvent("slide-navigate", {
      detail: { tab: "instance-detail", id: inst.id }
    }));
  }

  private _addInstance() {
    this.hostRelationRequestVersion += 1;
    this.formData = {
      name: "",
      environment: "development",
      db_type: "mysql",
      host: "",
      port: 3306,
      username: "",
      password: "",
      database_name: "",
      description: "",
    };
    this.testStatus = "idle";
    this.testMessage = "";
    this.instanceHosts = [];
    this.hostRelationLoading = false;
    this.hostRelationError = null;
    this.pendingCreatedInstanceId = null;
    this.showAddDialog = true;
  }

  private _editInstance(inst: DatabaseInstance) {
    this.hostRelationRequestVersion += 1;
    this.editingInstance = inst;
    this.formData = {
      name: inst.name,
      environment: inst.environment || "development",
      db_type: inst.db_type,
      host: inst.host,
      port: inst.port,
      username: inst.username || "",
      password: "",
      database_name: inst.database_name || "",
      description: inst.description || "",
    };
    this.testStatus = "idle";
    this.testMessage = "";
    this.instanceHosts = this.canViewHostRelations ? null : [];
    this.hostRelationLoading = this.canViewHostRelations;
    this.hostRelationError = null;
    this.pendingCreatedInstanceId = null;
    this.showEditDialog = true;
    if (this.canViewHostRelations) void this._loadInstanceHosts(inst.id);
  }

  private async _loadInstanceHosts(instanceId: number) {
    if (!this.canViewHostRelations) return;
    const version = ++this.hostRelationRequestVersion;
    this.instanceHosts = null;
    this.hostRelationLoading = true;
    this.hostRelationError = null;
    try {
      const response = await authFetch(`/api/database/instances/${instanceId}/hosts`);
      if (!response.ok) {
        throw new Error(response.status === 401 || response.status === 403
          ? "没有权限加载主机关联关系"
          : "主机关联关系加载失败");
      }
      const data = await response.json() as InstanceHostsResponse;
      if (version !== this.hostRelationRequestVersion) return;
      this.instanceHosts = data.hosts.map((host) => host.notes == null
        ? { serverId: host.serverId, role: host.role }
        : { serverId: host.serverId, role: host.role, notes: host.notes });
    } catch (error) {
      if (version !== this.hostRelationRequestVersion) return;
      this.instanceHosts = null;
      this.hostRelationError = error instanceof Error ? error.message : "主机关联关系加载失败";
    } finally {
      if (version === this.hostRelationRequestVersion) this.hostRelationLoading = false;
    }
  }

  private _handleInstanceHostChange(event: CustomEvent<{ hosts: InstanceHostMapping[] }>) {
    if (!this.canManageHostRelations) return;
    this.instanceHosts = event.detail.hosts;
    this.hostRelationError = null;
  }

  private _reloadInstanceHosts() {
    if (this.canViewHostRelations && this.editingInstance) void this._loadInstanceHosts(this.editingInstance.id);
  }

  private async _testConnection(inst: DatabaseInstance) {
    this.testingInstance = inst;
    this.testPassword = "";
    this.showTestDialog = true;

    // 如果实例已连接（healthy），直接显示状态，不要求输密码
    if (inst.hasCredential === true && inst.health_status === "healthy") {
      this.listTestStatus = "success";
      this.listTestMessage = "连接正常";
      return;
    }

    // A stale health value must not bypass credential entry for an instance
    // whose credential is missing or was rejected by the backend.
    if (inst.hasCredential !== true) {
      this.listTestStatus = "idle";
      this.listTestMessage = "";
      return;
    }

    // 实例未连接 — 尝试用已有连接快速检测
    try {
      const mRes = await authFetch(`/api/database/instances/${inst.id}/metrics`);
      if (mRes.ok) {
        this.listTestStatus = "success";
        this.listTestMessage = "连接正常，指标采集正常";
        return;
      }
    } catch (_) {}

    // 确实未连接，需要密码
    this.listTestStatus = "idle";
    this.listTestMessage = "";
  }

  private async _handleListTestConnection() {
    if (!this.testingInstance) return;

    const validationError = validateTestConnectionForm({
      host: this.testingInstance.host,
      username: this.testingInstance.username ?? "",
      password: this.testPassword,
    });
    if (validationError) {
      this.listTestStatus = "error";
      this.listTestMessage = validationError;
      showToast(validationError, "warning");
      return;
    }

    this.listTestStatus = "testing";
    this.listTestMessage = "";

    try {
      const res = await authFetch("/api/database/instances/test-connection", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          host: this.testingInstance.host,
          port: this.testingInstance.port,
          username: this.testingInstance.username,
          password: this.testPassword,
          database_name: this.testingInstance.database_name,
          db_type: this.testingInstance.db_type,
        }),
      });
      const result = await res.json();
      this.listTestStatus = result.success ? "success" : "error";
      this.listTestMessage = normalizeConnectionTestMessage(result.message || result.error);

      // 测试成功后自动保存密码并重载连接
      if (result.success) {
        await this._savePasswordAndReload();
      }
    } catch (err: any) {
      this.listTestStatus = "error";
      this.listTestMessage = normalizeConnectionTestMessage(err?.message);
    }
  }

  private async _savePasswordAndReload() {
    if (!this.testingInstance) return;
    try {
      const saved = await authFetch(`/api/database/instances/${this.testingInstance.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: this.testPassword }),
      });
      if (!saved.ok) throw new Error("保存凭据失败");
      const reloaded = await authFetch(`/api/database/instances/${this.testingInstance.id}/reload`, {
        method: "POST",
      });
      if (!reloaded.ok) throw new Error("重载连接失败");
      await this.loadInstances();
    } catch (err: any) {
      this.listTestStatus = "error";
      this.listTestMessage = err.message;
    }
  }

  private _deleteInstance(inst: DatabaseInstance) {
    this.deletingInstance = inst;
    this.showDeleteDialog = true;
  }

  private _resetDialogs() {
    this.hostRelationRequestVersion += 1;
    this.showAddDialog = false;
    this.showEditDialog = false;
    this.showDeleteDialog = false;
    this.showTestDialog = false;
    this.editingInstance = null;
    this.deletingInstance = null;
    this.testingInstance = null;
    this.testStatus = "idle";
    this.testMessage = "";
    this.instanceHosts = [];
    this.hostRelationLoading = false;
    this.hostRelationError = null;
    this.pendingCreatedInstanceId = null;
  }

  private _closeDialogs() {
    if (this.isSubmitting) return;
    const abandonedCreatedInstance = this.pendingCreatedInstanceId !== null;
    this._resetDialogs();
    if (abandonedCreatedInstance) {
      showToast("实例已创建但主机关联未保存", "warning");
      void this.loadInstances();
    }
  }

  private async _handleSubmit(isEdit: boolean) {
    if (this.isSubmitting) return;

    const canManageHostRelations = this.canManageHostRelations;
    if (canManageHostRelations && (this.hostRelationLoading || this.instanceHosts === null)) {
      showToast("请先成功加载主机关联关系", "warning");
      return;
    }

    const formData = { ...this.formData };
    const instanceHosts = (this.instanceHosts ?? []).map((host) => ({ ...host }));
    const editingInstanceId = this.editingInstance?.id ?? null;
    const pendingCreatedInstanceId = this.pendingCreatedInstanceId;

    // Validate
    if (!formData.name || !formData.host || !formData.username) {
      showToast("Please fill in: name, host, username", "warning");
      return;
    }

    this.isSubmitting = true;

    try {
      let instanceId: number;
      if (isEdit) {
        if (editingInstanceId === null) throw new Error("编辑实例不存在");
        instanceId = editingInstanceId;
        const response = await authFetch(`/api/database/instances/${instanceId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || "实例保存失败");
        }
      } else if (pendingCreatedInstanceId !== null) {
        instanceId = pendingCreatedInstanceId;
      } else {
        const response = await authFetch("/api/database/instances", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || "实例创建失败");
        }
        const created = await response.json() as { id: number };
        if (!Number.isInteger(created.id) || created.id <= 0) throw new Error("实例创建响应缺少有效 ID");
        instanceId = created.id;
        if (canManageHostRelations) this.pendingCreatedInstanceId = created.id;
      }

      if (canManageHostRelations) {
        const relationRequest: ReplaceInstanceHostsRequest = { hosts: instanceHosts };
        const relationResponse = await authFetch(`/api/database/instances/${instanceId}/hosts`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(relationRequest),
        });
        if (!relationResponse.ok) {
          const error = await relationResponse.json().catch(() => ({}));
          throw new Error(error.error || "主机关联关系保存失败");
        }
        await relationResponse.json() as ReplaceInstanceHostsResponse;
      }

      this.pendingCreatedInstanceId = null;
      this._resetDialogs();
      await this.loadInstances();
      showToast("Instance updated successfully", "success");
    } catch (err: any) {
      showToast(`Update failed: ${err.message}`, "error");
    } finally {
      this.isSubmitting = false;
    }
  }

  private async _handleDelete() {
    if (!this.deletingInstance) return;

    try {
      const res = await authFetch(
        `/api/database/instances/${this.deletingInstance.id}`,
        {
          method: "DELETE",
        }
      );

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "删除失败");
      }

      this._closeDialogs();
      await this.loadInstances();
      showToast("Instance deleted successfully", "success");
    } catch (err: any) {
      showToast(`Update failed: ${err.message}`, "error");
    }
  }

  private async _handleTestConnection() {
    const validationError = validateTestConnectionForm(this.formData);
    if (validationError) {
      this.testStatus = "error";
      this.testMessage = validationError;
      showToast(validationError, "warning");
      return;
    }

    this.testStatus = "testing";
    this.testMessage = "";

    try {
            const res = await authFetch("/api/database/instances/test-connection", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildTestConnectionPayload(this.formData)),
      });
      const result = await res.json();

      this.testStatus = result.success ? "success" : "error";
      this.testMessage = normalizeConnectionTestMessage(result.message || result.error);
    } catch (err: any) {
      this.testStatus = "error";
      this.testMessage = normalizeConnectionTestMessage(err?.message);
    }
  }

  private _updateForm(field: keyof InstanceFormData, value: string | number) {
    this.formData = { ...this.formData, [field]: value };
  }

  private _renderAddDialog() {
    if (!this.showAddDialog) return html``;
    return this._renderFormDialog("添加数据库实例", false);
  }

  private _renderEditDialog() {
    if (!this.showEditDialog) return html``;
    return this._renderFormDialog("编辑数据库实例", true);
  }

  private _renderFormDialog(title: string, isEdit: boolean) {
    const baseFieldsLocked = this.pendingCreatedInstanceId !== null;
    const canViewHostRelations = this.canViewHostRelations;
    const canManageHostRelations = this.canManageHostRelations;
    const relationUnavailable = canManageHostRelations
      && (this.hostRelationLoading || this.instanceHosts === null);
    return html`
      <app-dialog
        .open=${true}
        size="md"
        .closable=${!this.isSubmitting}
        .closeOnOverlay=${false}
        title="${title}"
        @app-dialog-close=${this._closeDialogs}
      >
        <div class="form-row">
          <app-form-field label="实例名称" required>
            <input class="form-input" type="text" .value=${this.formData.name} .disabled=${baseFieldsLocked} @input=${(e: any) => this._updateForm("name", e.target.value)} placeholder="如：生产主库" />
          </app-form-field>
          <app-form-field label="环境">
            <select class="form-select" .value=${this.formData.environment} .disabled=${baseFieldsLocked} @change=${(e: any) => this._updateForm("environment", e.target.value)}>
              <option value="development">开发环境</option>
              <option value="testing">测试环境</option>
              <option value="staging">预发布环境</option>
              <option value="production">生产环境</option>
            </select>
          </app-form-field>
        </div>

        <div class="form-row">
          <app-form-field label="数据库类型">
            <select class="form-select" .value=${this.formData.db_type} .disabled=${baseFieldsLocked} @change=${(e: any) => {
              this._updateForm("db_type", e.target.value);
              const ports: Record<string, number> = { mysql: 3306, postgresql: 5432, oracle: 1521, dameng: 5236 };
              this._updateForm("port", ports[e.target.value] || 3306);
            }}>
              <option value="mysql">MySQL</option>
              <option value="postgresql">PostgreSQL</option>
              <option value="oracle">Oracle</option>
              <option value="dameng">达梦</option>
            </select>
          </app-form-field>
          <app-form-field label="端口">
            <input class="form-input" type="number" .value=${this.formData.port} .disabled=${baseFieldsLocked} @input=${(e: any) => this._updateForm("port", parseInt(e.target.value) || 0)} />
          </app-form-field>
        </div>

        <div class="form-row">
          <app-form-field label="主机地址" required style="grid-column: 1 / -1;">
            <input class="form-input" type="text" .value=${this.formData.host} .disabled=${baseFieldsLocked} @input=${(e: any) => this._updateForm("host", e.target.value)} placeholder="如：localhost 或 192.168.1.100" />
          </app-form-field>
        </div>

        <div class="form-row">
          <app-form-field label="用户名" required>
            <input class="form-input" type="text" autocomplete="off" .value=${this.formData.username} .disabled=${baseFieldsLocked} @input=${(e: any) => this._updateForm("username", e.target.value)} />
          </app-form-field>
          <app-form-field label="密码${isEdit ? ' (留空不修改)' : ''}" .required=${!isEdit}>
            <input class="form-input" type="password" autocomplete="new-password" .value=${this.formData.password} .disabled=${baseFieldsLocked} @input=${(e: any) => this._updateForm("password", e.target.value)} placeholder=${isEdit ? "留空表示不修改" : ""} />
          </app-form-field>
        </div>

        <div class="form-row">
          <app-form-field label="${this.formData.db_type === 'oracle' ? 'Oracle 数据库标识 (SID/Service Name)' : '数据库名'}" hint="${this.formData.db_type === 'oracle' ? '用于 Easy Connect 格式的数据库标识，支持 SID 或 Service Name' : '连接后默认使用的数据库'}" style="grid-column: 1 / -1;">
            <input class="form-input" type="text" .value=${this.formData.database_name} .disabled=${baseFieldsLocked} @input=${(e: any) => this._updateForm("database_name", e.target.value)} placeholder=${this.formData.db_type === 'oracle' ? '如：ORCL 或 pdb1.subnet.vcn.oraclevcn.com' : '默认数据库名'} />
          </app-form-field>
        </div>

        <div class="form-row">
          <app-form-field label="描述" style="grid-column: 1 / -1;">
            <textarea class="form-textarea" .value=${this.formData.description} .disabled=${baseFieldsLocked} @input=${(e: any) => this._updateForm("description", e.target.value)} placeholder="可选：添加实例描述信息"></textarea>
          </app-form-field>
        </div>

        ${canViewHostRelations ? html`<div class="form-row">
          <instance-host-field
            style="grid-column: 1 / -1;"
            .value=${this.instanceHosts}
            .loading=${this.hostRelationLoading}
            .error=${this.hostRelationError}
            .disabled=${this.isSubmitting || !canManageHostRelations}
            @instance-host-change=${this._handleInstanceHostChange}
            @instance-host-reload=${this._reloadInstanceHosts}
          ></instance-host-field>
        </div>` : nothing}

        ${this.testMessage ? html`<div class="test-result ${this.testStatus}">${this.testStatus === 'success' ? icons['check-circle'] : icons['x-circle']} ${this.testMessage}</div>` : ''}
        <div slot="footer" style="display:flex;justify-content:flex-end;align-items:center;gap:var(--space-md)">
          <button class="btn" @click=${this._handleTestConnection} .disabled=${this.testStatus === 'testing' || this.isSubmitting || baseFieldsLocked}>
            ${this.testStatus === 'testing' ? '测试中...' : '测试连接'}
          </button>
          <button class="btn" @click=${this._closeDialogs} .disabled=${this.isSubmitting}>取消</button>
          <button
            class="btn-primary"
            @click=${() => this._handleSubmit(isEdit)}
            .disabled=${this.isSubmitting || relationUnavailable}
          >${this.isSubmitting ? '保存中...' : baseFieldsLocked ? '重试关联' : isEdit ? '保存修改' : '添加实例'}</button>
        </div>
      </app-dialog>
    `;
  }

  private _renderDeleteDialog() {
    if (!this.showDeleteDialog || !this.deletingInstance) return html``;

    return html`
      <app-dialog .open=${true} size="sm" title="确认删除实例？" @app-dialog-close=${this._closeDialogs}>
        <div style="text-align:center;padding:var(--space-md) 0">
          <div class="confirm-icon">${icons['triangle-alert']}</div>
          <div class="confirm-text" style="font-size:var(--text-md);color:var(--muted);margin-top:var(--space-md)">
            您即将删除实例 "${this.deletingInstance.name}"，此操作不可恢复。
          </div>
        </div>
        <div slot="footer" style="justify-content:center;display:flex;gap:var(--space-md)">
          <button class="btn" @click=${this._closeDialogs}>取消</button>
          <button class="btn danger" @click=${this._handleDelete} style="background:var(--danger);color:white;border-color:var(--danger);">确认删除</button>
        </div>
      </app-dialog>
    `;
  }

  private _renderTestDialog() {
    if (!this.showTestDialog || !this.testingInstance) return html``;

    const isConnected = this.listTestStatus === "success" && this.listTestMessage !== "";
    const isTesting = this.listTestStatus === "testing";
    const hasError = this.listTestStatus === "error";

    const statusColor = {
      idle: "var(--muted)",
      testing: "var(--info)",
      success: "var(--ok)",
      error: "var(--danger)",
    };

    const statusIcon = isTesting ? icons['loader']
      : hasError ? icons['x-circle']
      : this.listTestStatus === "success" ? icons['check-circle']
      : null;

    return html`
      <app-dialog .open=${true} size="sm" title="测试连接 - ${this.testingInstance.name}" @app-dialog-close=${this._closeDialogs}>
        <app-form-field label="主机地址">
          <div class="form-value">${this.testingInstance.host || '-'}</div>
        </app-form-field>
        <app-form-field label="端口">
          <div class="form-value">${this.testingInstance.port || '-'}</div>
        </app-form-field>
        <app-form-field label="用户名">
          <div class="form-value">${this.testingInstance.username || '-'}</div>
        </app-form-field>
        ${isConnected
          ? html`<div style="display:flex;align-items:center;gap:8px;padding:12px;background:var(--ok-subtle);border-radius:var(--radius-sm);margin-top:16px;color:var(--ok);font-size:var(--text-sm);font-weight:500;">
              ${icons['check-circle']} 实例已连接，无需重新输入密码
            </div>`
          : html`
            <app-form-field label="密码" required>
              <input class="form-input" type="password" autocomplete="new-password" .value=${this.testPassword} @input=${(e: any) => (this.testPassword = e.target.value)} placeholder="请输入数据库密码" />
            </app-form-field>
          `
        }
        ${!isConnected
          ? html`<div style="padding:12px;background:var(--bg-elevated);border-radius:var(--radius-sm);margin-top:${isConnected ? 0 : 16}px;">
              <div style="display:flex;align-items:center;justify-content:center;gap:6px;font-size:var(--text-sm);color:${statusColor[this.listTestStatus]};">
                ${statusIcon ? html`<span style="display:flex;width:14px;height:14px;">${statusIcon}</span>` : ''}
                ${isTesting ? '正在测试连接...'
                : hasError ? this.listTestMessage
                : this.listTestStatus === "success" ? this.listTestMessage
                : '输入密码后点击测试'}
              </div>
            </div>`
          : ''}
        <div slot="footer" style="display:flex;justify-content:${isConnected ? 'center' : 'space-between'};align-items:center">
          <button class="btn" @click=${this._closeDialogs}>关闭</button>
          ${isConnected ? nothing : html`<button class="btn-primary" @click=${this._handleListTestConnection} .disabled=${isTesting}>
            ${isTesting ? html`${icons['loader']} 测试中...` : html`${icons['link']} 测试连接`}
          </button>`}
        </div>
      </app-dialog>
    `;
  }
}

if (!customElements.get("instances-page")) {
  customElements.define("instances-page", InstancesPage);
}
