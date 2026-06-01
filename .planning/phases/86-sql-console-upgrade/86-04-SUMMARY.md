---
phase: 86-sql-console-upgrade
plan: 04
subsystem: fullstack
tags: [query-history, audit-log, sidebar-toggle, infinite-scroll, sql-console]

requires:
  - "86-02: Multi-tab editor with autocomplete"
  - "86-03: Sortable/paginated result table with CSV export"
provides:
  - Backend GET /api/database/instances/:id/query-history endpoint with pagination and search
  - Sidebar toggle between Schema browser and Query History views
  - History panel with SQL preview (80 chars), instance name, duration, row count, timestamp
  - Search by SQL text and filter by database instance
  - Infinite scroll (batches of 50, up to 200 items)
  - Click-to-load SQL into active editor tab
affects: [Plan 05]

tech-stack:
  added: []
  patterns:
    - "Fastify GET route with auth middleware + client-side audit log filtering"
    - "MemoryAuditLogStore workaround: query all sql_execution entries, filter by resourceId post-query"
    - "Lit sidebar toggle with conditional template rendering (browser-tabs pattern)"
    - "Infinite scroll via scroll event handler with threshold detection"

key-files:
  modified:
    - apps/db-ops-api/server.ts
    - frontend/src/openclaw/ui/views/sql-console.ts

key-decisions:
  - "queryAuditLogs filters by eventType='sql_execution' only; resourceId filtering done client-side in route handler because MemoryAuditLogStore lacks resourceId filter in AuditLogQuery"
  - "Search implemented as client-side substring match in route handler (not backend SQL LIKE) since in-memory store lacks full-text search"
  - "Sidebar display condition changed from this.selectedId && this.schemas.length > 0 to this.selectedId > 0 so history panel is accessible even while schema is loading"
  - "Removed emoji icons (📋) from schema tree to clean up the visual design per plan spec"
  - "Instance filter dropdown defaults to 0 (current instance) — selecting a specific instance fetches history scoped to that instance"
  - "History load silently fails on error — history is best-effort, not critical path"

requirements-completed: [SQLC-06]

duration: 18min
completed: 2026-05-10
---

# Phase 86 Plan 04: Query History Panel with Backend API

**Added a searchable, paginated query history panel in the SQL console left sidebar, backed by a new GET /api/database/instances/:id/query-history endpoint that queries the existing audit log for sql_execution events, with sidebar toggle between Schema browser and History views, infinite scroll loading, and click-to-load-SQL into the active editor tab.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-05-10T21:00:00Z
- **Completed:** 2026-05-10T21:18:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

### Task 1: Backend GET /api/database/instances/:id/query-history endpoint (SQLC-06)

- Added `import { queryAuditLogs } from './src/audit/audit-log.js'` to server.ts imports
- Added new Fastify GET route at `/api/database/instances/:id/query-history` with auth middleware (`verifyToken`, `requirePermission('instance:query')`, `requireInstanceAccess()`)
- Queries all `sql_execution` events from the in-memory audit log, then filters by instance `resourceId` (workaround for MemoryAuditLogStore lacking resourceId filter)
- Applies case-insensitive search filter on SQL text when `search` query param is provided
- Sorts results by timestamp descending (newest first)
- Paginates with `limit` (default 50, max 200) and `offset` query params
- Returns structured response: `{ items: [...], total, limit, offset }`

### Task 2: Sidebar toggle and query history panel in SQL console (SQLC-06)

- Added `HistoryItem` interface with `id`, `sql`, `instanceName`, `instanceId`, `durationMs`, `rowCount`, `status`, `timestamp`
- Added 8 reactive state fields for history management: `sidebarView`, `historyItems`, `historyLoading`, `historySearch`, `historyInstanceFilter`, `historyOffset`, `historyTotal`, `historyHasMore`
- Implemented `_loadHistory(reset)` with offset-based pagination (batches of 50)
- Implemented `_onHistoryScroll(e)` using scroll-height threshold (100px) for infinite scroll
- Implemented `_loadHistorySQL(sql)` that dispatches the SQL text into the active tab's CodeMirror editor via `editor.dispatch()`
- Replaced sidebar condition from `this.selectedId && this.schemas.length > 0` to `this.selectedId > 0`
- Added browser-tabs toggle (结构 / 历史) at the top of the sidebar
- History panel includes: search input, instance filter dropdown, scrollable item list with loading/empty/end states
- Each history item shows: SQL preview (80 chars truncated), instance name, duration (ms), row count (行), and formatted timestamp
- Empty state shows `icons.history` icon with "暂无查询记录" text and hint
- End-of-list shows "已加载全部历史记录"
- Removed emoji icons (📋, 📁) from schema tree per plan spec
- Added CSS for browser tabs and all history panel components

## Task Commits

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Backend query-history endpoint with pagination and search | `d78d9a620f` |
| 2 | Frontend sidebar toggle and history panel with infinite scroll | `ed96856801` |

## Files Modified

- `apps/db-ops-api/server.ts` -- +54/-0 lines (import + 53-line route)
- `frontend/src/openclaw/ui/views/sql-console.ts` -- +170/-21 lines, now 833 lines

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` (backend) | PASS (pre-existing errors only, no new errors) |
| `npx vitest run` discovers all 18 tests (RED stubs) | PASS |
| `npm run build` (frontend) | PASS |

## Acceptance Criteria Verification

### Backend (server.ts)

| Criterion | Result |
|-----------|--------|
| Contains `import { queryAuditLogs } from './src/audit/audit-log.js'` | PASS (line 57) |
| Contains `fastify.get('/api/database/instances/:id/query-history'` | PASS (line 782) |
| Contains `preHandler: [verifyToken, requirePermission('instance:query'), requireInstanceAccess()]` | PASS |
| Contains `eventType: 'sql_execution'` | PASS |
| Contains `filtered.filter(e => e.details?.sql && String(e.details.sql).toLowerCase().includes(lowerSearch))` | PASS |
| Contains `filtered.sort((a, b) => b.timestamp - a.timestamp)` | PASS |
| Contains `Math.min(parseInt(query.limit || '50'), 200)` | PASS |
| Returns `items`, `total`, `limit`, `offset` | PASS |

### Frontend (sql-console.ts)

| Criterion | Result |
|-----------|--------|
| Contains `@state() private sidebarView: 'schema' \| 'history' = 'schema'` | PASS |
| Contains `@state() private historyItems: HistoryItem[] = []` | PASS |
| Contains `interface HistoryItem` with sql, instanceName, durationMs, rowCount, timestamp | PASS |
| Contains `private async _loadHistory(` | PASS |
| Contains `private _onHistoryScroll(` | PASS |
| Contains `private _loadHistorySQL(` | PASS |
| Contains `.browser-tab.active` CSS class | PASS |
| Contains `.history-panel` CSS class | PASS |
| Contains "暂无查询记录" (empty state copy) | PASS |
| Contains "已加载全部历史记录" (end-of-list copy) | PASS |
| Contains `icons.history` reference | PASS |
| Contains `history-instance-filter` select element with instance names | PASS |
| Contains "全部实例" (all instances option) | PASS |
| File has at least 720 lines | PASS (833 lines) |
| `npx vitest run` discovers all tests (RED) | PASS |

## Pre-existing Issues (out of scope)

- TypeScript compilation in `apps/db-ops-api` shows pre-existing errors unrelated to this plan (e.g., `session-store.ts` `toSorted` target, `audit-log.ts` interface mismatch, test files using `vi` without import). None are caused by Plan 04 changes.

## Stub Tracking

No new stubs introduced. The 18 RED test stubs from Plan 01 remain -- they will resolve as plans implement features.

## Threat Surface Scan

No new threat surface beyond the plan's documented threat model:
- T-86-06 (Information Disclosure): Route guarded by `requirePermission('instance:query')` + `requireInstanceAccess()` -- user can only see history for instances they have access to.
- T-86-07 (Tampering): Search is a GET query parameter applied client-side to already-filtered server results. No write path.
Both mitigations are correctly implemented as specified in the plan.

## Self-Check: PASSED

- File `apps/db-ops-api/server.ts` exists and contains the query-history route
- File `frontend/src/openclaw/ui/views/sql-console.ts` exists and is 833 lines
- Commit `d78d9a620f` exists: backend query-history endpoint
- Commit `ed96856801` exists: frontend history panel
- All acceptance criteria patterns verified above
- `npx vitest run` discovers all 18 tests (RED stubs as expected)
- `npm run build` succeeds

---
*Phase: 86-sql-console-upgrade*
*Completed: 2026-05-10*
