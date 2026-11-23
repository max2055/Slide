import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../../../icons.js";
import { pathForTab } from "../navigation.ts";
import { formatSessionTokens } from "../presenter.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../string-coerce.ts";
import type {
  GatewaySessionRow,
  SessionsListResult,
} from "../types.ts";

export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  showArchived?: boolean;
  basePath: string;
  searchQuery: string;
  sortColumn: "key" | "kind" | "updated" | "tokens";
  sortDir: "asc" | "desc";
  page: number;
  pageSize: number;
  selectedKeys?: Set<string>;
  expandedCheckpointKey?: string | null;
  checkpointItemsByKey?: Record<string, unknown[]>;
  checkpointLoadingKey?: string | null;
  checkpointBusyKey?: string | null;
  checkpointErrorByKey?: Record<string, string>;
  onFiltersChange: (next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
  }) => void;
  onSearchChange: (query: string) => void;
  onSortChange: (column: "key" | "kind" | "updated" | "tokens", dir: "asc" | "desc") => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onRefresh: () => void;
  onNavigateToChat?: (sessionKey: string) => void;
  onPatch?: (sessionKey: string, patch: Record<string, unknown>) => void;
  onToggleSelect?: (key: string) => void;
  onSelectPage?: (keys: Iterable<string>) => void;
  onDeselectPage?: (keys: Iterable<string>) => void;
  onDeselectAll?: () => void;
  onDeleteSelected?: () => void;
  onToggleCheckpointDetails?: (key: string) => void;
  onBranchFromCheckpoint?: (key: string) => void;
  onRestoreCheckpoint?: (key: string) => void;
};

const PAGE_SIZES = [10, 25, 50, 100] as const;

function filterRows(rows: GatewaySessionRow[], query: string): GatewaySessionRow[] {
  const q = normalizeLowercaseStringOrEmpty(query);
  if (!q) {
    return rows;
  }
  return rows.filter((row) => {
    const key = normalizeLowercaseStringOrEmpty(row.key);
    const label = normalizeLowercaseStringOrEmpty(row.label);
    const kind = normalizeLowercaseStringOrEmpty(row.kind);
    const displayName = normalizeLowercaseStringOrEmpty(row.displayName);
    return key.includes(q) || label.includes(q) || kind.includes(q) || displayName.includes(q);
  });
}

function sortRows(
  rows: GatewaySessionRow[],
  column: "key" | "kind" | "updated" | "tokens",
  dir: "asc" | "desc",
): GatewaySessionRow[] {
  const cmp = dir === "asc" ? 1 : -1;
  return [...rows].toSorted((a, b) => {
    let diff = 0;
    switch (column) {
      case "key":
        diff = (a.key ?? "").localeCompare(b.key ?? "");
        break;
      case "kind":
        diff = (a.kind ?? "").localeCompare(b.kind ?? "");
        break;
      case "updated": {
        const au = a.updatedAt ?? 0;
        const bu = b.updatedAt ?? 0;
        diff = au - bu;
        break;
      }
      case "tokens": {
        const at = a.totalTokens ?? a.inputTokens ?? a.outputTokens ?? 0;
        const bt = b.totalTokens ?? b.inputTokens ?? b.outputTokens ?? 0;
        diff = at - bt;
        break;
      }
    }
    return diff * cmp;
  });
}

function paginateRows<T>(rows: T[], page: number, pageSize: number): T[] {
  const start = page * pageSize;
  return rows.slice(start, start + pageSize);
}

export function renderSessions(props: SessionsProps) {
  const rawRows = props.result?.sessions ?? [];
  const filtered = filterRows(rawRows, props.searchQuery);
  const sorted = sortRows(filtered, props.sortColumn, props.sortDir);
  const totalRows = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / props.pageSize));
  const page = Math.min(props.page, totalPages - 1);
  const paginated = paginateRows(sorted, page, props.pageSize);

  const sortHeader = (
    col: "key" | "kind" | "updated" | "tokens",
    label: string,
    extraClass = "",
    extraStyle = "",
  ) => {
    const isActive = props.sortColumn === col;
    const nextDir = isActive && props.sortDir === "asc" ? ("desc" as const) : ("asc" as const);
    return html`
      <th
        class=${extraClass}
        style=${extraStyle || nothing}
        data-sortable
        data-sort-dir=${isActive ? props.sortDir : ""}
        @click=${() => props.onSortChange(col, isActive ? nextDir : "desc")}
      >
        ${label}
        <span class="data-table-sort-icon">${icons['arrow-up-down']}</span>
      </th>
    `;
  };

  return html`
    <section class="card" aria-label="会话" aria-busy=${props.loading}>
      <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
        <div>
          <div class="card-title">会话</div>
          <div class="card-sub">
            查看当前账号可访问的会话。
          </div>
        </div>
        <button aria-busy=${String(props.loading)} class="btn btn-refresh" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>

      <div class="filters" style="margin-bottom: 12px;">
        <label class="field-inline">
          <span>Active</span>
          <input
            style="width: 72px;"
            placeholder="min"
            .value=${props.activeMinutes}
            @input=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: (e.target as HTMLInputElement).value,
                limit: props.limit,
                includeGlobal: props.includeGlobal,
                includeUnknown: props.includeUnknown,
              })}
          />
        </label>
        <label class="field-inline">
          <span>Limit</span>
          <input
            style="width: 64px;"
            .value=${props.limit}
            @input=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: props.activeMinutes,
                limit: (e.target as HTMLInputElement).value,
                includeGlobal: props.includeGlobal,
                includeUnknown: props.includeUnknown,
              })}
          />
        </label>
        <label class="field-inline checkbox">
          <input
            type="checkbox"
            .checked=${props.includeGlobal}
            @change=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: props.activeMinutes,
                limit: props.limit,
                includeGlobal: (e.target as HTMLInputElement).checked,
                includeUnknown: props.includeUnknown,
              })}
          />
          <span>Global</span>
        </label>
        <label class="field-inline checkbox">
          <input
            type="checkbox"
            .checked=${props.includeUnknown}
            @change=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: props.activeMinutes,
                limit: props.limit,
                includeGlobal: props.includeGlobal,
                includeUnknown: (e.target as HTMLInputElement).checked,
              })}
          />
          <span>Unknown</span>
        </label>
      </div>

      ${props.error
        ? html`<div class="callout danger" role="alert" style="margin-bottom: 12px;">${props.error}</div>`
        : nothing}

      <div class="data-table-wrapper">
        <div class="data-table-toolbar">
          <div class="data-table-search">
            <input
              type="text"
              aria-label="筛选会话"
              placeholder="按标识、名称或类型筛选"
              .value=${props.searchQuery}
              @input=${(e: Event) => props.onSearchChange((e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                ${sortHeader("key", "Key", "data-table-key-col", "text-align:center")}
                ${sortHeader("kind", "Kind", "", "text-align:center")}
                ${sortHeader("updated", "Updated")}
                ${sortHeader("tokens", "Tokens", "", "text-align:center")}
                <th>Compaction</th>
              </tr>
            </thead>
            <tbody>
              ${props.error
                ? nothing
                : props.loading || paginated.length === 0
                ? html`
                    <tr>
                      <td
                        colspan="5"
                        style="text-align: center; padding: 48px 16px; color: var(--muted)"
                      >
                        ${props.loading ? "正在读取会话…" : !props.result
                          ? "尚未读取会话，请刷新。"
                          : props.searchQuery.trim() || props.result.queriedActiveMinutes
                            ? "没有符合筛选条件的会话。"
                            : "暂无会话。"}
                      </td>
                    </tr>
                  `
                : paginated.map((row) => renderRows(row, props))}
            </tbody>
          </table>
        </div>

        ${!props.error && !props.loading && totalRows > 0
          ? html`
              <div class="data-table-pagination">
                <div class="data-table-pagination__info">
                  ${page * props.pageSize + 1}-${Math.min((page + 1) * props.pageSize, totalRows)}
                  of ${totalRows} row${totalRows === 1 ? "" : "s"}
                </div>
                <div class="data-table-pagination__controls">
                  <select
                    style="height: 32px; padding: 0 8px; font-size: 13px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card);"
                    .value=${String(props.pageSize)}
                    @change=${(e: Event) =>
                      props.onPageSizeChange(Number((e.target as HTMLSelectElement).value))}
                  >
                    ${PAGE_SIZES.map((s) => html`<option value=${s}>${s} per page</option>`)}
                  </select>
                  <button ?disabled=${page <= 0} @click=${() => props.onPageChange(page - 1)}>
                    Previous
                  </button>
                  <button
                    ?disabled=${page >= totalPages - 1}
                    @click=${() => props.onPageChange(page + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            `
          : nothing}
      </div>
    </section>
  `;
}

function renderRows(row: GatewaySessionRow, props: SessionsProps) {
  const updated = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : t("common.na");
  const latestCheckpoint = row.latestCompactionCheckpoint;
  const checkpointCount = row.compactionCheckpointCount ?? 0;
  const displayName = normalizeOptionalString(row.displayName) ?? null;
  const trimmedLabel = normalizeOptionalString(row.label) ?? "";
  const showDisplayName = Boolean(
    displayName && displayName !== row.key && displayName !== trimmedLabel,
  );
  const canLink = row.kind !== "global";
  const chatUrl = canLink
    ? `${pathForTab("chat", props.basePath)}?session=${encodeURIComponent(row.key)}`
    : null;
  const badgeClass =
    row.kind === "direct"
      ? "data-table-badge--direct"
      : row.kind === "group"
        ? "data-table-badge--group"
        : row.kind === "global"
          ? "data-table-badge--global"
          : "data-table-badge--unknown";

  return html`
    <tr>
      <td class="data-table-key-col">
        <div class="mono session-key-cell">
          ${canLink
            ? html`<a
                href=${chatUrl}
                class="session-link"
                @click=${(e: MouseEvent) => {
                  if (
                    e.defaultPrevented ||
                    e.button !== 0 ||
                    e.metaKey ||
                    e.ctrlKey ||
                    e.shiftKey ||
                    e.altKey
                  ) {
                    return;
                  }
                  if (props.onNavigateToChat) {
                    e.preventDefault();
                    props.onNavigateToChat(row.key);
                  }
                }}
                >${row.key}</a
              >`
            : row.key}
          ${showDisplayName
            ? html`<span class="muted session-key-display-name">${displayName}</span>`
            : nothing}
        </div>
      </td>
      <td style="text-align:center">
        <span class="data-table-badge ${badgeClass}">${row.kind}</span>
      </td>
      <td>${updated}</td>
      <td style="text-align:center">${formatSessionTokens(row)}</td>
      <td>
        <div style="display: grid; gap: 6px;">
          <span class="muted" style="font-size: 12px;">
            ${checkpointCount > 0
              ? `${checkpointCount} checkpoint${checkpointCount === 1 ? "" : "s"}`
              : "none"}
          </span>
          ${latestCheckpoint
            ? html`
                <span style="font-size: 12px;">
                  ${latestCheckpoint.reason} · ${formatRelativeTimestamp(latestCheckpoint.createdAt)}
                </span>
              `
            : nothing}
        </div>
      </td>
    </tr>`;
}
