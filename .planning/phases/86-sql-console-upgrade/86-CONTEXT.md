# Phase 86: SQL Console Upgrade - Context

**Gathered:** 2026-05-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Upgrade the existing SQL console from a single-editor + basic read-only result table into a full-featured query workspace. Deliver multi-tab editing with localStorage persistence, sortable/paginated result table, client-side CSV export, searchable query history panel, and EXPLAIN plan visualization with tree/table toggle. All within the existing `sql-console-page` LitElement component — no new navigation or routing changes needed.

Requirements: SQLC-01 through SQLC-07.
</domain>

<decisions>
## Implementation Decisions

### Multi-tab Behavior
- **D-01:** All tabs share the same selected database instance. Each tab has independent editor content and result set. Switching instance changes it for all tabs.
- **D-02:** Tabs persist across page reloads via localStorage (tab list, active tab, instance selection, editor content). Result sets and history panel state reset on reload.
- **D-03:** Closing a tab with non-empty editor content shows a confirmation dialog ("You have unsaved SQL. Close anyway?").
- **D-04:** Soft cap of ~10 tabs with a warning when exceeded. Double-click tab name to rename inline. × button to close individual tabs.

### Result Table Interaction
- **D-05:** Column header click cycles sort state: ascending (▲) → descending (▼) → none. Only one column sorted at a time. Arrow indicator shown in the sorted column.
- **D-06:** Page size dropdown with presets: 25 / 50 / 100 / All. Default 50 rows per page. "All" renders the full result set.
- **D-07:** Sort state and pagination reset to defaults (unsorted, page 1) when re-executing a query.
- **D-08:** Header bar shows page range and total: "1–50 of 1,234 rows" with page navigation controls (prev/next/page number).

### Query History Design
- **D-09:** History panel lives in the left sidebar, toggling with the schema browser. A tab/toggle switches between "Schema" (object tree) and "History" (query list) views.
- **D-10:** Full-text search on SQL text plus an instance filter dropdown. Search matches against stored SQL. Instance filter scopes to a specific database.
- **D-11:** Clicking a history item loads its SQL into the currently active editor tab (replaces content).
- **D-12:** Show last 200 items, scroll-loaded (infinite scroll). No time-based expiry — the window is simply the most recent 200 executions.

### EXPLAIN Visualization
- **D-13:** Both tree view (default) and flat table view, toggled via a button. Tree shows the nested execution plan hierarchy. Table shows sortable columns (operation, rows, cost, etc.).
- **D-14:** EXPLAIN renders inline in the results area, replacing the data table. A "Back to results" link returns to the data view. An "EXPLAIN" button sits next to "Execute" in the toolbar.
- **D-15:** Clicking "EXPLAIN" immediately sends the current editor SQL to the explain endpoint — no confirmation or edit step.
- **D-16:** Summary bar above the plan visualization shows estimated total cost, rows examined, and a simple efficiency grade (e.g., "Index Scan — efficient" or "Full Table Scan — review indexes").

### Claude's Discretion
- Tab default naming (auto-generate from first SQL line or "Tab 1, Tab 2...")
- localStorage key structure for tab persistence
- Sort implementation details (in-memory array sort, type coercion for mixed data)
- CSV export implementation (client-side Blob download, filename format, CSV cell escaping)
- EXPLAIN tree component (recursive Lit template for nested JSON plan nodes)
- History API endpoint design (new endpoint or reused audit_log query)
- Efficiency grade heuristics for EXPLAIN summary bar
- Empty/loading/error state designs for all new components
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Planning
- `.planning/ROADMAP.md` — Phase 86 goal, success criteria, and SQLC-01 through SQLC-07 requirements
- `.planning/REQUIREMENTS.md` — SQLC-01 through SQLC-07 detailed requirement descriptions

### Existing Frontend — SQL Console
- `frontend/src/openclaw/ui/views/sql-console.ts` — Current SQL console (CodeMirror 6 editor, schema browser, result table, execute/format/approval flow). All new features extend this component.
- `frontend/src/openclaw/ui/navigation.ts` — Tab definitions (sql-console already registered at line 43, path /sql-console)
- `frontend/src/openclaw/ui/app-render.ts` — Route dispatch (sql-console rendered at line 1583, no changes needed)

### Existing Backend — SQL Execution
- `apps/db-ops-api/server.ts` lines 585–604 — `POST /api/database/instances/:id/execute` (requires `instance:query` permission + instance access)
- `apps/db-ops-api/server.ts` lines 747–766 — `GET /api/database/instances/:id/explain?sql=...` (requires `instance:query` permission + instance access, SELECT/WITH/SHOW/DESCRIBE only)
- `apps/db-ops-api/server.ts` lines 769–778 — `GET /api/database/instances/:id/schema-objects` (public, no permission check)
- `apps/db-ops-api/src/sql-executor.ts` — SqlExecutor class with audit logging (captures userId, sqlText, durationMs, rowCount, status per execution)
- `apps/db-ops-api/src/database-service.ts` lines 1977–2007 — `getExplainPlanJson()` method (MySQL FORMAT=JSON + PostgreSQL EXPLAIN JSON)

### Frontend Patterns Reference
- `frontend/src/openclaw/ui/views/llm-config.ts` — CRUD table + modal pattern reference
- `frontend/src/openclaw/ui/views/users-management.ts` — Multi-role badge pattern
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **CodeMirror 6** (`sql-console.ts` lines 3–8): Already imported and configured with `basicSetup`, `sql({ dialect: MySQL })`, `oneDark`, `autocompletion`. Multi-tab will create multiple EditorView instances.
- **Schema browser tree** (`sql-console.ts` lines 296–321): Recursive Lit template for schema → table → column tree with expand/collapse. Reusable as-is.
- **CSS variable system**: `--card`, `--border`, `--bg-elevated`, `--accent`, `--muted`, `--text`, `--accent-subtle`, `--bg-hover`, `--warn`, `--warn-subtle`, `--destructive`, `--danger-subtle` already defined and used throughout the existing console.
- **Result table** (`sql-console.ts` lines 338–350): Existing HTML table with sticky headers, null handling, text truncation. Needs sort + pagination + CSV additions.

### Established Patterns
- `@customElement("sql-console-page")` + `LitElement` + `@state()` decorators
- `static override styles = css\`...\`` component-scoped styles
- `fetch()` + `localStorage.getItem("token")` for API calls
- `_headers()` helper returning `{ Authorization: Bearer <token> }`
- `EditorView` + `EditorState.create({...})` for CodeMirror instantiation
- `requestUpdate()` after external state changes

### Integration Points
- **Navigation**: `sql-console` tab already in TAB_GROUPS slide group and Tab union type — no changes needed
- **Route dispatch**: `app-render.ts` line 1583 already renders `<sql-console-page>` for `state.tab === "sql-console"` — no changes needed
- **Backend**: Execute and EXPLAIN endpoints already exist with RBAC middleware. History needs a new endpoint (or reuse of audit_log data).
- **Permission**: Endpoints already guarded by `requirePermission('instance:query')` + `requireInstanceAccess()`. Frontend does not need permission logic — 403 errors are handled generically.

### Creative Options
- CodeMirror `EditorView` supports multiple instances on one page — multi-tab just creates/destroys EditorViews per tab
- Audit log already records SQL history — a new API endpoint joining `audit_log` with instance name would serve the history panel
- CSV export is purely client-side: `new Blob([csvString])` + `URL.createObjectURL()` + download link
- EXPLAIN JSON from MySQL and PostgreSQL have different shapes — the visualization component needs a normalizer layer
</code_context>

<specifics>
## Specific Ideas

No specific references or "I want it like X" moments — open to standard approaches for all implementation details.
</specifics>

<deferred>
## Deferred Ideas

### Reviewed Todos (not folded)
- **自动 AI 分析结果在告警列表中不可见** — AI/alert area, not relevant to SQL Console scope. Belongs in alert/notification phase.

None — discussion stayed within phase scope.
</deferred>

---
*Phase: 86-sql-console-upgrade*
*Context gathered: 2026-05-10*
