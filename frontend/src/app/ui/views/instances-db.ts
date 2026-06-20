import { LitElement, html, css, nothing } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state } from "lit/decorators.js";
import "../components/app-dialog.js";
import "../components/app-form-field.js";
import { icons } from "../../../icons.js";
import { authFetch } from "../../../api/index.js";
import { showToast } from "../components/app-toast-container.js";

interface DatabaseInstance {
  id: number;
  name: string;
  db_type: string;
  db_version?: string;
  data_size_gb?: number;
  host: string;
  port: number;
  database_name: string;
  username?: string;
  health_status: "healthy" | "warning" | "critical" | "unknown";
  health_score: number;
  status: string;
  created_at: string;
  environment?: string;
  description?: string;
}

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

@customElement("instances-page")
export class InstancesPage extends LitElement {
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
      padding: 0 0 24px 0;
    }

    /* 主卡片 */
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
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

    /* 工具栏 */
    .toolbar {
      display: flex;
      align-items: center;
      gap: var(--space-md);
      padding: var(--space-md) var(--space-lg);
      border-bottom: 1px solid var(--border);
      background: var(--bg-elevated);
      flex-wrap: wrap;
    }

    .filter-group {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
    }

    .filter-btn {
      display: inline-flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      font-weight: 500;
      color: var(--text);
      background: var(--secondary);
      cursor: pointer;
      transition: all var(--duration-normal) var(--ease-out);
    }

    .filter-btn:hover {
      border-color: var(--border-strong);
      background: var(--bg-hover);
    }

    .filter-btn.active {
      background: var(--accent);
      color: var(--accent-foreground);
      border-color: var(--accent);
    }

    .search-box {
      position: relative;
      flex: 1;
      min-width: 200px;
      max-width: 300px;
    }

    .search-input {
      width: 100%;
      padding: var(--space-sm) var(--space-md) var(--space-sm) 34px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-base);
      color: var(--text);
      background: var(--card);
      transition: all var(--duration-normal) var(--ease-out);
    }

    .search-input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-subtle);
    }

    .search-icon {
      position: absolute;
      left: 10px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--muted);
      font-size: var(--text-base);
    }

    /* 表格样式 */
    .table-container {
      overflow-x: auto;
    }

    .table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: var(--text-base);
    }

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
      margin-bottom: var(--space-md);
      opacity: 0.6;
      color: var(--warn);
    }
    .confirm-icon svg {
      width: 16px;
      height: 16px;
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
    db_type: "mysql",
    host: "",
    port: 3306,
    username: "",
    password: "",
    database_name: "",
    description: "",
  };
  @state() private testStatus: "idle" | "testing" | "success" | "error" = "idle";
  @state() private testMessage = "";
  @state() private isSubmitting = false;

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

  override render() {
    if (this.loading) {
      return html`<div class="loading">加载中...</div>`;
    }

    if (this.error) {
      return html`<div class="loading" style="color: var(--danger);">${this.error}</div>`;
    }

    if (this.instances.length === 0) {
      return html`
        <div class="page">
          <div class="empty">
            <div class="empty__content">
              <div class="empty__icon">${icons['database']}</div>
              <div class="empty__title">暂无数据库实例</div>
              <div class="empty__desc">点击添加按钮创建第一个实例</div>
            </div>
          </div>
        </div>
      `;
    }

    const filtered = this.filteredInstances;

    return html`
      <div class="page">
        <!-- 实例列表卡片 -->
        <div class="card">
          <div class="toolbar" style="display: flex; align-items: center; gap: var(--space-md); padding: var(--space-md) var(--space-lg); border-bottom: 1px solid var(--border); flex-wrap: wrap;">
            <div class="filter-group" style="display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap;">
              <button class="filter-btn ${this.filter === "all" ? "active" : ""}" @click=${() => (this.filter = "all")} style="padding: var(--space-sm) var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: var(--text-sm); font-weight: 500; cursor: pointer; background: ${this.filter === "all" ? 'var(--accent)' : 'var(--secondary)'}; color: ${this.filter === "all" ? 'var(--accent-foreground)' : 'var(--text)'}; border-color: ${this.filter === "all" ? 'var(--accent)' : 'var(--border)'};">
                全部 (${this.instances.length})
              </button>
              <button class="filter-btn ${this.filter === "healthy" ? "active" : ""}" @click=${() => (this.filter = "healthy")} style="padding: var(--space-sm) var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: var(--text-sm); font-weight: 500; cursor: pointer; background: ${this.filter === "healthy" ? 'var(--accent)' : 'var(--secondary)'}; color: ${this.filter === "healthy" ? 'var(--accent-foreground)' : 'var(--text)'}; border-color: ${this.filter === "healthy" ? 'var(--accent)' : 'var(--border)'};">
                <span style="width: 6px; height: 6px; border-radius: 50%; display: inline-block; background: var(--ok); margin-right: 4px;"></span> 健康 (${this.stats.healthy})
              </button>
              <button class="filter-btn ${this.filter === "warning" ? "active" : ""}" @click=${() => (this.filter = "warning")} style="padding: var(--space-sm) var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: var(--text-sm); font-weight: 500; cursor: pointer; background: ${this.filter === "warning" ? 'var(--accent)' : 'var(--secondary)'}; color: ${this.filter === "warning" ? 'var(--accent-foreground)' : 'var(--text)'}; border-color: ${this.filter === "warning" ? 'var(--accent)' : 'var(--border)'};">
                <span style="width: 6px; height: 6px; border-radius: 50%; display: inline-block; background: var(--warn); margin-right: 4px;"></span> 警告 (${this.stats.warning})
              </button>
              <button class="filter-btn ${this.filter === "critical" ? "active" : ""}" @click=${() => (this.filter = "critical")} style="padding: var(--space-sm) var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: var(--text-sm); font-weight: 500; cursor: pointer; background: ${this.filter === "critical" ? 'var(--accent)' : 'var(--secondary)'}; color: ${this.filter === "critical" ? 'var(--accent-foreground)' : 'var(--text)'}; border-color: ${this.filter === "critical" ? 'var(--accent)' : 'var(--border)'};">
                <span style="width: 6px; height: 6px; border-radius: 50%; display: inline-block; background: var(--danger); margin-right: 4px;"></span> 异常 (${this.stats.critical})
              </button>
            </div>

            <div class="search-box" style="position: relative; flex: 1; min-width: 200px; max-width: 300px;">
              <span style="position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); display: flex;"><span style="width: 14px; height: 14px; display: flex; opacity: 0.6;">${icons['search']}</span></span>
              <input
                style="width: 100%; padding: var(--space-sm) var(--space-md) var(--space-sm) 34px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: var(--text-base); color: var(--text); background: var(--card);"
                placeholder="搜索名称、主机、类型..."
                name="search-instances"
                autocomplete="off"
                .value=${this.searchQuery}
                @input=${(e: any) => (this.searchQuery = e.target.value)}
              />
            </div>

            <button class="btn primary" style="margin-left:auto;" @click=${() => this._addInstance()}>
              + 添加实例
            </button>
          </div>

          ${filtered.length > 0
            ? html`
                <div class="table-container">
                  <table class="table">
                    <thead>
                      <tr>
                        <th class="sortable" @click=${() => this._toggleSort('name')}>实例 ${this._sortArrow('name')}</th>
                        <th class="sortable" style="width: 60px; text-align:center;" @click=${() => this._toggleSort('db_type')}>类型 ${this._sortArrow('db_type')}</th>
                        <th class="sortable" style="width: 72px; text-align:center;" @click=${() => this._toggleSort('db_version')}>版本 ${this._sortArrow('db_version')}</th>
                        <th class="sortable" style="width: 72px; text-align:center;" @click=${() => this._toggleSort('data_size_gb')}>容量 ${this._sortArrow('data_size_gb')}</th>
                        <th class="sortable" style="width: 170px; text-align:center;" @click=${() => this._toggleSort('addr')}>连接地址 ${this._sortArrow('addr')}</th>
                        <th class="sortable" style="width: 72px; text-align:center;" @click=${() => this._toggleSort('health_status')}>状态 ${this._sortArrow('health_status')}</th>
                        <th class="sortable" style="width: 56px; text-align:center;" @click=${() => this._toggleSort('health_score')}>健康分 ${this._sortArrow('health_score')}</th>
                        <th style="width: 180px; text-align:center;">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${filtered.map((inst) => html`
                        <tr class="instance-row" @click=${(e: MouseEvent) => { if (!(e.target as HTMLElement).closest('button')) this._viewDetail(inst); }} style="cursor:pointer;">
                          <td>
                            <div class="instance-name">${inst.name}</div>
                          </td>
                          <td style="text-align:center;">
                            <span class="type-tag">${inst.db_type.toUpperCase()}</span>
                          </td>
                          <td style="text-align:center;">
                            <span style="font-size: var(--text-sm); color: var(--muted);">${inst.db_version || '—'}</span>
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
                            <span style="font-weight: 700; font-size: var(--text-md); color: ${this._getHealthColor(inst.health_score)};">${inst.health_score}</span>
                          </td>
                          <td style="text-align:center;">
                            <div class="actions">
                              <button class="action-btn" @click=${() => this._viewDetail(inst)}>详情</button>
                              <button class="action-btn" @click=${() => this._editInstance(inst)}>编辑</button>
                              <button class="action-btn" @click=${() => this._testConnection(inst)}>测试</button>
                              <button class="action-btn danger" @click=${() => this._deleteInstance(inst)}>删除</button>
                            </div>
                          </td>
                        </tr>
                      `)}
                    </tbody>
                  </table>
                </div>
              `
            : html`
                <div class="empty" style="min-height: 200px;">
                  <div class="empty__content">
                    <div class="empty__icon">${icons['search']}</div>
                    <div class="empty__title">没有符合条件的实例</div>
                    <div class="empty__desc">尝试调整筛选条件</div>
                  </div>
                </div>
              `
          }
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
    this.showAddDialog = true;
  }

  private _editInstance(inst: DatabaseInstance) {
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
    this.showEditDialog = true;
  }

  private async _testConnection(inst: DatabaseInstance) {
    this.testingInstance = inst;
    this.testPassword = "";
    this.showTestDialog = true;

    // 如果实例已连接（healthy），直接显示状态，不要求输密码
    if (inst.health_status === "healthy") {
      this.listTestStatus = "success";
      this.listTestMessage = "连接正常";
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

    if (!this.testPassword) {
      showToast("Please enter password", "warning");
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
      this.listTestMessage = result.message || result.error || "未知错误";

      // 测试成功后自动保存密码并重载连接
      if (result.success) {
        await this._savePasswordAndReload();
      }
    } catch (err: any) {
      this.listTestStatus = "error";
      this.listTestMessage = err.message;
    }
  }

  private async _savePasswordAndReload() {
    if (!this.testingInstance) return;
    try {
      await authFetch(`/api/database/instances/${this.testingInstance.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: this.testPassword }),
      });
      await authFetch(`/api/database/instances/${this.testingInstance.id}/reload`, {
        method: "POST",
      });
    } catch (_err) {
      // 忽略保存失败，不阻塞测试结果展示
    }
  }

  private _deleteInstance(inst: DatabaseInstance) {
    this.deletingInstance = inst;
    this.showDeleteDialog = true;
  }

  private _closeDialogs() {
    this.showAddDialog = false;
    this.showEditDialog = false;
    this.showDeleteDialog = false;
    this.showTestDialog = false;
    this.editingInstance = null;
    this.deletingInstance = null;
    this.testingInstance = null;
    this.testStatus = "idle";
    this.testMessage = "";
  }

  private async _handleSubmit(isEdit: boolean) {
    if (this.isSubmitting) return;

    // Validate
    if (!this.formData.name || !this.formData.host || !this.formData.username) {
      showToast("Please fill in: name, host, username", "warning");
      return;
    }

    this.isSubmitting = true;

    try {
      const url = isEdit
        ? `/api/database/instances/${this.editingInstance!.id}`
        : "/api/database/instances";

      const res = await authFetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(this.formData),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "保存失败");
      }

      this._closeDialogs();
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
    if (!this.formData.host || !this.formData.username) {
      showToast("Please fill in host and username", "warning");
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
        body: JSON.stringify(this.formData),
      });
      const result = await res.json();

      this.testStatus = result.success ? "success" : "error";
      this.testMessage = result.message || result.error || "未知错误";
    } catch (err: any) {
      this.testStatus = "error";
      this.testMessage = err.message;
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
    return html`
      <app-dialog .open=${true} size="md" title="${title}" @app-dialog-close=${this._closeDialogs}>
        <div class="form-row">
          <app-form-field label="实例名称" required>
            <input class="form-input" type="text" .value=${this.formData.name} @input=${(e: any) => this._updateForm("name", e.target.value)} placeholder="如：生产主库" />
          </app-form-field>
          <app-form-field label="环境">
            <select class="form-select" .value=${this.formData.environment} @change=${(e: any) => this._updateForm("environment", e.target.value)}>
              <option value="development">开发环境</option>
              <option value="testing">测试环境</option>
              <option value="staging">预发布环境</option>
              <option value="production">生产环境</option>
            </select>
          </app-form-field>
        </div>

        <div class="form-row">
          <app-form-field label="数据库类型">
            <select class="form-select" .value=${this.formData.db_type} @change=${(e: any) => {
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
            <input class="form-input" type="number" .value=${this.formData.port} @input=${(e: any) => this._updateForm("port", parseInt(e.target.value) || 0)} />
          </app-form-field>
        </div>

        <div class="form-row">
          <app-form-field label="主机地址" required style="grid-column: 1 / -1;">
            <input class="form-input" type="text" .value=${this.formData.host} @input=${(e: any) => this._updateForm("host", e.target.value)} placeholder="如：localhost 或 192.168.1.100" />
          </app-form-field>
        </div>

        <div class="form-row">
          <app-form-field label="用户名" required>
            <input class="form-input" type="text" autocomplete="off" .value=${this.formData.username} @input=${(e: any) => this._updateForm("username", e.target.value)} />
          </app-form-field>
          <app-form-field label="密码${isEdit ? ' (留空不修改)' : ''}">
            <input class="form-input" type="password" .value=${this.formData.password} @input=${(e: any) => this._updateForm("password", e.target.value)} placeholder=${isEdit ? "留空表示不修改" : ""} />
          </app-form-field>
        </div>

        <div class="form-row">
          <app-form-field label="${this.formData.db_type === 'oracle' ? 'Oracle 数据库标识 (SID/Service Name)' : '数据库名'}" hint="${this.formData.db_type === 'oracle' ? '用于 Easy Connect 格式的数据库标识，支持 SID 或 Service Name' : '连接后默认使用的数据库'}" style="grid-column: 1 / -1;">
            <input class="form-input" type="text" .value=${this.formData.database_name} @input=${(e: any) => this._updateForm("database_name", e.target.value)} placeholder=${this.formData.db_type === 'oracle' ? '如：ORCL 或 pdb1.subnet.vcn.oraclevcn.com' : '默认数据库名'} />
          </app-form-field>
        </div>

        <div class="form-row">
          <app-form-field label="描述" style="grid-column: 1 / -1;">
            <textarea class="form-textarea" .value=${this.formData.description} @input=${(e: any) => this._updateForm("description", e.target.value)} placeholder="可选：添加实例描述信息"></textarea>
          </app-form-field>
        </div>

        ${this.testMessage ? html`<div class="test-result ${this.testStatus}">${this.testStatus === 'success' ? icons['check-circle'] : icons['x-circle']} ${this.testMessage}</div>` : ''}
        <div slot="footer" style="display:flex;justify-content:space-between;align-items:center">
          <button class="btn" @click=${this._handleTestConnection} ?disabled=${this.testStatus === 'testing'}>
            ${this.testStatus === 'testing' ? html`${icons['loader']} 测试中...` : html`${icons['link']} 测试连接`}
          </button>
          <div style="display:flex;gap:var(--space-md)">
            <button class="btn" @click=${this._closeDialogs}>取消</button>
            <button class="btn primary" @click=${() => this._handleSubmit(isEdit)} ?disabled=${this.isSubmitting}>${this.isSubmitting ? '保存中...' : isEdit ? '保存修改' : '创建实例'}</button>
          </div>
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
          <button class="btn danger" @click=${this._handleDelete} style="background:var(--danger);color:var(--danger-foreground);border-color:var(--danger);">确认删除</button>
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
          ${isConnected ? nothing : html`<button class="btn primary" @click=${this._handleListTestConnection} ?disabled=${isTesting}>
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
