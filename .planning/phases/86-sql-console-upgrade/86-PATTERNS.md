# Phase 86: SQL Console Upgrade - Pattern Map

**Mapped:** 2026-05-10
**Files analyzed:** 2 (both existing files, modified in-place)
**Analogs found:** 2 / 2

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `frontend/src/openclaw/ui/views/sql-console.ts` | component | CRUD + event-driven | itself (existing) + `users-management.ts` (modal), `llm-config.ts` (dialog) | exact (self) |
| `apps/db-ops-api/server.ts` (new route) | route | CRUD (GET with pagination/search) | `server.ts:585-604` (execute route) + `server.ts:747-766` (explain route) | exact (same file) |

## Pattern Assignments

### `frontend/src/openclaw/ui/views/sql-console.ts` (component, CRUD + event-driven)

**Analog:** The existing `sql-console.ts` itself (all features extend this single file). Secondary analogs for supplementary patterns.

---

#### Pattern 1: LitElement Component Setup

**Source:** `sql-console.ts` lines 1-16 (its own existing pattern)

```typescript
import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { sql, MySQL } from "@codemirror/lang-sql";
import { autocompletion, CompletionContext } from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";

@customElement("sql-console-page")
export class SqlConsolePage extends LitElement {
  static override styles = css`...`;
  @state() private someState = ...;
}
```

**Apply to:** All new tab/panel components within the same file.

---

#### Pattern 2: Auth Headers Helper

**Source:** `sql-console.ts` lines 71-74, also `event-management.ts` lines 7-16 (more robust variant)

Existing in sql-console.ts:
```typescript
private _headers() {
  const t = localStorage.getItem("token");
  return t ? { "Content-Type": "application/json", Authorization: `Bearer ${t}` } : { "Content-Type": "application/json" };
}
```

More robust variant from `event-management.ts` lines 7-16 (recommended for reuse):
```typescript
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}
function authHeadersJson(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token
    ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    : { "Content-Type": "application/json" };
}
```

**Apply to:** All new API calls within sql-console.ts.

---

#### Pattern 3: Async Fetch with Loading/Error State Management

**Source:** `sql-console.ts` lines 193-213 (existing select instance pattern)

```typescript
private async loadInstances() {
  try {
    const res = await fetch("/api/database/instances", { headers: this._headers() });
    if (res.ok) this.instances = await res.json();
  } catch { /* */ }
}

private async _selectInstance(id: number) {
  this.selectedId = id;
  this.schemas = [];
  if (!id) return;
  this.objectsLoading = true;
  try {
    const res = await fetch(`/api/database/instances/${id}/schema-objects`, { headers: this._headers() });
    if (res.ok) {
      this.schemas = await res.json();
      this.expandedSchemas = new Set(this.schemas.map(s => s.schema));
    }
  } catch { /* */ }
  this.objectsLoading = false;
}
```

From `llm-config.ts` lines 85-97 (more complete loading/error pattern):
```typescript
private async load() {
  this.loading = true;
  this.error = null;
  try {
    const res = await fetch("/api/llm/configs");
    if (!res.ok) throw new Error("加载失败");
    this.providers = await res.json();
  } catch (e: any) {
    this.error = e.message;
  } finally {
    this.loading = false;
  }
}
```

**Apply to:** All new async operations (history fetch, EXPLAIN fetch, CSV export).

---

#### Pattern 4: CodeMirror EditorView Multi-Instance Pattern

**Source:** `sql-console.ts` lines 96-114 (existing single editor), extended for multi-tab per RESEARCH.md Pattern 1

Existing single EditorView (lines 96-114):
```typescript
private _initEditor() {
  const container = this.renderRoot.querySelector(".cm-wrap");
  if (!container || this.editorView) return;

  const sqlLang = sql({ dialect: MySQL });
  this.editorView = new EditorView({
    state: EditorState.create({
      doc: "",
      extensions: [
        basicSetup,
        sqlLang,
        oneDark,
        autocompletion({ override: [this._sqlCompletions.bind(this)] }),
        EditorView.updateListener.of(() => { this.requestUpdate(); }),
      ],
    }),
    parent: container as HTMLElement,
  });
}
```

Multi-tab extension pattern (from RESEARCH.md Pattern 1, lines 176-217):
```typescript
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
  container.innerHTML = "";

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

**Apply to:** Multi-tab implementation in `_initEditor` replacement / `_switchTab`.

---

#### Pattern 5: Existing Exec SQL Pattern (unchanged core)

**Source:** `sql-console.ts` lines 233-256

```typescript
private async _execute() {
  if (!this.selectedId) return;
  const sql = this.getSQL().trim();
  if (!sql) return;
  this.loading = true; this.result = null; this.error = null; this.approvalResult = null;

  if (this.isDangerous(sql)) {
    await this._submitApproval(sql);
  } else {
    await this._directExecute(sql);
  }
  this.loading = false;
}

private async _directExecute(sql: string) {
  try {
    const res = await fetch(`/api/database/instances/${this.selectedId}/execute`, {
      method: "POST", headers: this._headers(), body: JSON.stringify({ sql }),
    });
    const data = await res.json();
    if (data.success) this.result = data;
    else this.error = data.error || "执行失败";
  } catch (e: any) { this.error = e.message; }
}
```

**Apply to:** Result state management pattern (remains same, `this.result` drives the table).

---

#### Pattern 6: Tab Switching Pattern

**Source:** `approval-dashboard.ts` lines 77-80

```typescript
<div class="tabs">
  <button class="tab ${this.filter === 'pending' ? 'active' : ''}"
    @click=${() => { this.filter = 'pending'; this.loadRequests(); }}>
    待审批
  </button>
  <button class="tab ${this.filter === 'processed' ? 'active' : ''}"
    @click=${() => { this.filter = 'processed'; this.loadRequests(); }}>
    已处理
  </button>
</div>
```

CSS from `approval-dashboard.ts` lines 14-16:
```css
.tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--border, #e5e7eb); }
.tab { padding: 10px 20px; font-size: 14px; cursor: pointer; border: none; background: none; color: var(--muted, #6b7280); border-bottom: 2px solid transparent; }
.tab.active { color: var(--accent, #3b82f6); border-bottom-color: var(--accent, #3b82f6); }
```

**Apply to:** Tab bar in sql-console.ts (main query tabs), Schema/History sidebar toggle.

---

#### Pattern 7: Modal / Dialog Pattern

**Source:** `users-management.ts` lines 296-375 (modal overlay + dialog structure)

```typescript
// CSS
.modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: overlay-fade-in 0.2s ease;
}
.modal {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  width: 90%;
  max-width: 480px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: var(--shadow-lg);
}
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.modal-title { font-size: 15px; font-weight: 600; color: var(--text-strong); }
.modal-close { background: none; border: none; font-size: 20px; cursor: pointer; color: var(--muted); padding: 4px; line-height: 1; }
.modal-body { padding: 20px; display: grid; gap: 16px; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 20px; border-top: 1px solid var(--border); }

// Template
html`
  <div class="modal-overlay" @click=${(e: Event) => {
    if ((e.target as HTMLElement).classList.contains("modal-overlay")) { this._closeModal(); }
  }}>
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Title</span>
        <button class="modal-close" @click=${this._closeModal}>&times;</button>
      </div>
      <div class="modal-body">...</div>
      <div class="modal-footer">
        <button class="btn" @click=${this._closeModal}>取消</button>
        <button class="btn btn--primary" @click=${this._save} ?disabled=${this.saving}>保存</button>
      </div>
    </div>
  </div>
`
```

**Apply to:** Confirmation dialog when closing tab with unsaved SQL (D-03).

---

#### Pattern 8: Existing Table Pattern (to be extended with sort + pagination)

**Source:** `sql-console.ts` lines 338-351 (existing result table)

```typescript
// CURRENT — modify to add sortable headers and page controls
<div class="results">
  <div class="results-header">
    <span>${this.result.rowCount ?? 0} rows · ${this.result.duration_ms ?? 0}ms</span>
  </div>
  <div class="results-scroll">
    <table>
      <thead><tr>${(this.result.columns || []).map(c => html`<th>${c}</th>`)}</tr></thead>
      <tbody>
        ${(this.result.rows || []).slice(0, 1000).map(row => html`
          <tr>${(this.result!.columns || []).map(c => {
            const v = row[c];
            return html`<td class=${v === null ? "null" : ""} title=${String(v ?? "NULL")}>${v === null ? "NULL" : String(v)}</td>`;
          })}</tr>
        `)}
      </tbody>
    </table>
  </div>
</div>
```

Existing CSS (lines 45-51):
```css
.results { border: 1px solid var(--border, #e5e7eb); border-radius: 8px; overflow: hidden; max-height: 300px; display: flex; flex-direction: column; background: var(--card, #fff); }
.results-header { padding: 8px 14px; font-size: 12px; border-bottom: 1px solid var(--border, #e5e7eb); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
.results-scroll { overflow: auto; flex: 1; }
.results table { width: 100%; border-collapse: collapse; font-size: 12px; }
.results th { position: sticky; top: 0; background: var(--bg-elevated, #f9fafb); padding: 6px 10px; text-align: left; font-weight: 600; border-bottom: 1px solid var(--border, #e5e7eb); z-index: 1; }
.results td { padding: 4px 10px; border-bottom: 1px solid var(--border, #e5e7eb); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.results td.null { color: var(--muted, #9ca3af); font-style: italic; }
```

**Sort + Pagination extension pattern** (from RESEARCH.md Pattern 2, lines 226-248):
```typescript
private _sortAndPaginate(rows: any[], columns: string[]) {
  const sortCol = this.sortColumn;
  const sortDir = this.sortDirection;
  let sorted = [...rows];

  if (sortCol && sortDir) {
    sorted.sort((a, b) => {
      const va = a[sortCol], vb = b[sortCol];
      if (va === null) return 1;
      if (vb === null) return -1;
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

**Apply to:** Result table rendering in `render()`.

---

#### Pattern 9: CSV Export Pattern

**Source:** RESEARCH.md Pattern 3 (lines 257-280)

```typescript
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

**Apply to:** CSV export button handler in sql-console.ts.

---

#### Pattern 10: Icon Usage Pattern

**Source:** `index-management.ts` line 3 (import) and `icons.ts` (definition)

```typescript
import { icons } from "../icons.js";

// Usage in template:
html`<span class="icon">${icons.search}</span>`
```

Icons available for new features (from `icons.ts`):
- `search` — search/magnifying glass
- `x` — close/delete
- `chevronDown` / `chevronRight` — expand/collapse
- `download` — CSV export button
- `sortAsc` / `sortDesc` — sort indicator
- `list` / `tree` — EXPLAIN view toggle (list/tree icons needed)
- `fileText` — document icon for tabs
- `clock` / `history` — history panel

**Apply to:** All new UI controls (tab close button, sort indicators, view toggle buttons).

---

#### Pattern 11: localStorage Persistence Pattern

**Source:** RESEARCH.md localStorage example (lines 413-443)

```typescript
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
    if (data.instanceId) this._selectInstance(data.instanceId);
    this.tabs = data.tabs.map((t: any) => ({
      id: t.id, name: t.name, sql: t.sql,
      editorView: null,
      result: null,
    }));
    this.activeTabId = data.activeId;
  } catch { /* corrupted data — start fresh */ }
}
```

**Apply to:** Tab persistence in sql-console.ts (D-02).

---

#### Pattern 12: Recursive Lit Template for EXPLAIN Tree

**Source:** RESEARCH.md Pattern 4 (lines 289-324)

```typescript
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
    const pgPlan = Array.isArray(plan) ? plan[0]?.Plan : plan.Plan;
    return this._normalizePGNode(pgPlan);
  }
  return { operation: 'unknown', rows: 0, cost: 0, children: [] };
}
```

**Apply to:** EXPLAIN view tree/toggle in sql-console.ts.

---

#### Pattern 13: Inline Tab Rename Pattern

**Source:** RESEARCH.md D-04 and Pitfall 4 (line 361)

Use `e.stopPropagation()` on the rename input. Toggle rename mode explicitly:
```typescript
private _editingTabId: string | null = null;
private _editingTabName = '';

private _startRename(tabId: string, currentName: string) {
  this._editingTabId = tabId;
  this._editingTabName = currentName;
}

private _finishRename() {
  if (this._editingTabId) {
    const tab = this.tabs.find(t => t.id === this._editingTabId);
    if (tab) tab.name = this._editingTabName || tab.name;
    this._editingTabId = null;
  }
}
```

**Apply to:** Double-click tab rename feature (D-04).

---

### `apps/db-ops-api/server.ts` (route, CRUD — GET with pagination/search)

**Analog:** `server.ts` lines 585-604 (execute route) + lines 747-766 (explain route) + lines 652-661 (approval history) + lines 769-778 (schema objects)

---

#### Pattern 1: Fastify Route with Auth Middleware

**Source:** `server.ts` lines 585-604 (execute route)

```typescript
fastify.post('/api/database/instances/:id/execute', { preHandler: [verifyToken, requirePermission('instance:query'), requireInstanceAccess()] }, async (request, reply) => {
  try {
    const { id } = request.params as any;
    const { sql } = request.body as any;
    if (!sql) return reply.code(400).send({ error: '缺少参数：sql' });

    const user = (request as any).user;
    const result = await sqlExecutor.executeSql(Number(id), sql, {
      userId: String(user?.userId || ''),
      username: user?.username || 'unknown',
      ipAddress: request.ip,
    });
    if (!result.success) {
      return reply.code(400).send(result);
    }
    reply.send(result);
  } catch (error: any) {
    reply.code(500).send({ error: 'SQL 执行失败：' + error.message });
  }
});
```

Key structural pattern for all routes:
- `{ preHandler: [verifyToken, requirePermission(...), requireInstanceAccess()] }` for guarded routes
- `try/catch` wrapping the entire handler
- `request.params as any` + `request.query as any` for parameter extraction
- Input validation with early `reply.code(400).send(...)` for missing params
- `reply.send(data)` on success
- `reply.code(500).send({ error: '...' + error.message })` on catch

---

#### Pattern 2: Query Parameters with Pagination and Limits

**Source:** `server.ts` lines 652-661 (approval history route) + lines 731-743 (QAN route)

```typescript
// approval history — limit with cap
fastify.get('/api/approval/history', { preHandler: [verifyToken, requirePermission('approval:view')] }, async (request, reply) => {
  try {
    const query = request.query as any;
    const limit = Math.min(parseInt(query.limit || '50'), 200);
    const list = await approvalService.getProcessedRequests(limit);
    reply.send(list);
  } catch (error: any) {
    reply.code(500).send({ error: error.message });
  }
});

// QAN — pagination with default and cap
fastify.get('/api/database/instances/:id/qan', { preHandler: [verifyToken, requirePermission('instance:view'), requireInstanceAccess()] }, async (request, reply) => {
  try {
    const { id } = request.params as any;
    const query = request.query as any;
    const limit = Math.min(parseInt(query.limit || '20') || 20, 100);
    const data = await databaseService.getQueryAnalytics(Number(id), limit);
    ...
  }
});
```

**Apply to:** History endpoint — use this pattern for `limit`, `offset`, and `search` query params with validation.

---

#### Pattern 3: GET Route without Body

**Source:** `server.ts` lines 769-778 (schema-objects — simple GET) + lines 747-766 (explain — GET with query param)

```typescript
// Simple GET — schema objects
fastify.get('/api/database/instances/:id/schema-objects', async (request, reply) => {
  try {
    const { id } = request.params as any;
    const objects = await databaseService.getSchemaObjects(Number(id));
    if (!objects) return reply.code(404).send({ error: '无法获取 schema 对象' });
    reply.send(objects);
  } catch (error: any) {
    reply.code(500).send({ error: error.message });
  }
});

// GET with query param — explain
fastify.get('/api/database/instances/:id/explain', { preHandler: [verifyToken, requirePermission('instance:query'), requireInstanceAccess()] }, async (request, reply) => {
  try {
    const { id } = request.params as any;
    const query = request.query as any;
    const sql = query.sql;
    if (!sql) return reply.code(400).send({ error: '缺少参数：sql' });
    ...
  }
});
```

**Apply to:** History endpoint — GET with `:id`, `limit`, `offset`, `search` query params.

---

#### Pattern 4: Audit Log Query for History

**Source:** `audit-log.ts` lines 77-98 (AuditLogQuery interface) + lines 516-518 (query method)

```typescript
// Query interface
export interface AuditLogQuery {
  eventType?: AuditEventType;
  userId?: string;
  resourceId?: string;
  limit?: number;
  offset?: number;
  ...
}

// Query method
async query(params: AuditLogQuery): Promise<AuditLogEntry[]> {
  return await this.handler.query(params);
}

// SQL execution entry shape (from logSqlExecution, lines 559-594)
// details: { instanceName, dbType, sql, durationMs, rowCount, errorMessage }
// resourceId: String(instanceId), eventType: 'sql_execution', result: 'success' | 'failure'
```

**Apply to:** History endpoint — use `auditLogManager.query({ eventType: 'sql_execution', resourceId: String(id), limit, offset })` to fetch history records.

---

## Shared Patterns

### Authentication / Token Handling (Frontend)
**Source:** `sql-console.ts` lines 71-74, `event-management.ts` lines 7-16
**Apply to:** All new fetch calls within sql-console.ts

Two established patterns:
1. `_headers()` method (used in sql-console.ts, approval-dashboard.ts) — returns Content-Type + Authorization
2. `authHeaders()` / `authHeadersJson()` functions (used in event-management.ts) — separate JSON vs non-JSON

Either is acceptable; plan to use the existing `_headers()` pattern in sql-console.ts for consistency.

### Backend Route Error Handling
**Source:** `server.ts` all route handlers
**Apply to:** The new query-history route

All Fastify routes in this project follow the same pattern:
```
try {
  // validate inputs, early return 400
  // call service
  // 404 if null
  // reply.send(result)
} catch (error: any) {
  reply.code(500).send({ error: '<描述>：' + error.message });
}
```

### CSS Variable System
**Source:** Throughout all views
**Apply to:** All new UI in sql-console.ts

Standard CSS variables available:
- `--card`, `--border`, `--bg-elevated`, `--bg-hover`
- `--accent`, `--accent-subtle`, `--accent-hover`
- `--text`, `--text-strong`, `--muted`
- `--destructive`, `--danger-subtle`
- `--warn`, `--warn-subtle`
- `--ok`, `--ok-subtle`
- `--secondary`
- `--radius`, `--radius-sm`, `--radius-lg`
- `--shadow-lg`

### Test Patterns (E2E with Playwright)
**Source:** `frontend/e2e/smoke.spec.ts`
**Apply to:** All new feature smoke tests

Existing smoke test suite in `frontend/e2e/smoke.spec.ts`. Add new tests per the Validation Architecture table from RESEARCH.md (lines 490-499). Tests should verify:
- SQLC-02: Click column header cycles sort
- SQLC-03: Pagination controls function
- SQLC-04: CSV download button triggers download
- SQLC-05: Multi-tab open and switch
- SQLC-07: EXPLAIN button renders plan visualization

## No Analog Found

All features have existing analogs. No files require patterns from outside the codebase.

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| — | — | — | All patterns covered by existing code |

## Metadata

**Analog search scope:**
- `frontend/src/openclaw/ui/views/` — all existing view components
- `apps/db-ops-api/server.ts` — all route definitions
- `apps/db-ops-api/src/audit/audit-log.ts` — audit log query interface
- `apps/db-ops-api/src/sql-executor.ts` — SQL execution with audit integration

**Files scanned:** 12 (sql-console.ts, llm-config.ts, users-management.ts, approval-dashboard.ts, index-management.ts, event-management.ts, ai-analysis-result.ts, overview-hints.ts, server.ts, sql-executor.ts, audit-log.ts, icons.ts)

**Pattern extraction date:** 2026-05-10
