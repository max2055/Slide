import { ListBrowser, renderListBrowser, listBrowserStyles } from '../components/list-browser.js';
import { LitElement, html, css, type PropertyValues } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state, property } from "lit/decorators.js";
import "../components/app-card.js";
import "../components/app-empty-state.js";
import "../components/app-badge.js";
import { icons } from "../../../icons.js";
import "../../../components/stat-card.js";
import { authFetch } from '../../../api/index.js';

import { evidenceTime, evidenceTimeState } from './health-score-state.js';

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
  data_length: number | null;
}

interface TableListEntry {
  snapshot_time?: string;
  table_name: string;
  table_comment: string | null;
  table_rows: number;
  data_length: number | null;
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
  static styles = [listBrowserStyles, sharedBtnStyles, css`
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
  private tableBrowser = new ListBrowser();
  @state() private tablesLoading = false;
  @state() private snapshotsLoading = false;
  @state() private snapshotsError = '';
  @state() private changesLoading = false;
  @state() private changesError = '';
  @state() private instancesError = '';
  @state() private accessInvalidated = false;
  @state() private schemaAccessError = "";
  private instancesRequest = 0;
  @state() private tablesError: string | null = null;
  private tableRequest = 0;
  private contextVersion = 0;
  private snapshotRequest = 0;
  private changesRequest = 0;
  @state() private tableList: TableListEntry[] = [];
  @state() private changes: SchemaChange[] = [];
  @state() private expandedTable: string | null = null;
  @state() private detailError: string | null = null;
  @state() private detailLoading = false;
  private detailRequest = 0;
  @state() private tableDetail: TableSchemaRow[] = [];
  @state() private snapshotDetail: TableSchemaRow[] = [];
  @state() private activeTab: "tables" | "changes" = "tables";
  @state() private readAt: string | null = null;
  @state() private collectResult: { collected: number; tables: number; columns: number } | null = null;
  @state() private hint: string | null = null;

  private get _activeInstanceId(): number | null {
    return this.instanceId ?? this.selectedInstance;
  }

  private _authHeaders(): Record<string, string> {
    const token = localStorage.getItem("token");
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private ageTimer?: ReturnType<typeof setInterval>;
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.accessChanged);
    window.addEventListener('slide-session-expired', this.accessChanged);
    this.ageTimer = setInterval(() => this.requestUpdate(), 30_000);
  }
  override disconnectedCallback() {
    this.instancesRequest++;
    this.resetInstanceData();
    window.removeEventListener('slide-permissions-loaded', this.accessChanged);
    window.removeEventListener('slide-session-expired', this.accessChanged);
    clearInterval(this.ageTimer);
    super.disconnectedCallback();
  }

  override firstUpdated() {
    void this.loadInstances();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has('instanceId') && changed.get('instanceId') !== undefined) {
      this.resetInstanceData();
      if (!this.loading) void this.refreshData();
    }
  }

  private readonly accessChanged = () => {
    this.instancesRequest++;
    this.accessInvalidated = true;
    this.resetInstanceData();
    this.instances = [];
    this.selectedInstance = null;
    this.loading = false;
    this.instancesError = '权限或登录状态已变更，请重新读取数据库实例清单';
  };

  private resetInstanceData() {
    this.contextVersion++;
    this.tableRequest++;
    this.snapshotRequest++;
    this.changesRequest++;
    this.detailRequest++;
    this.tableBrowser.page = 1;
    this.selectedInstanceName = this.instances.find(i => i.id === this._activeInstanceId)?.name || "";
    this.snapshotTimes = [];
    this.tableList = [];
    this.changes = [];
    this.expandedTable = null;
    this.tableDetail = [];
    this.snapshotDetail = [];
    this.detailError = null;
    this.detailLoading = false;
    this.tablesError = null;
    this.schemaAccessError = "";
    this.tablesLoading = false;
    this.snapshotsError = this.changesError = '';
    this.snapshotsLoading = this.changesLoading = false;
    this.readAt = null;
    this.collectResult = null;
    this.hint = null;
    this.error = null;
    this.collecting = false;
    this.detecting = false;
  }

  private async loadInstances() {
    const request = ++this.instancesRequest;
    this.loading = true;
    this.instancesError = '';
    this.accessInvalidated = false;
    try {
      const res = await authFetch("/api/database/instances", {
        headers: this._authHeaders(), signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(this.readFailure('数据库实例清单', res.status));
      const instances = await res.json();
      if (!Array.isArray(instances)) throw new Error('数据库实例清单读取失败');
      if (request !== this.instancesRequest) return;
      this.instances = instances;
      this.selectedInstance = this.instanceId ?? instances.find(instance => instance.id === this.selectedInstance)?.id ?? instances[0]?.id ?? null;
      this.selectedInstanceName = instances.find(i => i.id === this._activeInstanceId)?.name ?? '';
    } catch (error) {
      if (request !== this.instancesRequest) return;
      this.instances = [];
      this.instancesError = error instanceof Error && error.message.startsWith('数据库实例清单') ? error.message : '数据库实例清单读取失败';
    } finally {
      if (request === this.instancesRequest) this.loading = false;
    }
    if (request === this.instancesRequest) await this.refreshData();
  }

  private readFailure(label: string, status: number) {
    return [401, 403, 404].includes(status)
      ? `${label}不可访问，请确认登录和查看权限` : `${label}读取失败`;
  }

  private async refreshData() {
    if (!this._activeInstanceId || this.accessInvalidated) return;
    this.schemaAccessError = "";
    await Promise.all([
      this.loadSnapshotTimes(),
      this.loadTableList(),
      this.loadChanges(),
    ]);
  }

  private restrictSchemaRead(response: Response) {
    if (![401, 403].includes(response.status)) return false;
    this.resetInstanceData();
    this.schemaAccessError = '无法读取表结构，请确认登录和查看权限';
    return true;
  }

  private async loadSnapshotTimes() {
    const id = this.accessInvalidated ? null : this._activeInstanceId;
    const request = ++this.snapshotRequest;
    if (!id) return;
    const current = () => request === this.snapshotRequest && id === this._activeInstanceId;
    this.snapshotsLoading = true;
    this.snapshotTimes = [];
    this.snapshotsError = '';
    try {
      const res = await authFetch(`/api/schema/snapshots/${id}`, { headers: this._authHeaders(), signal: AbortSignal.timeout(15000) });
      if (!current() || this.restrictSchemaRead(res)) return;
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error();
      if (current()) this.snapshotTimes = data;
    } catch {
      if (current()) this.snapshotsError = '快照历史读取失败';
    } finally { if (current()) this.snapshotsLoading = false; }
  }

  private async loadTableList() {
    const id = this.accessInvalidated ? null : this._activeInstanceId;
    const request = ++this.tableRequest;
    if (!id) { this.tableList = []; return; }
    this.tablesLoading = true;
    this.tablesError = null;
    this.tableList = [];
    this.readAt = null;
    this.expandedTable = null;
    this.detailRequest++;
    this.tableDetail = [];
    const current = () => request === this.tableRequest && id === this._activeInstanceId;
    try {
      const res = await authFetch(`/api/schema/snapshot/${id}`, { headers: this._authHeaders(), signal: AbortSignal.timeout(15000) });
      if (!current() || this.restrictSchemaRead(res)) return;
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (!Array.isArray(data.tables)) throw new Error('表结构响应无效');
      if (request === this.tableRequest && id === this._activeInstanceId) { this.tableList = data.tables; this.readAt = new Date().toISOString(); }
    } catch {
      if (current()) this.tablesError = '表结构读取失败';
    } finally {
      if (request === this.tableRequest && id === this._activeInstanceId) this.tablesLoading = false;
    }
  }

  private async loadChanges() {
    const id = this.accessInvalidated ? null : this._activeInstanceId;
    const request = ++this.changesRequest;
    if (!id) return;
    const current = () => request === this.changesRequest && id === this._activeInstanceId;
    this.changesLoading = true;
    this.changes = [];
    this.changesError = '';
    this.hint = null;
    try {
      const res = await authFetch(`/api/schema/changes/${id}`, { headers: this._authHeaders(), signal: AbortSignal.timeout(15000) });
      if (!current() || this.restrictSchemaRead(res)) return;
      if (!res.ok) throw new Error();
      const data = await res.json();
      const changes = data?.changes;
      const legacyHint = typeof changes?.hint === 'string' ? changes.hint : null;
      if (!Array.isArray(changes) && !legacyHint) throw new Error();
      if (!current()) return;
      this.changes = Array.isArray(changes) ? changes : [];
      this.hint = data.hint || legacyHint;
    } catch {
      if (current()) this.changesError = '变更历史读取失败';
    } finally { if (current()) this.changesLoading = false; }
  }

  private async handleCollect() {
    const id = this._activeInstanceId;
    if (!id || this.collecting || this.accessInvalidated || this.schemaAccessError) return;
    const version = this.contextVersion;
    const isCurrent = () => version === this.contextVersion && id === this._activeInstanceId;
    this.collecting = true;
    this.collectResult = null;
    try {
      const res = await authFetch(`/api/schema/collect/${id}`, {
        method: "POST",
        headers: { ...this._authHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (!isCurrent()) return;
        this.error = err.error || `请求失败 (${res.status})`;
        return;
      }
      const data = await res.json();
      if (!isCurrent()) return;
      if (data.success) {
        this.collectResult = data.data;
        await this.refreshData();
      } else {
        this.error = data.error || "采集失败";
      }
    } catch (err: any) {
      if (isCurrent()) this.error = err.message;
    } finally {
      if (isCurrent()) this.collecting = false;
    }
  }

  private async handleDetect() {
    const id = this._activeInstanceId;
    if (!id || this.detecting || this.accessInvalidated || this.schemaAccessError) return;
    const version = this.contextVersion;
    const isCurrent = () => version === this.contextVersion && id === this._activeInstanceId;
    ++this.changesRequest;
    this.changesLoading = false;
    this.hint = null;
    this.error = null;
    this.detecting = true;
    try {
      const res = await authFetch(`/api/schema/changes/${id}`, {
        method: "POST",
        headers: { ...this._authHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (!isCurrent()) return;
        this.error = err.error || `请求失败 (${res.status})`;
        if (isCurrent()) this.detecting = false;
        return;
      }
      const data = await res.json();
      if (!isCurrent()) return;
      if (data.success) {
        this.changesError = "";
        this.changes = Array.isArray(data.changes) ? data.changes : [];
        this.hint = data.hint || data.changes?.hint || null;
      } else {
        this.error = data.error || "检测变更失败";
      }
    } catch (err: any) {
      if (isCurrent()) this.error = err.message;
    }
    if (isCurrent()) this.detecting = false;
  }

  private async handleTableClick(tableName: string) {
    if (this.expandedTable === tableName) {
      this.detailRequest++;
      this.expandedTable = null;
      return;
    }
    this.expandedTable = tableName;
    await this.loadTableDetail(tableName);
  }

  private async loadTableDetail(tableName: string) {
    const id = this._activeInstanceId;
    if (!id || this.accessInvalidated || this.schemaAccessError) return;
    const request = ++this.detailRequest;
    const current = () => request === this.detailRequest && id === this._activeInstanceId && this.expandedTable === tableName;
    this.tableDetail = []; this.detailError = null; this.detailLoading = true;
    try {
      const res = await authFetch(`/api/schema/table/${id}/${encodeURIComponent(tableName)}`, { headers: this._authHeaders(), signal: AbortSignal.timeout(15000) });
      if (!current() || this.restrictSchemaRead(res)) return;
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error();
      if (current()) this.tableDetail = data;
    } catch {
      if (current()) this.detailError = '表列信息读取失败';
    } finally { if (current()) this.detailLoading = false; }
  }

  private handleInstanceChange(e: Event) {
    const id = Number((e.target as HTMLSelectElement).value);
    this.selectedInstance = id;
    this.resetInstanceData();
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

  private _formatBytes(bytes: number | null): string {
    if (bytes == null) return "不可用";
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
      const format = (value: unknown) => value === null ? "NULL" : value === "" ? '""' : String(value);
      if (Object.hasOwn(val, 'old') && Object.hasOwn(val, 'new')) {
        parts.push(`${key}: ${format(val.old)} → ${format(val.new)}`);
      } else if (Object.hasOwn(val, 'new')) {
        parts.push(`${key}: ${format(val.new)}`);
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

    const count = (value: number, loading: boolean, error: string | null) =>
      loading ? '读取中' : error || !this._activeInstanceId || this.accessInvalidated || this.schemaAccessError ? '未知' : value;

    return html`
      <div class="page">
        ${this.instancesError ? html`<p role="alert">${this.instancesError} <button class="btn btn-refresh" @click=${this.loadInstances}>重试读取实例清单</button></p>` : ""}
        ${this.schemaAccessError ? html`<p role="alert">${this.schemaAccessError} <button class="btn btn-refresh" @click=${this.refreshData}>重试读取表结构</button></p>` : ""}
        ${this.error ? html`
          <div class="card" style="background: rgba(239, 68, 68, 0.06); border-color: rgba(239, 68, 68, 0.3); padding: var(--space-md) var(--space-lg); margin-bottom: var(--space-md); font-size: var(--text-base); color: var(--danger); display: flex; align-items: center; gap: var(--space-md);">
            <span style="flex: 1;">${this.error}</span>
            <button class="btn small" @click=${() => { this.error = null; }} style="flex-shrink: 0;">&times;</button>
          </div>
        ` : ""}
        ${this.hint ? html`<p role="status" style="color:var(--muted);padding:var(--space-md) var(--space-lg);">${this.hint}</p>` : ""}
        <!-- 统计概览 -->
        <div style="display:grid;gap:var(--space-md);grid-template-columns:repeat(4,1fr);margin-bottom:var(--space-xl)">
          <stat-card label="表数量" value="${count(this.stats.totalTables, this.tablesLoading, this.tablesError)}" hint="已存快照"></stat-card>
          <stat-card label="快照数" value="${count(this.stats.totalSnapshots, this.snapshotsLoading, this.snapshotsError)}" hint="历史记录" variant="info"></stat-card>
          <stat-card label="新增" value="${count(this.stats.added, this.changesLoading, this.changesError)}" hint="新增表/列" variant="ok"></stat-card>
          <stat-card label="删除" value="${count(this.stats.deleted, this.changesLoading, this.changesError)}" hint="删除表/列" variant="danger"></stat-card>
        </div>

        <p style="color:var(--muted);font-size:var(--text-sm);overflow-wrap:anywhere;">
          来源：已存表结构快照 · 观测：${evidenceTime(this.tableList[0]?.snapshot_time)} · ${evidenceTimeState(this.tableList[0]?.snapshot_time)} · 读取：${evidenceTime(this.readAt)}<br>
          范围：采集时的配置范围（MySQL 为配置库的表/视图列元数据；历史未保存库名）。当前配置：${this.instances.find(i => i.id === this._activeInstanceId)?.database_name || '未指定'}，不能据此确认历史库名。表数按快照表名去重，容量覆盖全部可见非系统库，索引页仅含有索引记录的表。
        </p>
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

            <button class="btn-primary" @click=${this.handleCollect} ?disabled=${this.collecting || !this._activeInstanceId || this.accessInvalidated || !!this.schemaAccessError}>
              ${this.collecting ? html`<span class="spinner"></span> 采集中...` : "采集快照"}
            </button>

            <button class="btn" @click=${this.handleDetect} ?disabled=${this.detecting || !this._activeInstanceId || this.accessInvalidated || !!this.schemaAccessError}>
              ${this.detecting ? html`<span class="spinner"></span> 检测中...` : "检测变更"}
            </button>

            <button class="btn btn-refresh" @click=${this.refreshData} style="margin-left: auto;">
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
        ${this.snapshotsError ? html`<app-card><p role="alert">${this.snapshotsError} <button class="btn btn-refresh" @click=${this.loadSnapshotTimes}>重试快照历史</button></p></app-card>` : ""}
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
    if (this.schemaAccessError) return "";
    if (!this._activeInstanceId || this.accessInvalidated) return html`<p>请选择可访问的数据库实例</p>`;
    if (this.tablesLoading) return html`<div role="status" class="loading">加载表结构...</div>`;
    if (this.tablesError) return html`<div role="alert">${this.tablesError}<button class="btn" @click=${() => this.loadTableList()}>重试</button></div>`;
    const page = this.tableBrowser.select(this.tableList, row => `${row.table_name} ${row.table_comment || ''}`, row => row.table_name);
    if (this.tableList.length === 0) {
      return html`
        <app-empty-state title="暂无表结构数据" description="点击「采集快照」从数据库实例采集表结构">
          <div slot="icon">${icons['file-text']}</div>
        </app-empty-state>
      `;
    }

    return html`
      ${renderListBrowser(this.tableBrowser, page.total, this.tableList.length, "表结构", () => this.requestUpdate())}
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
            ${page.rows.map(
              (table) => html`
                <tr class="table-row" @click=${() => this.handleTableClick(table.table_name)}>
                  <td>
                    <button class="btn" aria-label=${`展开表 ${table.table_name}`} aria-expanded=${this.expandedTable === table.table_name}>&#9654;</button>
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
                            : html`<div role="status" class="loading" style="min-height: 60px;">${this.detailLoading ? '正在读取表列信息…' : this.detailError ? html`<span role="alert">${this.detailError}</span>
                              <button class="btn btn-refresh" @click=${() => this.loadTableDetail(table.table_name)}>重试读取表列信息</button>` : '当前表没有已保存的列信息'}</div>`
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
    if (this.schemaAccessError) return "";
    if (!this._activeInstanceId || this.accessInvalidated) return html`<p>请选择可访问的数据库实例</p>`;
    if (this.changesLoading) return html`<div role="status" class="loading">正在读取变更历史…</div>`;
    if (this.changesError) return html`<div role="alert">${this.changesError} <button class="btn btn-refresh" @click=${this.loadChanges}>重试变更历史</button></div>`;
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
