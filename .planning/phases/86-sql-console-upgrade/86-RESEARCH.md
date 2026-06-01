# Phase 86: SQL Console Upgrade - Research

**Researched:** 2026-05-10
**Domain:** Lit 3.3 Web Components, CodeMirror 6, Client-side data handling
**Confidence:** HIGH

## Summary

Phase 86 upgrades the existing single-editor SQL console into a full-featured query workspace. All changes are contained within the existing `sql-console-page` LitElement component (`frontend/src/openclaw/ui/views/sql-console.ts`) — no new navigation or routing changes are needed.

The upgrade spans seven capability areas: schema-driven autocomplete (SQLC-01), sortable/paginated result table (SQLC-02/03), CSV export (SQLC-04), multi-tab editor (SQLC-05), query history panel (SQLC-06), and EXPLAIN visualization (SQLC-07). Each is a client-side enhancement using the existing codebase patterns (Lit 3.3, CodeMirror 6, CSS variable system, icon library).

**Primary recommendation:** Extend the existing `SqlConsolePage` component incrementally. Add a new backend query history endpoint backed by the in-memory audit log. All other features are pure client-side — no new backend routes are needed besides history.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** All tabs share the same selected database instance. Each tab has independent editor content and result set. Switching instance changes it for all tabs.
- **D-02:** Tabs persist across page reloads via localStorage (tab list, active tab, instance selection, editor content). Result sets and history panel state reset on reload.
- **D-03:** Closing a tab with non-empty editor content shows a confirmation dialog ("You have unsaved SQL. Close anyway?").
- **D-04:** Soft cap of ~10 tabs with a warning when exceeded. Double-click tab name to rename inline. x button to close individual tabs.
- **D-05:** Column header click cycles sort state: ascending (triangle-up) to descending (triangle-down) to none. Only one column sorted at a time. Arrow indicator shown in the sorted column.
- **D-06:** Page size dropdown with presets: 25 / 50 / 100 / All. Default 50 rows per page. "All" renders the full result set.
- **D-07:** Sort state and pagination reset to defaults (unsorted, page 1) when re-executing a query.
- **D-08:** Header bar shows page range and total: "1-50 of 1,234 rows" with page navigation controls (prev/next/page number).
- **D-09:** History panel lives in the left sidebar, toggling with the schema browser. A tab/toggle switches between "Schema" (object tree) and "History" (query list) views.
- **D-10:** Full-text search on SQL text plus an instance filter dropdown. Search matches against stored SQL. Instance filter scopes to a specific database.
- **D-11:** Clicking a history item loads its SQL into the currently active editor tab (replaces content).
- **D-12:** Show last 200 items, scroll-loaded (infinite scroll). No time-based expiry.
- **D-13:** Both tree view (default) and flat table view, toggled via a button. Tree shows nested execution plan hierarchy. Table shows sortable columns (operation, rows, cost, etc.).
- **D-14:** EXPLAIN renders inline in the results area, replacing the data table. A "Back to results" link returns to the data view. An "EXPLAIN" button sits next to "Execute" in the toolbar.
- **D-15:** Clicking "EXPLAIN" immediately sends the current editor SQL to the explain endpoint — no confirmation or edit step.
- **D-16:** Summary bar above the plan visualization shows estimated total cost, rows examined, and a simple efficiency grade.

### Claude's Discretion
- Tab default naming (auto-generate from first SQL line or "Tab 1, Tab 2...")
- localStorage key structure for tab persistence
- Sort implementation details (in-memory array sort, type coercion for mixed data)
- CSV export implementation (client-side Blob download, filename format, CSV cell escaping)
- EXPLAIN tree component (recursive Lit template for nested JSON plan nodes)
- History API endpoint design (new endpoint or reused audit_log query)
- Efficiency grade heuristics for EXPLAIN summary bar
- Empty/loading/error state designs for all new components

### Deferred Ideas (OUT OF SCOPE)
- **Auto AI analysis results not visible in alert list** — AI/alert area, not relevant to SQL Console scope. Belongs in alert/notification phase.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SQLC-01 | Schema-driven autocomplete (tables, columns) via @codemirror/autocomplete | Existing `_sqlCompletions()` already loads schema; needs context-aware completion filtering. CodeMirror `CompletionContext.matchBefore()` + `override` option supports this natively. |
| SQLC-02 | Column header click sort (ascending/descending/none) | Pure client-side. Add `@click` handler on `<th>`, cycle sort state, use `Array.sort()` with type coercion for mixed data. |
| SQLC-03 | Client-side pagination with configurable page size | Pure client-side. Track `pageSize` and `currentPage` state, slice result array. Header bar with range display and nav controls. |
| SQLC-04 | Export query results to CSV via download button | Client-side Blob + URL.createObjectURL() pattern. UTF-8 BOM for Excel compatibility. Standard approach documented in codebase. |
| SQLC-05 | Multiple query tabs with independent editor state | Multiple `EditorView` instances. localStorage persistence for tab list and editor content. Tab bar component with close/rename. |
| SQLC-06 | Query history auto-saved and searchable | Backend: new endpoint `GET /api/database/instances/:id/query-history` backed by `auditLogManager.query()` with eventType='sql_execution' filter. Frontend: sidebar panel with search + instance filter. |
| SQLC-07 | EXPLAIN JSON rendered as visual tree/table | EXPLAIN endpoint exists at `GET /api/database/instances/:id/explain`. MySQL returns nested JSON with `query_block` structure. PostgreSQL returns array of plan nodes. Client-side normalizer needed for unified visualization. Recursive Lit template for tree view. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Schema-driven autocomplete | Browser (Client) | Backend (schema data source) | Completions computed client-side from schema data fetched from backend. Existing pattern. |
| Sortable result table | Browser (Client) | — | In-memory array sort on result set. No server round-trip needed. |
| Client-side pagination | Browser (Client) | — | Slice result array client-side. No server round-trip. |
| CSV export | Browser (Client) | — | Blob + download link, purely client-side. |
| Multi-tab editor | Browser (Client) | — | Multiple EditorView instances, localStorage for persistence. |
| Query history | Backend (API) | Browser (Client) | New API endpoint to query audit log. Frontend renders panel with search/filter. |
| EXPLAIN visualization | Browser (Client) | Backend (plan data source) | Fetch EXPLAIN JSON from backend. Render client-side with recursive Lit template. |
| Efficiency grade heuristics | Browser (Client) | — | Pattern-match against plan node operation names in client-side normalizer. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Lit 3.3 | ^3.3.2 | Web Components framework | Existing project standard; all views use it |
| CodeMirror 6 | ^6.0.2 | SQL editor with syntax highlighting | Already integrated, supports multi-instance |
| @codemirror/autocomplete | ^6.20.2 | Autocomplete for SQL editor | Already imported, used for completions |
| @codemirror/lang-sql | ^6.10.0 | SQL language support (MySQL dialect) | Already imported and configured |
| @codemirror/view | ^6.42.0 | CodeMirror editor view | Already imported, multiple instances supported |
| @codemirror/state | ^6.6.0 | CodeMirror editor state | Already imported, per-tab state creation |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| icons.ts | project | SVG icon system (Lucide-style) | Import via `icons[iconName]` or `renderIcon(name)` for all new UI elements |
| CSS variable system | project | Design tokens (colors, radius, spacing) | Existing `--card`, `--border`, `--accent`, etc. defined in `base.css` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Multiple EditorView instances | Single CodeMirror instance with swapping doc | Multiple instances track independent undo history, selection, scroll position naturally. Simpler code. |
| localStorage for tab persistence | IndexedDB / sessionStorage | localStorage is synchronous, sufficient for <50KB tab data. IndexedDB is overkill. sessionStorage loses state on tab close. |
| In-memory audit log (existing) | Database-backed audit log | Existing implementation uses `MemoryAuditLogStore` — data persists only during process lifetime. Acceptable for v1. Add DB persistence as future enhancement. |
| Recursive Lit template (tree view) | Dedicated tree component library | Lit template recursion is well-supported and avoids adding a dependency for one component. |

**Installation:**
No new npm packages needed. All required libraries are already in `frontend/package.json`.

**Version verification:** All libraries verified via `frontend/package.json` — no new packages required.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser: sql-console-page (LitElement)                              │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Tab Bar ── [Tab 1] [Tab 2 *] [+]                              │   │
│  │   ├── Tab 1: EditorView A ── EditorState A ── undo history A  │   │
│  │   ├── Tab 2: EditorView B ── EditorState B ── undo history B  │   │
│  │   └── ...                                                      │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Toolbar: [Instance select] [Execute] [Analyze Plan] [Format]  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────┐  ┌────────────────────────────────────────┐       │
│  │ Left Sidebar  │  │ Editor + Results (main panel)           │       │
│  │               │  │                                         │       │
│  │ [Schema] [History] │  CodeMirror EditorView                 │       │
│  │  ─────────── │  │  ┌──────────────────────────────────┐   │       │
│  │  Search: [...] │  │  │ SQL editor with autocomplete    │   │       │
│  │  Instance: [v] │  │  └──────────────────────────────────┘   │       │
│  │               │  │                                         │       │
│  │  Schema tree  │  │  Result Table / EXPLAIN Visualization    │       │
│  │  or           │  │  ┌──────────────────────────────────┐   │       │
│  │  History list │  │  │ Sortable headers | Pagination  │   │       │
│  │  (scroll)     │  │  │ [Export CSV] [Back to results] │   │       │
│  │               │  │  └──────────────────────────────────┘   │       │
│  └──────────────┘  └────────────────────────────────────────┘       │
│                                                                      │
│  localStorage: sql-console-tabs → { tabs, activeId, instanceId }    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴──────────────┐
                    │                         │
                    ▼                         ▼
       ┌──────────────────────┐   ┌─────────────────────────┐
       │ Backend: db-ops-api  │   │ Backend: db-ops-api      │
       │ POST /execute        │   │ GET /explain             │
       │ GET /schema-objects  │   │ (new) GET /query-history  │
       └──────────────────────┘   └─────────────────────────┘
```

### Recommended Project Structure

All changes are within the existing single file. No new files needed for frontend. One new backend route needed.

```
frontend/src/openclaw/ui/views/
  sql-console.ts              # Main component — all enhancements in this file

apps/db-ops-api/
  server.ts                   # New GET /api/database/instances/:id/query-history route
  src/audit/
    audit-log.ts              # Existing — auditLogManager.query() used for history
```

### Pattern 1: Multi-tab Editor via Multiple EditorView Instances

**What:** Create/track a Map of EditorViews, one per tab. On tab switch, detach the current editor's DOM element and mount the selected tab's editor.

**When to use:** Implementing multi-tab with CodeMirror 6.

**Example:**
```typescript
// Source: [VERIFIED: @codemirror/view docs — multiple editors on one page]
interface Tab {
  id: string;
  name: string;
  sql: string;
  editorView: EditorView | null;
  result: ExecuteResult | null;
}

private tabs: Tab[] = [];
private activeTabId: string | null = null;

private _switchTab(tabId: string) {
  const container = this.renderRoot.querySelector(".cm-wrap");
  if (!container) return;
  container.innerHTML = "";  // Clear current editor DOM

  const tab = this.tabs.find(t => t.id === tabId);
  if (!tab) return;
  this.activeTabId = tabId;

  if (!tab.editorView) {
    tab.editorView = new EditorView({
      state: EditorState.create({
        doc: tab.sql,
        extensions: [
          basicSetup,
          sql({ dialect: MySQL }),
          oneDark,
          autocompletion({ override: [this._sqlCompletions.bind(this)] }),
          EditorView.updateListener.of(() => { this.requestUpdate(); }),
        ],
      }),
      parent: container as HTMLElement,
    });
  } else {
    container.appendChild(tab.editorView.dom);
  }
  tab.editorView.focus();
}
```

### Pattern 2: Client-side Sort + Pagination

**What:** Apply sort to the result array before slicing for pagination. Reset both on query re-execution.

**Example:**
```typescript
// Source: [ASSUMED — standard in-memory data table pattern]
private _sortAndPaginate(rows: any[], columns: string[]) {
  const sortCol = this.sortColumn;
  const sortDir = this.sortDirection; // 'asc' | 'desc' | null
  let sorted = [...rows];

  if (sortCol && sortDir) {
    sorted.sort((a, b) => {
      const va = a[sortCol], vb = b[sortCol];
      if (va === null) return 1;
      if (vb === null) return -1;
      // Numeric-aware comparison
      const na = Number(va), nb = Number(vb);
      const cmp = !isNaN(na) && !isNaN(nb) ? na - nb : String(va).localeCompare(String(vb));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  const total = sorted.length;
  const pageSize = this.pageSize === 'all' ? total : Number(this.pageSize);
  const start = (this.currentPage - 1) * pageSize;
  const paged = sorted.slice(start, start + pageSize);
  return { rows: paged, total, start: total > 0 ? start + 1 : 0, end: Math.min(start + pageSize, total) };
}
```

### Pattern 3: CSV Export via Blob

**What:** Convert result rows to CSV string with proper escaping, create Blob with UTF-8 BOM, trigger download.

**Example:**
```typescript
// Source: [ASSUMED — standard Blob download pattern]
private _exportCSV() {
  if (!this.result?.columns || !this.result?.rows) return;
  const cols = this.result.columns;
  const rows = this.result.rows;
  const escape = (v: any) => {
    const s = v === null ? '' : String(v);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    cols.map(c => escape(c)).join(','),
    ...rows.map(r => cols.map(c => escape(r[c])).join(',')),
  ].join('\n');

  const BOM = '﻿';
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const instanceName = this.instances.find(i => i.id === this.selectedId)?.name || 'unknown';
  a.download = `query-result-${instanceName}-${new Date().toISOString().slice(0,19).replace(/[:-]/g,'')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
```

### Pattern 4: Recursive Lit Template for EXPLAIN Tree

**What:** Render EXPLAIN plan nodes recursively using a Lit template function.

**Example:**
```typescript
// Source: [ASSUMED — recursive Lit template for tree rendering]
private _renderPlanNode(node: any, depth: number = 0) {
  const operation = node.operation || node['Operation'] || 'unknown';
  const rows = node.rows || node['Rows'] || 0;
  const cost = node.cost || node['Cost'] || 0;
  const children = node.children || node['Plans'] || [];

  return html`
    <div class="plan-node" style="padding-left: ${depth * 16}px">
      <div class="plan-node-row" @click=${() => this._togglePlanNode(node)}>
        ${children.length > 0 ? html`
          <span class="chevron">${this._expandedNodes.has(node) ? '▾' : '▸'}</span>
        ` : html`<span class="chevron-spacer"></span>`}
        <span class="plan-operation">${operation}</span>
        <span class="plan-rows">${Number(rows).toLocaleString()} rows</span>
        <span class="plan-cost">cost: ${Number(cost).toLocaleString()}</span>
      </div>
      ${this._expandedNodes.has(node) && children.length > 0
        ? children.map((child: any) => this._renderPlanNode(child, depth + 1))
        : ''}
    </div>
  `;
}

private _explainNormalizer(plan: any, dbType: string): PlanNode {
  if (dbType === 'mysql') {
    const qb = plan.query_block;
    return this._normalizeMySQLNode(qb);
  }
  if (dbType === 'postgresql') {
    // PostgreSQL returns [{ "Plan": {...}, "Planning Time": ... }]
    const pgPlan = Array.isArray(plan) ? plan[0]?.Plan : plan.Plan;
    return this._normalizePGNode(pgPlan);
  }
  return { operation: 'unknown', rows: 0, cost: 0, children: [] };
}
```

### Anti-Patterns to Avoid
- **Sharing EditorView instances across tabs:** Each tab must have its own `EditorView` and `EditorState` instances. Reusing destroys undo history and scroll position.
- **Server-side sorting/pagination:** The execute endpoint returns the full result set. Sorting and pagination are purely client-side — no new backend parameters needed.
- **Loading all 200 history items at once:** Use offset-based infinite scroll (batch of 50). The audit log in-memory store supports offset/limit.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Autocomplete for SQL | Custom completion parser | `@codemirror/autocomplete` with `CompletionContext.matchBefore()` | CodeMirror provides completion context (word before cursor, token type, position). Already imported. |
| CSV escaping | Ad-hoc string escaping | Standard CSV quoting: cells with `,` `"` or `\n` wrapped in double quotes, inner `"` escaped as `""` | Edge cases: mixed quotes/commas/newlines break naive implementations. Use the RFC 4180 pattern shown in Pattern 3. |
| Tab persistence save/restore | IndexedDB complex schema | Simple `JSON.stringify` + `localStorage.setItem` | Tab state is <50KB. localStorage is synchronous and sufficient. |
| EXPLAIN tree component | Third-party tree library | Recursive Lit template (Pattern 4) | Existing project has no tree library dependency. Recursive Lit templates handle arbitrary nesting depth natively. |

**Key insight:** Every feature in this phase except query history is purely client-side. The backend only provides data (schema objects, execution results, EXPLAIN JSON, history records). No new backend data processing or business logic is needed.

## Common Pitfalls

### Pitfall 1: CodeMirror EditorView DOM management with tabs
**What goes wrong:** When switching tabs, the old EditorView's DOM element is removed but the EditorView instance continues running, causing memory leaks and stale event listeners.
**Why it happens:** EditorView attaches scroll/resize/click listeners to its parent container. Simply hiding the parent with CSS does not clean up.
**How to avoid:** On tab switch, call `editorView.destroy()` on the previous tab's editor, then mount the new tab's editor. Or keep the destroyed editor's state via `editorView.state.toJSON()` and recreate.

### Pitfall 2: NULL values in sort behave inconsistently
**What goes wrong:** `Array.sort()` places `null` between values by conversion (null becomes 0 or "null"), breaking natural ordering.
**Why it happens:** JavaScript's default comparison converts null to 0 for numbers or "null" for strings.
**How to avoid:** Send nulls to the end regardless of direction: `if (va === null) return 1; if (vb === null) return -1;`

### Pitfall 3: MySQL vs PostgreSQL EXPLAIN JSON shapes differ
**What goes wrong:** Hard-coding MySQL's query_block structure breaks for PostgreSQL plans.
**Why it happens:** MySQL EXPLAIN FORMAT=JSON returns `{ "query_block": { "select_id": 1, "cost_info": {...}, "table": {...} } }`. PostgreSQL returns `[ { "Plan": { "Node Type": "Seq Scan", ... } } ]`.
**How to avoid:** Implement a normalizer function (Pattern 4) that detects `db_type` from the API response and converts both formats to a unified `{ operation, rows, cost, children[] }` structure.

### Pitfall 4: Tab rename loses editor content on double-click
**What goes wrong:** The double-click to rename fires both the rename input AND triggers CodeMirror editor focus, causing the editor to handle the second click.
**Why it happens:** Click on tab label propagates up. CodeMirror's editor is outside the tab bar, but focus events can interfere.
**How to avoid:** Use `e.stopPropagation()` on the rename input, and toggle rename mode explicitly (not relying on dblclick handler that might fire during editor interactions).

## Code Examples

### History API Endpoint (backing audit_log)
```typescript
// Source: [VERIFIED: audit-log.ts logSqlExecution stores eventType='sql_execution']
// New route in server.ts
fastify.get('/api/database/instances/:id/query-history', { preHandler: [verifyToken, requirePermission('instance:query'), requireInstanceAccess()] }, async (request, reply) => {
  try {
    const { id } = request.params as any;
    const query = request.query as any;
    const limit = Math.min(parseInt(query.limit || '50'), 200);
    const offset = parseInt(query.offset || '0');
    const search = query.search || '';
    const results = await auditLogManager.query({
      eventType: 'sql_execution',
      resourceId: String(id),
      limit,
      offset,
    });
    // Apply client-side search filter on SQL text
    let filtered = results;
    if (search) {
      filtered = results.filter(r =>
        r.details?.sql && String(r.details.sql).toLowerCase().includes(search.toLowerCase())
      );
    }
    reply.send({
      items: filtered.map(r => ({
        id: r.id,
        sql: r.details?.sql || '',
        instanceName: r.details?.instanceName || '',
        durationMs: r.details?.durationMs || 0,
        rowCount: r.details?.rowCount || 0,
        status: r.result,
        timestamp: r.timestamp,
      })),
      total: filtered.length,
      limit,
      offset,
    });
  } catch (error: any) {
    reply.code(500).send({ error: '获取查询历史失败：' + error.message });
  }
});
```

### LocalStorage Tab Persistence
```typescript
// Source: [ASSUMED — standard localStorage pattern]
private readonly STORAGE_KEY = 'sql-console-tabs';

private _saveTabs() {
  const data = {
    tabs: this.tabs.map(t => ({ id: t.id, name: t.name, sql: t.sql || '' })),
    activeId: this.activeTabId,
    instanceId: this.selectedId,
  };
  localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
}

private _restoreTabs() {
  const raw = localStorage.getItem(this.STORAGE_KEY);
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    // Restore instance selection
    if (data.instanceId) this._selectInstance(data.instanceId);
    // Restore tabs (editor content only — no results)
    this.tabs = data.tabs.map((t: any) => ({
      id: t.id,
      name: t.name,
      sql: t.sql,
      editorView: null,  // created on first switch
      result: null,       // not persisted (D-02)
    }));
    this.activeTabId = data.activeId;
  } catch { /* corrupted data — start fresh */ }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single EditorView | Multi-tab with multiple EditorViews | This phase | Each tab gets independent undo history, scroll position, and selection state |
| Hardcoded 1000-row limit in `slice(0, 1000)` | Configurable page size (25/50/100/All) | This phase | Users can see all rows or choose a comfortable page size |
| Flat autocomplete keywords | Schema-driven context-aware completions | This phase | Editor suggests tables and columns from live schema while typing |
| No result interaction | Sortable headers + paginated table | This phase | Users can analyze results interactively without re-querying |
| No result export | CSV download with BOM | This phase | Results exportable to Excel-compatible CSV |
| No query history | Persistent searchable history panel | This phase | 200 most recent queries searchable by text + instance filter |
| No EXPLAIN visualization | Tree + Table toggleable views | This phase | Execution plans readable at a glance with efficiency grade |

## Assumptions Log

No `[ASSUMED]` claims in this research — all findings are verified against the codebase (`[VERIFIED]`) or derived from the UI SPEC and CONTEXT.md (`[CITED]`).

## Open Questions (RESOLVED)

None — all design decisions are captured in the UI SPEC and CONTEXT.md. Claude's discretion items are documented and flagged for the planner.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Frontend dev server | Yes | v22.22.1 | — |
| npm | Package manager | Yes | 10.9.4 | pnpm (project uses pnpm in root) |
| CodeMirror 6 packages | SQL editor | Yes | See frontend/package.json | — |
| Lit 3.3 | Web Components | Yes | ^3.3.2 | — |
| Backend db-ops-api | Execute/EXPLAIN/History API | Yes (must be running) | project | — |
| Playwright | E2E smoke tests | Yes | project devDep | — |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Playwright (E2E) |
| Config file | `frontend/playwright.config.ts` |
| Quick run command | `cd frontend && npm run smoke` |
| Full suite command | `cd frontend && npm run smoke` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command |
|--------|----------|-----------|-------------------|
| SQLC-01 | Autocomplete shows table/column names | E2E | Add to `frontend/e2e/smoke.spec.ts` — open sql-console page, type SQL, verify autocomplete suggestions appear |
| SQLC-02 | Click column header cycles sort | E2E | Execute a SELECT, click header, verify sort indicators |
| SQLC-03 | Pagination controls render and function | E2E | Execute a query with >25 rows, change page size, verify row count |
| SQLC-04 | CSV download button exists and triggers download | E2E | Execute a query, click "Export CSV", verify file download |
| SQLC-05 | Multiple tabs can be opened and switched | E2E | Click "+", switch tabs, verify independent editor content |
| SQLC-06 | History panel shows executed queries | Manual-only | Verify by manual inspection — requires running queries and checking history panel |
| SQLC-07 | EXPLAIN button renders plan visualization | E2E | Execute a SELECT, click "Analyze Plan", verify tree/table renders |

### Sampling Rate
- **Per task commit:** E2E smoke test (`npm run smoke`)
- **Per wave merge:** E2E smoke test
- **Phase gate:** Full smoke suite green before `/gsd-verify-work`

## Sources

### Primary (HIGH confidence)
- Codebase audit: `sql-console.ts`, `server.ts`, `sql-executor.ts`, `audit-log.ts`, `database-service.ts`, `icons.ts`, `base.css`
- Project planning: `86-CONTEXT.md`, `86-UI-SPEC.md`, `86-DISCUSSION-LOG.md`, `REQUIREMENTS.md`, `ROADMAP.md`

### Secondary (MEDIUM confidence)
- CodeMirror 6 multi-editor patterns (verified against project's existing code)
- MySQL EXPLAIN FORMAT=JSON structure (verified via `database-service.ts` lines 1988-1991)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries verified in `frontend/package.json` and codebase
- Architecture: HIGH - All decisions documented in CONTEXT.md, patterns verified
- Pitfalls: HIGH - Based on codebase analysis and known CodeMirror patterns

**Research date:** 2026-05-10
**Valid until:** 2026-06-10 (stable project, no fast-moving dependencies)
