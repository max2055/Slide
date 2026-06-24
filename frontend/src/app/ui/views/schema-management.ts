import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state, property } from "lit/decorators.js";
import "../components/app-card.js";
import "../components/app-empty-state.js";
import "../components/app-badge.js";
import { icons } from "../../../icons.js";
import "../../../components/stat-card.js";

interface DatabaseInstance {
  id: number;
  name: string;
  db_type: string;
  host: string;
  port: number;
  database_name: string;
  status: string;
  health_status: string;
}

interface SnapshotTime {
  snapshot_time: string;
  tables: number;
  columns: number;
}

interface TableSchemaRow {
  table_name: string;
  column_name: string;
  column_type: string;
  is_nullable: string;
  column_default: string | null;
  column_key: string;
  extra: string;
  column_comment: string | null;
  table_comment: string | null;
  table_rows: number;
  data_length: number;
}

interface TableListEntry {
  table_name: string;
  table_comment: string | null;
  table_rows: number;
  data_length: number;
  column_count: number;
}

interface SchemaChange {
  type: "added" | "modified" | "deleted";
  target: "table" | "column";
  table_name: string;
  column_name?: string;
  details?: Record<string, { old: any; new: any }>;
  detected_at: string;
}

@customElement("schema-management-page")
export class SchemaManagementPage extends LitElement {
  static styles = [sharedBtnStyles, css`
    :host {
      display: block;
      animation: fade-in 0.25s var(--ease-out);
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .page { padding: 0; }


    .toolbar {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-md) var(--space-lg);
      border-bottom: 1px solid var(--border);
      background: var(--bg-elevated);
      flex-wrap: wrap;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      font-weight: 500;
      cursor: pointer;
      transition: all var(--duration-normal) var(--ease-out);
      border: 1px solid var(--border);
      background: var(--secondary);
      color: var(--text);
    }

    .btn:hover {
      background: var(--bg-hover);
      border-color: var(--border-strong);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .select {
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      border: 1px solid var(--border);
      background: var(--secondary);
      color: var(--text);
      min-width: 200px;
    }

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
      text-align: left;
      font-weight: 600;
      font-size: var(--text-xs);
      color: var(--muted);
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .table td {
      padding: var(--space-md);
      border-bottom: 1px solid var(--border);
      color: var(--text);
      vertical-align: top;
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

    .change-detail {
      font-size: var(--text-xs);
      color: var(--muted);
      margin-top: var(--space-xs);
    }

    .change-detail .old {
      text-decoration: line-through;
      color: var(--danger);
    }

    .change-detail .new {
      color: var(--ok);
    }

    .time-ago {
      font-size: var(--text-sm);
      color: var(--muted);
    }

    .loading, .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 200px;
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
      margin-bottom: var(--space-sm);
    }

    .empty__desc {
      font-size: var(--text-base);
      color: var(--muted);
    }

    .snapshot-time-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--space-md) var(--space-lg);
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background var(--duration-fast) ease;
    }

    .snapshot-time-item:hover {
      background: var(--bg-hover);
    }

    .snapshot-time-item:last-child {
      border-bottom: none;
    }

    .table-row {
      cursor: pointer;
    }

    .expanded-content {
      background: var(--bg-elevated);
    }

    .expanded-content .table td {
      padding: var(--space-sm) var(--space-md) var(--space-sm) 28px;
      font-size: var(--text-sm);
    }

    .expand-icon {
      display: inline-block;
      width: 16px;
      text-align: center;
      transition: transform 0.2s ease;
    }

    .expand-icon.expanded {
      transform: rotate(90deg);
    }

    .instance-badge {
      display: inline-flex;
      align-items: center;
      padding: var(--space-xs) var(--space-md);
      background: var(--secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      color: var(--text);
    }

    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `];

  @property({type: Number}) instanceId: number | null = null;
  @state() private instances: DatabaseInstance[] = [];
  @state() private selectedInstance: number | null = null;
  @state() private selectedInstanceName = "";
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private collecting = false;
  @state() private detecting = false;
  @state() private snapshotTimes: SnapshotTime[] = [];
  @state() private tableList: TableListEntry[] = [];
  @state() private changes: SchemaChange[] = [];
  @state() private expandedTable: string | null = null;
  @state() private tableDetail: TableSchemaRow[] = [];
  @state() private snapshotDetail: TableSchemaRow[] = [];
  @state() private activeTab: "tables" | "changes" = "tables";
  @state() private collectResult: { collected: number; tables: number; columns: number } | null = null;
  @state() private hint: string | null = null;

  private get _activeInstanceId(): number | null {
    return this.instanceId ?? this.selectedInstance;
  }

  private _authHeaders(): Record<string, string> {
    const token = localStorage.getItem("token");
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  override firstUpdated() {
    void this.loadInstances();
  }

  private async loadInstances() {
    try {
      if (this.instanceId) {
        this.selectedInstance = this.instanceId;
      }
      const res = await fetch("/api/database/instances", {
        headers: this._authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to load instances");
      this.instances = await res.json();
      if (this.instanceId) {
        const inst = this.instances.find(i => i.id === this.instanceId);
        this.selectedInstanceName = inst?.name || "";
      } else if (this.instances.length > 0) {
        this.selectedInstance = this.instances[0].id;
        this.selectedInstanceName = this.instances[0].name;
      }
      this.loading = false;
      await this.refreshData();
    } catch (err: any) {
      this.error = err.message;
      this.loading = false;
    }
  }

  private async refreshData() {
    if (!this._activeInstanceId) return;
    await Promise.all([
      this.loadSnapshotTimes(),
      this.loadTableList(),
      this.loadChanges(),
    ]);
  }

  private async loadSnapshotTimes() {
    if (!this._activeInstanceId) return;
    try {
      const res = await fetch(`/api/schema/snapshots/${this._activeInstanceId}`, {
        headers: this._authHeaders(),
      });
      if (res.ok) {
        this.snapshotTimes = await res.json();
      } else {
        this.snapshotTimes = [];
      }
    } catch (err) {
      this.snapshotTimes = [];
    }
  }

  private async loadTableList() {
    if (!this._activeInstanceId) return;
    try {
      const res = await fetch(`/api/schema/snapshot/${this._activeInstanceId}`, {
        headers: this._authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.tables) {
          this.tableList = data.tables;
        }
      } else {
        this.tableList = [];
      }
    } catch (err) {
      this.tableList = [];
    }
  }

  private async loadChanges() {
    if (!this._activeInstanceId) return;
    try {
      const res = await fetch(`/api/schema/changes/${this._activeInstanceId}`, {
        headers: this._authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.changes) {
          this.changes = data.changes;
        } else {
          this.changes = [];
        }
      } else {
        this.changes = [];
      }
    } catch (err) {
      this.changes = [];
    }
  }

  private async handleCollect() {
    if (!this._activeInstanceId) return;
    this.collecting = true;
    this.collectResult = null;
    try {
      const res = await fetch(`/api/schema/collect/${this._activeInstanceId}`, {
        method: "POST",
        headers: { ...this._authHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        this.error = err.error || `请求失败 (${res.status})`;
        return;
      }
      const data = await res.json();
      if (data.success) {
        this.collectResult = data.data;
        await this.refreshData();
      } else {
        this.error = data.error || "采集失败";
      }
    } catch (err: any) {
      this.error = err.message;
    }
    this.collecting = false;
  }

  private async handleDetect() {
    if (!this._activeInstanceId) return;
    this.detecting = true;
    try {
      const res = await fetch(`/api/schema/changes/${this._activeInstanceId}`, {
        method: "POST",
        headers: { ...this._authHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        this.error = err.error || `请求失败 (${res.status})`;
        this.detecting = false;
        return;
      }
      const data = await res.json();
      if (data.success) {
        this.changes = data.changes || [];
        if (data.hint) {
          this.hint = data.hint;  // 非错误提示
        }
      } else {
        this.error = data.error || "检测变更失败";
      }
    } catch (err: any) {
      this.error = err.message;
    }
    this.detecting = false;
  }

  private async handleTableClick(tableName: string) {
    if (this.expandedTable === tableName) {
      this.expandedTable = null;
      this.tableDetail = [];
      return;
    }
    this.expandedTable = tableName;
    if (!this._activeInstanceId) return;
    try {
      const res = await fetch(`/api/schema/table/${this._activeInstanceId}/${tableName}`, {
        headers: this._authHeaders(),
      });
      if (res.ok) {
        this.tableDetail = await res.json();
      } else {
        this.tableDetail = [];
      }
    } catch (err) {
      this.tableDetail = [];
    }
  }

  private handleInstanceChange(e: Event) {
    const id = Number((e.target as HTMLSelectElement).value);
    this.selectedInstance = id;
    const inst = this.instances.find(i => i.id === id);
    this.selectedInstanceName = inst?.name || "";
    this.expandedTable = null;
    this.tableDetail = [];
    this.collectResult = null;
    this.error = null;
    this.refreshData();
  }

  private _formatTime(dateStr: string): string {
    const date = new Date(dateStr);
    const diff = Date.now() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  }

  private _formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  private _changeLabel(change: SchemaChange): string {
    if (change.target === "table") {
      return change.table_name;
    }
    return `${change.table_name}.${change.column_name || ""}`;
  }

  private _changeDetails(change: SchemaChange) {
    if (!change.details) return "";
    const parts: string[] = [];
    for (const [key, val] of Object.entries(change.details)) {
      if (val.old && val.new) {
        parts.push(`${key}: ${val.old} → ${val.new}`);
      } else if (val.new) {
        parts.push(`${key}: ${val.new}`);
      }
    }
    return parts.join(", ");
  }

  private get stats() {
    return {
      totalTables: this.tableList.length,
      totalChanges: this.changes.length,
      totalSnapshots: this.snapshotTimes.length,
      added: this.changes.filter(c => c.type === "added").length,
      modified: this.changes.filter(c => c.type === "modified").length,
      deleted: this.changes.filter(c => c.type === "deleted").length,
    };
  }

  override render() {
    if (this.loading) {
      return html`<div class="loading" style="flex-direction:column;gap:16px;">
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:var(--space-md);width:100%;">
            <div class="skeleton-block" style="height:70px;"></div>
            <div class="skeleton-block" style="height:70px;"></div>
            <div class="skeleton-block" style="height:70px;"></div>
            <div class="skeleton-block" style="height:70px;"></div>
          </div>
          <div class="skeleton-block" style="height:100px;"></div>
          <div class="skeleton-block" style="height:200px;"></div>
        </div>`;
    }

    // Error is shown inline as a dismissible banner below

    return html`
      <div class="page">
        ${this.error ? html`
          <div class="card" style="background: rgba(239, 68, 68, 0.06); border-color: rgba(239, 68, 68, 0.3); padding: var(--space-md) var(--space-lg); margin-bottom: var(--space-md); font-size: var(--text-base); color: var(--danger); display: flex; align-items: center; gap: var(--space-md);">
            <span style="flex: 1;">${this.error}</span>
            <button class="btn small" @click=${() => { this.error = null; }} style="flex-shrink: 0;">&times;</button>
          </div>
        ` : ""}
        <!-- 统计概览 -->
        <div style="display:grid;gap:var(--space-md);grid-template-columns:repeat(4,1fr);margin-bottom:var(--space-xl)">
          <stat-card label="表数量" value="${this.stats.totalTables}" hint="当前快照"></stat-card>
          <stat-card label="快照数" value="${this.stats.totalSnapshots}" hint="历史记录" variant="info"></stat-card>
          <stat-card label="新增" value="${this.stats.added}" hint="新增表/列" variant="ok"></stat-card>
          <stat-card label="删除" value="${this.stats.deleted}" hint="删除表/列" variant="danger"></stat-card>
        </div>

        <!-- 操作栏 -->
        <app-card variant="default">
          <div class="toolbar" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px">
            ${!this.instanceId ? html`
              <label style="font-size: var(--text-sm); font-weight: 500; color: var(--text-strong); white-space: nowrap;">
                实例：
              </label>
              <select class="select" @change=${this.handleInstanceChange} value=${this.selectedInstance || ""}>
                ${this.instances.map(
                  (inst) => html`<option value=${inst.id} ?selected=${inst.id === this.selectedInstance}>${inst.name} (${inst.db_type})</option>`
                )}
              </select>
            ` : html`<span style="font-size: var(--text-sm); font-weight: 500; color: var(--text-strong);">实例 ID: ${this.instanceId}</span>`}

            <button class="btn-primary" @click=${this.handleCollect} ?disabled=${this.collecting || !this._activeInstanceId}>
              ${this.collecting ? html`<span class="spinner"></span> 采集中...` : "采集快照"}
            </button>

            <button class="btn" @click=${this.handleDetect} ?disabled=${this.detecting || !this._activeInstanceId}>
              ${this.detecting ? html`<span class="spinner"></span> 检测中...` : "检测变更"}
            </button>

            <button class="btn" @click=${this.refreshData} style="margin-left: auto;">
              刷新
            </button>
          </div>

          ${this.collectResult
            ? html`
                <div style="padding: var(--space-md) var(--space-lg); background: rgba(34, 197, 94, 0.08); border-bottom: 1px solid var(--border); font-size: var(--text-base); color: var(--text);">
                  采集成功：${this.collectResult.tables} 张表，${this.collectResult.columns} 个列
                </div>
              `
            : ""}
        </app-card>

        <!-- Tab 切换 -->
        <app-card variant="default">
          <div class="toolbar" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px">
            <button class="btn ${this.activeTab === "tables" ? "primary" : ""}" @click=${() => { this.activeTab = "tables"; }}>
              表结构列表
            </button>
            <button class="btn ${this.activeTab === "changes" ? "primary" : ""}" @click=${() => { this.activeTab = "changes"; }}>
              变更历史
            </button>
          </div>

          ${this.activeTab === "tables" ? this._renderTables() : this._renderChanges()}
        </app-card>

        <!-- 快照时间线 -->
        ${this.snapshotTimes.length > 0
          ? html`
              <app-card variant="default">
                <div slot="header">快照时间线</div>
                ${this.snapshotTimes.map(
                  (st) => html`
                    <div class="snapshot-time-item">
                      <span style="font-size: var(--text-base); color: var(--text-strong);">
                        ${new Date(st.snapshot_time).toLocaleString("zh-CN")}
                      </span>
                      <span style="font-size: var(--text-sm); color: var(--muted);">
                        ${st.tables} 张表 · ${st.columns} 列
                      </span>
                    </div>
                  `
                )}
              </app-card>
            `
          : ""}
      </div>
    `;
  }

  private _renderTables() {
    if (this.tableList.length === 0) {
      return html`
        <app-empty-state title="暂无表结构数据" description="点击「采集快照」从数据库实例采集表结构">
          <div slot="icon">${icons['file-text']}</div>
        </app-empty-state>
      `;
    }

    return html`
      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              <th style="width: 30px;"></th>
              <th>表名</th>
              <th style="width: 100px; text-align: center;">行数</th>
              <th style="width: 100px; text-align: center;">大小</th>
              <th style="width: 80px; text-align: center;">列数</th>
              <th>注释</th>
            </tr>
          </thead>
          <tbody>
            ${this.tableList.map(
              (table) => html`
                <tr class="table-row" @click=${() => this.handleTableClick(table.table_name)}>
                  <td>
                    <span class="expand-icon ${this.expandedTable === table.table_name ? "expanded" : ""}">
                      &#9654;
                    </span>
                  </td>
                  <td>
                    <span class="instance-badge">${table.table_name}</span>
                  </td>
                  <td style="text-align: center;">${table.table_rows.toLocaleString()}</td>
                  <td style="text-align: center;">${this._formatBytes(table.data_length)}</td>
                  <td style="text-align: center;">${table.column_count}</td>
                  <td style="text-align: center; color: var(--muted); font-size: var(--text-sm);">${table.table_comment || "—"}</td>
                </tr>
                ${this.expandedTable === table.table_name
                  ? html`
                      <tr class="expanded-content">
                        <td colspan="6">
                          ${this.tableDetail.length > 0
                            ? html`
                                <table class="table">
                                  <thead>
                                    <tr>
                                      <th>列名</th>
                                      <th>类型</th>
                                      <th style="width: 60px; text-align: center;">主键</th>
                                      <th style="width: 60px; text-align: center;">可空</th>
                                      <th>默认值</th>
                                      <th>注释</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    ${this.tableDetail.map(
                                      (col) => html`
                                        <tr>
                                          <td style="font-weight: 500;">${col.column_name}</td>
                                          <td><app-badge variant="info">${col.column_type}</app-badge></td>
                                          <td style="text-align: center;">${col.column_key === "PRI" ? "🔑" : ""}</td>
                                          <td style="text-align: center;">${col.is_nullable === "YES" ? "YES" : "NO"}</td>
                                          <td style="text-align: center; font-size: var(--text-sm); color: var(--muted);">${col.column_default || "—"}</td>
                                          <td style="text-align: center; font-size: var(--text-sm); color: var(--muted);">${col.column_comment || "—"}</td>
                                        </tr>
                                      `
                                    )}
                                  </tbody>
                                </table>
                              `
                            : html`<div class="loading" style="min-height: 60px;">加载列信息...</div>`
                          }
                        </td>
                      </tr>
                    `
                  : ""}
              `
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private _renderChanges() {
    if (this.changes.length === 0) {
      return html`
        <app-empty-state title="暂无变更" description="点击「检测变更」对比最近两次快照">
          <div slot="icon">${icons['check-circle']}</div>
        </app-empty-state>
      `;
    }

    return html`
      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              <th style="width: 90px; text-align: center;">类型</th>
              <th>变更对象</th>
              <th>详情</th>
              <th style="width: 120px; text-align: center;">时间</th>
            </tr>
          </thead>
          <tbody>
            ${this.changes.map(
              (change) => html`
                <tr>
                  <td style="text-align: center;">
                    ${change.type === "added"
                      ? html`<app-badge variant="ok">新增</app-badge>`
                      : change.type === "modified"
                        ? html`<app-badge variant="warn">修改</app-badge>`
                        : html`<app-badge variant="danger">删除</app-badge>`
                    }
                  </td>
                  <td>
                    <span class="instance-badge">${this._changeLabel(change)}</span>
                    <div style="font-size: var(--text-xs); color: var(--muted); margin-top: 2px;">
                      ${change.target === "table" ? "表" : "列"}
                    </div>
                  </td>
                  <td style="text-align: center;">
                    ${change.details
                      ? html`<span class="change-detail">${this._changeDetails(change)}</span>`
                      : html`<span style="color: var(--muted); font-size: var(--text-sm);">—</span>`
                    }
                  </td>
                  <td style="text-align: center;"><span class="time-ago">${this._formatTime(change.detected_at)}</span></td>
                </tr>
              `
            )}
          </tbody>
        </table>
      </div>
    `;
  }
}

if (!customElements.get("schema-management-page")) {
  customElements.define("schema-management-page", SchemaManagementPage);
}
