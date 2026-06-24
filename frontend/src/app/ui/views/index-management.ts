import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state, property } from "lit/decorators.js";
import { showToast } from "../components/app-toast-container.js";

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

    .btn:hover:not(:disabled) {
      background: var(--bg-hover);
      border-color: var(--border-strong);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn.primary {
      background: var(--accent);
      color: var(--accent-foreground);
      border-color: var(--accent);
    }

    .btn.primary:hover:not(:disabled) {
      background: var(--accent-hover);
    }

    .btn.danger {
      background: var(--danger);
      color: white;
      border-color: var(--danger);
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
      color: #22c55e;
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
      color: #6b7280;
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
      color: #6b7280;
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
      const res = await fetch("/api/database/instances", {
        headers: this.authHeaders(),
      });
      if (res.ok) {
        this.instances = await res.json();
        if (this.instances.length > 0) {
          this.selectedInstanceId = this.instances[0].id;
          this.loadIndexes();
        }
      }
    } catch (e) {
      showToast('Failed to load instance list', 'error');
    }
  }

  private async loadIndexes() {
    if (!this.selectedInstanceId) return;
    this.loading = true;
    this.requestUpdate();

    try {
      const res = await fetch(`/api/indexes/${this.selectedInstanceId}`, {
        headers: this.authHeaders(),
      });
      if (res.ok) {
        this.indexes = await res.json();
        this.tables = [...new Set(this.indexes.map((i) => i.table_name))].sort();
        if (this.selectedTable && !this.tables.includes(this.selectedTable)) {
          this.selectedTable = "";
        }
      }
    } catch (e) {
      showToast('Failed to load index data', 'error');
    }

    // 加载冗余报告
    try {
      const res = await fetch(`/api/indexes/${this.selectedInstanceId}/redundancy`, {
        headers: this.authHeaders(),
      });
      if (res.ok) {
        this.redundancyReport = await res.json();
      }
    } catch (e) {
      showToast('Failed to load redundancy report', 'error');
    }

    // 加载未使用索引
    try {
      const res = await fetch(`/api/indexes/${this.selectedInstanceId}/unused`, {
        headers: this.authHeaders(),
      });
      if (res.ok) {
        this.unusedIndexes = await res.json();
      }
    } catch (e) {
      showToast('Failed to load unused indexes', 'error');
    }

    this.loading = false;
    this.requestUpdate();
  }

  private async collectIndexes() {
    if (!this.selectedInstanceId) return;
    this.collecting = true;
    this.message = "";
    this.requestUpdate();

    try {
      const res = await fetch(`/api/index/collect/${this.selectedInstanceId}`, {
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
      const res = await fetch(`/api/index/detect/${this.selectedInstanceId}`, {
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
      if (!grouped.has(row.index_name)) {
        grouped.set(row.index_name, []);
      }
      grouped.get(row.index_name)!.push(row);
    }
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
                class="btn primary"
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

          <div class="stats-row">
            <div class="stat-item">
              <span>${new Set(this.indexes.map((i) => i.index_name)).size}</span> 索引
            </div>
            <div class="stat-item">
              <span>${this.tables.length}</span> 表
            </div>
            <div class="stat-item">
              <span style="color: var(--warn);">${this.redundancyReport.length}</span> 冗余
            </div>
            <div class="stat-item">
              <span style="color: #6b7280;">${this.unusedIndexes.length}</span> 未使用
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
                <div style="padding: var(--space-md) var(--space-lg);">
                  ${this.redundancyReport.map(
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
                      ${this.unusedIndexes.map(
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
                    class="select"
                    .value="${this.selectedTable}"
                    @change="${(e: Event) => {
                      this.selectedTable = (e.target as HTMLSelectElement).value;
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

          ${this.loading
            ? html`<div class="loading" style="flex-direction:column;gap:12px;padding:var(--space-xl);">
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
                        ${Array.from(groupedIndexes.entries()).map(
                          ([indexName, rows]) => {
                            const isExpanded = this.expandedIndex === indexName;
                            const isUnused = unusedSet.has(
                              `${rows[0].table_name}.${indexName}`,
                            );
                            return html`
                              <tr>
                                <td style="text-align:center;">
                                  <span
                                    class="expand-icon ${isExpanded ? "expanded" : ""}"
                                    @click="${() => this.toggleExpand(indexName)}"
                                  >&#9654;</span>
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
