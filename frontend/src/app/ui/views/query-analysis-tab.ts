import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state, property } from "lit/decorators.js";
import { renderIcon } from "../../../icons.js";

interface QanRow {
  fingerprint: string;
  calls: number;
  avg_time_ms: number;
  max_time_ms: number;
  total_time_ms: number;
  rows_examined: number;
}

interface ExplainNode {
  "Node Type"?: string;
  "Table Name"?: string;
  "Plan Rows"?: number;
  "Startup Cost"?: number;
  "Total Cost"?: number;
  "Actual Rows"?: number;
  "Actual Total Time"?: number;
  "Plans"?: ExplainNode[];
  "Index Name"?: string;
  ["Filter"]?: string;
  ["Output"]?: string[];
}

@customElement("query-analysis-tab")
export class QueryAnalysisTab extends LitElement {
  static styles = [sharedBtnStyles, css`
    :host { display: block; }
    .qan-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 1200px) { .qan-layout { grid-template-columns: 1fr; } }

    .panel {
      background: var(--card, #fff);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: var(--radius-lg, 8px);
      overflow: hidden;
    }
    .panel-header .icon {
      width: 16px; height: 16px;
      display: inline-flex; vertical-align: middle;
      margin-right: 4px;
    }
    .panel-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border, #e5e7eb);
      font-size: 14px;
      font-weight: 600;
      color: var(--text-strong, #111);
    }
    .panel-body { padding: 12px; }

    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th {
      text-align: left; padding: 8px 10px;
      font-weight: 600; color: var(--muted, #6b7280);
      border-bottom: 1px solid var(--border, #e5e7eb);
      white-space: nowrap; cursor: pointer;
    }
    td { padding: 8px 10px; border-bottom: 1px solid var(--border, #e5e7eb); }
    tr:hover { background: var(--bg-hover, #f9fafb); }
    tr.selected { background: var(--accent-subtle, #eff6ff); }

    .fingerprint {
      max-width: 300px; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; font-family: monospace; font-size: 11px;
    }
    .time-high { color: var(--destructive, #ef4444); font-weight: 600; }
    .time-mid { color: var(--warn, #f59e0b); font-weight: 600; }

    /* EXPLAIN tree */
    .tree-node { margin-left: 16px; border-left: 1px solid var(--border, #e5e7eb); padding-left: 12px; }
    .tree-node-header {
      display: flex; align-items: center; gap: 8px; padding: 4px 8px;
      border-radius: var(--radius-sm, 4px); cursor: pointer;
    }
    .tree-node-header:hover { background: var(--bg-hover, #f9fafb); }
    .tree-node-header .node-type { font-size: 13px; font-weight: 600; }
    .tree-node-header .table-name { font-size: 12px; color: var(--accent, #3b82f6); }
    .tree-node-meta { font-size: 11px; color: var(--muted, #6b7280); margin-left: 8px; }
    .tag { padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
    .tag-danger { background: #fef2f2; color: #ef4444; }
    .tag-warn { background: #fffbeb; color: #f59e0b; }
    .tag-info { background: #eff6ff; color: #3b82f6; }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border, #e5e7eb);
      background: var(--card, #fff);
      padding: 6px 14px;
      border-radius: var(--radius-sm, 4px);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      color: var(--text, #333);
    }

    .btn.primary {
      background: var(--accent, #3b82f6);
      color: var(--accent-foreground, #fff);
      border: 1px solid var(--accent, #3b82f6);
    }

    .empty { padding: 40px; text-align: center; color: var(--muted, #6b7280); }
    .loading { padding: 20px; text-align: center; color: var(--muted, #6b7280); }
  `];

  @property({ type: Number }) instanceId = 0;
  @state() private qanData: QanRow[] = [];
  @state() private explainPlan: any = null;
  @state() private selectedQuery: QanRow | null = null;
  @state() private loading = false;
  @state() private explainLoading = false;
  @state() private sortField: keyof QanRow = "total_time_ms";
  @state() private sortDir: "asc" | "desc" = "desc";

  override updated(changed: Map<string, unknown>) {
    if (changed.has("instanceId") && this.instanceId) {
      this.loadQanData();
    }
  }

  private _authHeaders(): Record<string, string> {
    const token = localStorage.getItem("token");
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async loadQanData() {
    if (!this.instanceId) return;
    this.loading = true;
    try {
      const res = await fetch(`/api/database/instances/${this.instanceId}/qan?limit=50`, {
        headers: this._authHeaders(),
      });
      if (res.ok) this.qanData = await res.json();
    } catch (e) { console.error("QAN load failed:", e); }
    this.loading = false;
  }

  private async loadExplain(sql: string) {
    this.explainLoading = true;
    try {
      const res = await fetch(
        `/api/database/instances/${this.instanceId}/explain?sql=${encodeURIComponent(sql)}`,
        { headers: this._authHeaders() }
      );
      if (res.ok) this.explainPlan = await res.json();
    } catch (e) { console.error("EXPLAIN load failed:", e); }
    this.explainLoading = false;
  }

  private _selectQuery(row: QanRow) {
    this.selectedQuery = row;
    this.loadExplain(row.fingerprint);
  }

  private _sort(field: keyof QanRow) {
    if (this.sortField === field) {
      this.sortDir = this.sortDir === "desc" ? "asc" : "desc";
    } else {
      this.sortField = field;
      this.sortDir = "desc";
    }
    this.qanData = [...this.qanData].sort((a, b) => {
      const va = a[field] as number, vb = b[field] as number;
      return this.sortDir === "desc" ? vb - va : va - vb;
    });
    this.requestUpdate();
  }

  private _timeClass(ms: number) {
    if (ms > 1000) return "time-high";
    if (ms > 100) return "time-mid";
    return "";
  }

  private _renderExplainNode(node: ExplainNode, depth: number = 0): ReturnType<typeof html> {
    const nodeType = node["Node Type"] || "Unknown";
    const table = node["Table Name"] || node["Index Name"] || "";
    const rows = node["Plan Rows"] || node["Actual Rows"];
    const cost = node["Total Cost"];

    let tagClass = "tag-info";
    if (nodeType === "Seq Scan" || nodeType === "ALL") tagClass = "tag-danger";
    else if (nodeType.includes("Sort") || nodeType === "Materialize") tagClass = "tag-warn";

    const children = node["Plans"] || [];

    return html`
      <div class="tree-node" style="margin-left: ${depth > 0 ? 0 : 0}px">
        <div class="tree-node-header" @click=${(e: Event) => {
          const el = (e.currentTarget as HTMLElement).nextElementSibling as HTMLElement;
          if (el) el.style.display = el.style.display === "none" ? "" : "none";
        }}>
          <span class="tag ${tagClass}">${nodeType}</span>
          ${table ? html`<span class="table-name">${table}</span>` : ""}
          ${cost !== undefined ? html`<span class="tree-node-meta">cost=${cost}</span>` : ""}
          ${rows !== undefined ? html`<span class="tree-node-meta">rows≈${rows}</span>` : ""}
        </div>
        ${children.length > 0 ? html`
          <div>${children.map(c => this._renderExplainNode(c, depth + 1))}</div>
        ` : ""}
      </div>
    `;
  }

  override render() {
    return html`
      <div class="qan-layout">
        <!-- QAN Fingerprint Table -->
        <div class="panel">
          <div class="panel-header">
            ${renderIcon('search')} 查询指纹分析 ${this.qanData.length ? `(${this.qanData.length})` : ""}
          </div>
          <div class="panel-body">
            ${this.loading ? html`<div class="loading">加载中...</div>` :
              this.qanData.length === 0 ? html`<div class="empty">暂无数据</div>` :
              html`
            <table>
              <thead>
                <tr>
                  <th style="width:40%;text-align:center">指纹</th>
                  <th @click=${() => this._sort("calls")}>调用次数 ${this.sortField === "calls" ? (this.sortDir === "desc" ? "↓" : "↑") : ""}</th>
                  <th @click=${() => this._sort("avg_time_ms")}>平均耗时 ${this.sortField === "avg_time_ms" ? (this.sortDir === "desc" ? "↓" : "↑") : ""}</th>
                  <th @click=${() => this._sort("total_time_ms")}>总耗时 ${this.sortField === "total_time_ms" ? (this.sortDir === "desc" ? "↓" : "↑") : ""}</th>
                  <th @click=${() => this._sort("rows_examined")}>行扫描 ${this.sortField === "rows_examined" ? (this.sortDir === "desc" ? "↓" : "↑") : ""}</th>
                </tr>
              </thead>
              <tbody>
                ${this.qanData.map(row => html`
                  <tr class="${this.selectedQuery === row ? 'selected' : ''}"
                      @click=${() => this._selectQuery(row)}>
                    <td style="text-align:center"><div class="fingerprint" title=${row.fingerprint}>${row.fingerprint.substring(0, 80)}</div></td>
                    <td>${row.calls.toLocaleString()}</td>
                    <td class="${this._timeClass(row.avg_time_ms)}">${row.avg_time_ms}ms</td>
                    <td class="${this._timeClass(row.total_time_ms)}">${row.total_time_ms}ms</td>
                    <td>${row.rows_examined.toLocaleString()}</td>
                  </tr>
                `)}
              </tbody>
            </table>
            `}
          </div>
        </div>

        <!-- EXPLAIN Tree -->
        <div class="panel">
          <div class="panel-header">
            ${renderIcon('bar-chart')} 执行计划 ${this.selectedQuery ? "— " + this.selectedQuery.fingerprint.substring(0, 40) + "..." : ""}
          </div>
          <div class="panel-body">
            ${this.explainLoading ? html`<div class="loading">加载执行计划...</div>` :
              !this.selectedQuery ? html`<div class="empty">点击左侧查询查看执行计划</div>` :
              !this.explainPlan ? html`<div class="empty">无法获取执行计划</div>` :
              Array.isArray(this.explainPlan.plan) ?
                this.explainPlan.plan.map((n: ExplainNode) => this._renderExplainNode(n, 0)) :
                this._renderExplainNode(this.explainPlan.plan, 0)
            }
          </div>
        </div>
      </div>
    `;
  }
}
