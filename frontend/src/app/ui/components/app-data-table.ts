/**
 * Shared data table component with sortable columns, skeleton loading, and empty state.
 * Usage: <app-data-table
 *          .columns=${[{key:'name',label:'Name',sortable:true}]}
 *          .rows=${data}
 *          ?loading=${loading}
 *        ></app-data-table>
 *
 * Emits 'app-table-sort' CustomEvent when sortable column header is clicked.
 */
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

export interface Column {
  key: string;
  label: string;
  sortable?: boolean;
  width?: string;
}

@customElement("app-data-table")
export class AppDataTable extends LitElement {
  @property({ type: Array }) columns: Column[] = [];
  @property({ type: Array }) rows: Record<string, unknown>[] = [];
  @property({ type: Boolean }) loading = false;
  @property({ type: String }) emptyMessage = "暂无数据";
  @property({ type: Boolean }) striped = true;
  @property({ type: Boolean }) dense = false;

  private _sortKey = "";
  private _sortDir: "asc" | "desc" = "asc";

  createRenderRoot() { return this; }

  private _handleSort(key: string) {
    if (this._sortKey === key) {
      this._sortDir = this._sortDir === "asc" ? "desc" : "asc";
    } else {
      this._sortKey = key;
      this._sortDir = "asc";
    }
    this.dispatchEvent(
      new CustomEvent("app-table-sort", {
        detail: { key, direction: this._sortDir },
        bubbles: true,
        composed: true,
      }),
    );
    this.requestUpdate();
  }

  private _renderSkeletonRows() {
    const rows = [];
    const widths = ["40%", "65%", "85%", "50%", "75%"];
    for (let i = 0; i < 5; i++) {
      rows.push(html`
        <tr>
          ${this.columns.map(
            (col, ci) => html`
              <td>
                <div
                  class="skeleton skeleton-line"
                  style="width: ${col.width ?? widths[ci % widths.length]}"
                ></div>
              </td>
            `,
          )}
        </tr>
      `);
    }
    return rows;
  }

  render() {
    return html`
      <style>
        app-data-table { display: block; }
        .data-table {
          width: 100%;
          border-collapse: collapse;
        }
        .data-table th {
          font-size: var(--text-sm);
          font-weight: 600;
          text-align: left;
          padding: var(--space-md);
          border-bottom: 2px solid var(--border);
          color: var(--muted-strong);
          user-select: none;
        }
        .data-table th.sortable {
          cursor: pointer;
        }
        .data-table th.sortable:hover {
          color: var(--accent);
        }
        .data-table th .sort-indicator {
          display: inline-block;
          margin-left: 4px;
          font-size: 10px;
        }
        .data-table td {
          font-size: var(--text-sm);
          padding: var(--space-md);
          border-bottom: 1px solid var(--border);
        }
        .data-table.striped tbody tr:nth-child(even) {
          background: var(--bg-muted);
        }
        .data-table tbody tr:hover {
          background: var(--bg-hover);
        }
        .data-table.dense th,
        .data-table.dense td {
          padding: var(--space-sm);
        }
        .data-table .skeleton {
          margin: 3px 0;
        }
        .data-table-empty {
          text-align: center;
          padding: var(--space-xl);
        }
      </style>
      <table
        class="data-table${this.striped ? " striped" : ""}${this.dense ? " dense" : ""}"
      >
        <thead>
          <tr>
            ${this.columns.map(
              (col) => html`
                <th
                  class=${col.sortable ? "sortable" : ""}
                  style=${col.width ? `width: ${col.width}` : ""}
                  @click=${col.sortable ? () => this._handleSort(col.key) : undefined}
                  role=${col.sortable ? "columnheader button" : "columnheader"}
                  tabindex=${col.sortable ? "0" : undefined}
                  aria-sort=${this._sortKey === col.key
                    ? this._sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"}
                >
                  ${col.label}
                  ${col.sortable && this._sortKey === col.key
                    ? html`<span class="sort-indicator"
                        >${this._sortDir === "asc" ? "▲" : "▼"}</span
                      >`
                    : ""}
                </th>
              `,
            )}
          </tr>
        </thead>
        <tbody>
          ${this.loading
            ? this._renderSkeletonRows()
            : this.rows.length === 0
              ? html`
                  <tr>
                    <td colspan="${this.columns.length}" class="data-table-empty">
                      <app-empty-state title="${this.emptyMessage}"></app-empty-state>
                    </td>
                  </tr>
                `
              : this.rows.map(
                  (row) => html`
                    <tr>
                      ${this.columns.map(
                        (col) => html`<td>${(row as Record<string, unknown>)[col.key] ?? ""}</td>`,
                      )}
                    </tr>
                  `,
                )}
        </tbody>
      </table>
    `;
  }
}
