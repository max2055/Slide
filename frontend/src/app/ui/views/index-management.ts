import { ListBrowser, renderListBrowser, listBrowserStyles } from '../components/list-browser.js';
import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state, property } from "lit/decorators.js";
import { showToast } from "../components/app-toast-container.js";
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

interface IndexRow {
  id: number;
  table_name: string;
  index_name: string;
  column_name: string;
  seq_in_index: number;
  non_unique: number;
  cardinality: number;
  sub_part: number | null;
  nullable: string;
  index_type: string;
  comment: string | null;
  collected_at: string;
  is_unused: boolean;
}

interface RedundancyReportRow {
  id: number;
  table_name: string;
  redundant_index: string;
  covered_by_index: string;
  reason: string;
  created_at: string;
}

@customElement("index-management-page")
export class IndexManagementPage extends LitElement {
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

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      margin-bottom: var(--space-lg);
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

    .toolbar {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-md) var(--space-lg);
      border-bottom: 1px solid var(--border);
      background: var(--bg-elevated);
      flex-wrap: wrap;
    }

    .btn:hover:not(:disabled) {
      background: var(--bg-hover);
      border-color: var(--border-strong);
    }

    .btn.primary:hover:not(:disabled) {
      background: var(--accent-solid-hover);
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
      padding: var(--space-md) var(--space-md);
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

    .tag {
      display: inline-flex;
      align-items: center;
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      font-weight: 600;
    }

    .tag.green {
      background: rgba(34, 197, 94, 0.12);
      color: var(--ok);
    }

    .tag.orange {
      background: var(--warn-subtle);
      color: var(--warn);
    }

    .tag.red {
      background: var(--danger-subtle);
      color: var(--danger);
    }

    .tag.blue {
      background: rgba(59, 130, 246, 0.12);
      color: var(--info);
    }

    .tag.gray {
      background: rgba(107, 114, 128, 0.12);
      color: var(--muted);
    }

    .redundant-card {
      border: 1px solid var(--danger);
      border-left: 4px solid var(--danger);
      border-radius: var(--radius-sm);
      padding: var(--space-md) var(--space-lg);
      margin-bottom: var(--space-sm);
      background: var(--danger-subtle);
    }

    .redundant-card__title {
      font-size: var(--text-base);
      font-weight: 600;
      color: var(--danger);
      margin-bottom: var(--space-xs);
    }

    .redundant-card__desc {
      font-size: var(--text-sm);
      color: var(--text);
    }

    .redundant-card__desc code {
      background: rgba(0, 0, 0, 0.08);
      padding: var(--space-xs) var(--space-xs);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
    }

    .expand-icon {
      display: inline-block;
      width: 16px;
      text-align: center;
      transition: transform 0.2s ease;
      cursor: pointer;
    }

    .expand-icon.expanded {
      transform: rotate(90deg);
    }

    .expanded-content {
      background: var(--bg-elevated);
    }

    .expanded-content .table td {
      padding: var(--space-sm) var(--space-md) var(--space-sm) 28px;
      font-size: var(--text-sm);
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
      font-size: 48px;
      margin-bottom: var(--space-md);
      opacity: 0.6;
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

    .spinner {
      display: inline-block;
      animation: spin 0.6s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
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

    .stats-row {
      display: flex;
      gap: var(--space-md);
      padding: var(--space-md) var(--space-lg);
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }

    .stat-item {
      font-size: var(--text-sm);
      color: var(--muted);
    }

    .stat-item span {
      font-weight: 700;
      color: var(--text-strong);
      margin-right: var(--space-xs);
    }

    .msg {
      padding: var(--space-md) var(--space-lg);
      font-size: var(--text-base);
    }

    .msg.success {
      color: var(--ok);
      background: rgba(34, 197, 94, 0.08);
      border-bottom: 1px solid var(--border);
    }

    .msg.error {
      color: var(--danger);
      background: var(--danger-subtle);
      border-bottom: 1px solid var(--border);
    }

    .unused-badge {
      display: inline-flex;
      align-items: center;
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
      font-size: 10px;
      font-weight: 600;
      background: rgba(107, 114, 128, 0.12);
      color: var(--muted);
      margin-left: var(--space-xs);
    }
  `];

  @property({ type: Number }) instanceId: number | null = null;
  @state() private instances: DatabaseInstance[] = [];
  @state() private selectedInstanceId: number | null = null;
  @state() private indexes: IndexRow[] = [];
  @state() private redundancyReport: RedundancyReportRow[] = [];
  @state() private unusedIndexes: IndexRow[] = [];
  @state() private selectedTable = "";
  private indexBrowser = new ListBrowser();
  private unusedBrowser = new ListBrowser();
  private redundancyBrowser = new ListBrowser();
  private indexRequest = 0;
  @state() private readAt: string | null = null;
  @state() private indexError: string | null = null;
  @state() private loading = false;
  @state() private collecting = false;
  @state() private message = "";
  @state() private msgType: "success" | "error" = "success";
  @state() private expandedIndex: string | null = null;
  @state() private tables: string[] = [];

  private authHeaders(): Record<string, string> {
    const token = localStorage.getItem("token");
    if (token) return { Authorization: `Bearer ${token}` };
    return {};
  }

  private ageTimer?: ReturnType<typeof setInterval>;
  override connectedCallback() {
    super.connectedCallback();
    this.ageTimer = setInterval(() => this.requestUpdate(), 30_000);
  }
  override disconnectedCallback() {
    clearInterval(this.ageTimer);
    super.disconnectedCallback();
  }

  override firstUpdated() {
    if (this.instanceId) {
      this.selectedInstanceId = this.instanceId;
      this.loadIndexes();
    } else {
      this.loadInstances();
    }
  }

  private async loadInstances() {
    try {
      const res = await authFetch("/api/database/instances", {
        headers: this.authHeaders(),
      });
      if (!res.ok) throw new Error(`实例列表加载失败 (HTTP ${res.status})`);
      if (res.ok) {
        this.instances = await res.json();
        if (this.instances.length > 0) {
          this.selectedInstanceId = this.instances[0].id;
          this.loadIndexes();
        }
      }
    } catch (e) {
      this.indexError = '实例列表加载失败或无权限';
    }
  }

  private async loadIndexes() {
    const id = this.selectedInstanceId;
    const request = ++this.indexRequest;
    this.indexes = []; this.unusedIndexes = []; this.redundancyReport = []; this.tables = [];
    this.expandedIndex = null; this.indexError = null; this.readAt = null;
    if (!id) return;
    this.loading = true;
    try {
      const results = await Promise.all(['', '/redundancy', '/unused'].map(async suffix => {
        const res = await authFetch(`/api/indexes/${id}${suffix}`, { headers: this.authHeaders() });
        if (!res.ok) throw new Error(res.status === 403 ? '无权限查看索引' : `索引加载失败 (HTTP ${res.status})`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('索引响应无效');
        return data;
      }));
      if (request !== this.indexRequest) return;
      [this.indexes, this.redundancyReport, this.unusedIndexes] = results;
      this.readAt = new Date().toISOString();
      this.tables = [...new Set(this.indexes.map(i => i.table_name))].sort();
      if (this.selectedTable && !this.tables.includes(this.selectedTable)) this.selectedTable = '';
    } catch (error: any) {
      if (request === this.indexRequest) this.indexError = error.message;
    } finally {
      if (request === this.indexRequest) this.loading = false;
    }
  }

  private async collectIndexes() {
    if (!this.selectedInstanceId) return;
    this.collecting = true;
    this.message = "";
    this.requestUpdate();

    try {
      const res = await authFetch(`/api/index/collect/${this.selectedInstanceId}`, {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.msgType = "success";
        this.message = `采集完成：${data.data.collected} 条记录，${data.data.indexes} 个索引，${data.data.tables} 张表`;
        this.loadIndexes();
      } else {
        this.msgType = "error";
        this.message = data.error || "采集失败";
      }
    } catch (e: any) {
      this.msgType = "error";
      this.message = e.message || "采集请求失败";
    }

    this.collecting = false;
    this.requestUpdate();
  }

  private async detectRedundancy() {
    if (!this.selectedInstanceId) return;
    this.collecting = true;
    this.message = "";
    this.requestUpdate();

    try {
      const res = await authFetch(`/api/index/detect/${this.selectedInstanceId}`, {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (res.ok) {
        if (Array.isArray(data)) {
          this.msgType = "success";
          this.message = `检测完成：发现 ${data.length} 个冗余索引`;
          this.redundancyReport = data;
        } else if (data.error) {
          this.msgType = "error";
          this.message = data.error;
        }
      }
    } catch (e: any) {
      this.msgType = "error";
      this.message = e.message || "检测请求失败";
    }

    this.collecting = false;
    this.requestUpdate();
  }

  private toggleExpand(indexName: string) {
    this.expandedIndex = this.expandedIndex === indexName ? null : indexName;
    this.requestUpdate();
  }

  private getFilteredIndexes(): IndexRow[] {
    if (!this.selectedTable) return this.indexes;
    return this.indexes.filter((i) => i.table_name === this.selectedTable);
  }

  private getGroupedIndexes(): Map<string, IndexRow[]> {
    const grouped = new Map<string, IndexRow[]>();
    const filtered = this.getFilteredIndexes();
    for (const row of filtered) {
      const key = JSON.stringify([row.table_name, row.index_name]);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }
    for (const rows of grouped.values()) rows.sort((a, b) => a.seq_in_index - b.seq_in_index);
    return grouped;
  }

  private getUnusedSet(): Set<string> {
    const set = new Set<string>();
    for (const u of this.unusedIndexes) {
      set.add(`${u.table_name}.${u.index_name}`);
    }
    return set;
  }

  private formatColumns(rows: IndexRow[]): string {
    return rows.map((r) => r.column_name).join(", ");
  }

  private formatCardinality(cardinality: number): string {
    if (cardinality >= 1000000) return (cardinality / 1000000).toFixed(1) + "M";
    if (cardinality >= 1000) return (cardinality / 1000).toFixed(1) + "K";
    return String(cardinality);
  }

  override render() {
    const selectedInstance = this.instances.find(
      (i) => i.id === this.selectedInstanceId,
    );
    const filteredIndexes = this.getFilteredIndexes();
    const groupedIndexes = this.getGroupedIndexes();
    const unusedSet = this.getUnusedSet();
    const indexCount = new Set(this.indexes.map(row => JSON.stringify([row.table_name, row.index_name]))).size;
    const indexPage = this.indexBrowser.select([...groupedIndexes.entries()], ([, rows]) => `${rows[0].table_name} ${rows[0].index_name} ${this.formatColumns(rows)}`, ([, rows]) => `${rows[0].table_name}.${rows[0].index_name}`);
    const unusedPage = this.unusedBrowser.select(this.unusedIndexes, row => `${row.table_name} ${row.index_name}`, row => `${row.table_name}.${row.index_name}`);
    const redundancyPage = this.redundancyBrowser.select(this.redundancyReport, row => `${row.table_name} ${row.redundant_index} ${row.covered_by_index}`, row => `${row.table_name}.${row.redundant_index}`);

    return html`
      <div class="page">
        <!-- 实例选择 + 采集 -->
        <div class="card">
          <div class="card-header">
            <span class="card-title">索引管理</span>
            <div style="display: flex; gap: var(--space-sm); align-items: center; flex-wrap: wrap;">
              ${!this.instanceId ? html`
              <select
                class="select"
                .value="${this.selectedInstanceId?.toString() || ""}"
                @change="${(e: Event) => {
                  this.selectedInstanceId = Number((e.target as HTMLSelectElement).value);
                  this.selectedTable = "";
                  this.indexBrowser.page = this.unusedBrowser.page = this.redundancyBrowser.page = 1;
                  this.indexes = [];
                  this.redundancyReport = [];
                  this.unusedIndexes = [];
                  this.loadIndexes();
                }}"
              >
                ${this.instances.map(
                  (inst) =>
                    html`<option value="${inst.id}">${inst.name} (${inst.host}:${inst.port})</option>`,
                )}
              </select>
              ` : ""}
              ${selectedInstance
                ? html`<span class="instance-badge"
                    >${selectedInstance.database_name || "未指定数据库"}</span
                  >`
                : ""}
              <button
                class="btn-primary"
                ?disabled="${this.collecting || !this.selectedInstanceId}"
                @click="${this.collectIndexes}"
              >
                ${this.collecting
                  ? html`<span class="spinner">&#8987;</span> 采集中...`
                  : "采集索引"}
              </button>
            </div>
          </div>

          ${this.message
            ? html`<div class="msg ${this.msgType}">${this.message}</div>`
            : ""}

          <p style="padding:var(--space-md);color:var(--muted);font-size:var(--text-sm);overflow-wrap:anywhere;">
            来源：已存索引采集记录 · 观测：${evidenceTime(this.indexes.length ? this.indexes.reduce((oldest, row) => Date.parse(row.collected_at) < Date.parse(oldest) ? row.collected_at : oldest, this.indexes[0].collected_at) : null)} · ${evidenceTimeState(this.indexes.length ? this.indexes.reduce((oldest, row) => Date.parse(row.collected_at) < Date.parse(oldest) ? row.collected_at : oldest, this.indexes[0].collected_at) : null)} · 读取：${evidenceTime(this.readAt)}<br>
            范围：采集时配置范围中有索引记录的表（历史未保存库名）；不含无索引的表/视图。当前配置：${selectedInstance ? selectedInstance.database_name || '未指定' : '未读取'}，不能据此确认历史库名。索引按表名＋索引名去重，列记录不重复计数；与容量全部可见非系统库、结构快照范围不同。
          </p>
          <div class="stats-row">
            <div class="stat-item">
              <span>${this.loading || this.indexError ? '未知' : indexCount}</span> 索引
            </div>
            <div class="stat-item">
              <span>${this.loading || this.indexError ? '未知' : this.tables.length}</span> 有索引的表
            </div>
            <div class="stat-item">
              <span style="color: var(--warn);">${this.redundancyReport.length}</span> 冗余
            </div>
            <div class="stat-item">
              <span style="color: var(--muted);">${this.unusedIndexes.length}</span> 未使用
            </div>
          </div>
        </div>

        <!-- 冗余索引警告 -->
        ${this.redundancyReport.length > 0
          ? html`
              <div class="card">
                <div class="card-header">
                  <span class="card-title" style="color: var(--danger);">
                    冗余索引警告 (${this.redundancyReport.length})
                  </span>
                </div>
                ${renderListBrowser(this.redundancyBrowser, redundancyPage.total, this.redundancyReport.length, "冗余索引", () => this.requestUpdate())}
                <div style="padding: var(--space-md) var(--space-lg);">
                  ${redundancyPage.rows.map(
                    (r) => html`
                      <div class="redundant-card">
                        <div class="redundant-card__title">
                          ${r.table_name} / ${r.redundant_index}
                        </div>
                        <div class="redundant-card__desc">
                          索引 <code>${r.redundant_index}</code> 被
                          <code>${r.covered_by_index}</code> 覆盖 — 可考虑删除
                        </div>
                        <div style="font-size: var(--text-xs); color: var(--muted); margin-top: 4px;">
                          ${r.reason}
                        </div>
                      </div>
                    `,
                  )}
                </div>
              </div>
            `
          : ""}

        <!-- 未使用索引列表 -->
        ${this.unusedIndexes.length > 0
          ? html`
              <div class="card">
                <div class="card-header">
                  <span class="card-title">
                    未使用索引 (${this.unusedIndexes.length})
                  </span>
                </div>
                ${renderListBrowser(this.unusedBrowser, unusedPage.total, this.unusedIndexes.length, "未使用索引", () => this.requestUpdate())}
                <div class="table-container">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>表名</th>
                        <th>索引名</th>
                        <th>类型</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${unusedPage.rows.map(
                        (u) => html`
                          <tr>
                            <td>${u.table_name}</td>
                            <td>${u.index_name}</td>
                            <td>${u.index_type}</td>
                            <td><span class="tag gray">未使用</span></td>
                          </tr>
                        `,
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            `
          : ""}

        <!-- 表选择器 -->
        ${this.tables.length > 0
          ? html`
              <div class="card">
                <div class="toolbar">
                  <label style="font-size: var(--text-sm); color: var(--muted);">筛选表：</label>
                  <select
                    class="select" aria-label="筛选表"
                    .value="${this.selectedTable}"
                    @change="${(e: Event) => {
                      this.selectedTable = (e.target as HTMLSelectElement).value;
                      this.indexBrowser.page = 1;
                      this.expandedIndex = null;
                      this.requestUpdate();
                    }}"
                  >
                    <option value="">全部表</option>
                    ${this.tables.map(
                      (t) => html`<option value="${t}">${t}</option>`,
                    )}
                  </select>
                  <span style="font-size: var(--text-sm); color: var(--muted);">
                    显示 ${filteredIndexes.length} 条记录
                  </span>
                </div>
              </div>
            `
          : ""}

        <!-- 索引列表 -->
        <div class="card">
          <div class="card-header">
            <span class="card-title">
              ${this.selectedTable
                ? `索引列表 — ${this.selectedTable}`
                : "索引列表"}
            </span>
          </div>

          ${!this.loading && !this.indexError ? renderListBrowser(this.indexBrowser, indexPage.total, indexCount, "索引", () => this.requestUpdate()) : ''}
          ${this.indexError ? html`<div role="alert">${this.indexError}<button class="btn" @click=${() => this.loadIndexes()}>重试</button></div>` : this.loading
            ? html`<div role="status" class="loading" style="flex-direction:column;gap:12px;padding:var(--space-xl);">加载中...
                <div class="skeleton-line skeleton-line--long"></div>
                <div class="skeleton-line skeleton-line--long"></div>
                <div class="skeleton-line skeleton-line--long"></div>
                <div class="skeleton-line skeleton-line--long"></div>
                <div class="skeleton-line skeleton-line--long"></div>
              </div>`
            : groupedIndexes.size === 0
              ? html`
                  <div class="empty">
                    <div class="empty__content">
                      <div class="empty__icon">&#128270;</div>
                      <div class="empty__title">暂无索引数据</div>
                      <div class="empty__desc">请先选择实例并点击「采集索引」</div>
                    </div>
                  </div>
                `
              : html`
                  <div class="table-container">
                    <table class="table">
                      <thead>
                        <tr>
                          <th style="width: 24px; text-align:center;"></th>
                          <th>表名</th>
                          <th>索引名</th>
                          <th>列</th>
                          <th>类型</th>
                          <th>基数</th>
                          <th>唯一</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${indexPage.rows.map(
                          ([indexKey, rows]) => {
                            const indexName = rows[0].index_name;
                            const isExpanded = this.expandedIndex === indexKey;
                            const isUnused = unusedSet.has(
                              `${rows[0].table_name}.${indexName}`,
                            );
                            return html`
                              <tr>
                                <td style="text-align:center;">
                                  <button aria-label=${`展开索引 ${rows[0].table_name}.${indexName}`} aria-expanded=${isExpanded}
                                    class="btn expand-icon ${isExpanded ? "expanded" : ""}"
                                    @click="${() => this.toggleExpand(indexKey)}"
                                  >&#9654;</button>
                                </td>
                                <td>${rows[0].table_name}</td>
                                <td>
                                  ${indexName}
                                  ${isUnused
                                    ? html`<span class="unused-badge">未使用</span>`
                                    : ""}
                                </td>
                                <td>${this.formatColumns(rows)}</td>
                                <td>${rows[0].index_type}</td>
                                <td>${this.formatCardinality(rows[0].cardinality)}</td>
                                <td>
                                  ${rows[0].non_unique === 0
                                    ? html`<span class="tag green">UNIQUE</span>`
                                    : rows[0].index_name === "PRIMARY"
                                      ? html`<span class="tag blue">PRIMARY</span>`
                                      : html`<span class="tag gray">NON-UNIQUE</span>`}
                                </td>
                              </tr>
                              ${isExpanded
                                ? html`
                                    <tr class="expanded-content">
                                      <td colspan="7">
                                        <table class="table">
                                          <thead>
                                            <tr>
                                              <th>顺序</th>
                                              <th>列名</th>
                                              <th>可空</th>
                                              <th>基数</th>
                                              <th>前缀长度</th>
                                              <th>注释</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            ${rows.map(
                                              (r) => html`
                                                <tr>
                                                  <td>${r.seq_in_index}</td>
                                                  <td>${r.column_name}</td>
                                                  <td>${r.nullable}</td>
                                                  <td>${this.formatCardinality(r.cardinality)}</td>
                                                  <td>${r.sub_part !== null ? r.sub_part : "-"}</td>
                                                  <td>${r.comment || "-"}</td>
                                                </tr>
                                              `,
                                            )}
                                          </tbody>
                                        </table>
                                      </td>
                                    </tr>
                                  `
                                : ""}
                            `;
                          },
                        )}
                      </tbody>
                    </table>
                  </div>
                `}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "index-management-page": IndexManagementPage;
  }
}
