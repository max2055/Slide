---
phase: 86-sql-console-upgrade
plan: 03
subsystem: frontend
tags: [lit-element, sort, pagination, csv-export, sql-console]

requires:
  - "86-02: Multi-tab editor with autocomplete"
provides:
  - Sortable column headers with asc/desc/none cycling and null-at-end behavior
  - Client-side pagination with configurable page size (25/50/100/All)
  - CSV export with RFC 4180 escaping and UTF-8 BOM
affects: [Plan 04, Plan 05]

tech-stack:
  added: []
  patterns:
    - "Sort + paginate pipeline: _sortRows -> slice in render() IIFE"
    - "IIFE pattern for local variable computation inside Lit template"
    - "CSV Blob download with sorted rows, BOM, and RFC 4180 escaping"
    - "Null-at-end sort with numeric-aware comparison"

key-files:
  modified:
    - frontend/src/openclaw/ui/views/sql-console.ts

key-decisions:
  - "Sort state reset on re-execute per D-07 (sortColumn=null, sortDirection=null, currentPage=1)"
  - "IIFE pattern (() => { ...; return html`...`; })() for local variable computation in Lit template expressions"
  - "_exportCSV reads from activeTab.result (per-tab result model from Plan 02), not this.result"
  - "CSV filename format: query-result-{instanceName}-{YYYYMMDDHHmmss}.csv"
  - "Sort uses spread operator on ...rows before sorting to avoid mutating the original result array"

requirements-completed: [SQLC-02, SQLC-03, SQLC-04]

duration: 22min
completed: 2026-05-10
---

# Phase 86 Plan 03: Result Table Enhancement — Sort, Pagination & CSV Export

**Enhanced result table with sortable column headers (asc/desc/none cycling), client-side pagination with 25/50/100/All page size presets and prev/next navigation, and CSV export using Blob download with RFC 4180 escaping and UTF-8 BOM.**

## Performance

- **Duration:** 22 min
- **Started:** 2026-05-10T20:00:00Z
- **Completed:** 2026-05-10T20:22:00Z
- **Tasks:** 3
- **Files modified:** 1

## Accomplishments

### Task 1: Sortable column headers with sort state cycling (SQLC-02)
- Added `sortColumn` and `sortDirection` reactive state fields
- Implemented `_toggleSort(column)` with asc -> desc -> null (unsorted) cycling
- Implemented `_sortRows(rows)` with null-at-end for both sort directions and numeric-aware comparison (number vs string via `!isNaN`)
- Reset sort state on query re-execution within `_execute()`
- Added sort indicator (triangle-up `▲` / triangle-down `▼`) in column headers with accent color
- Added `th:hover` CSS highlight using `--accent-subtle`
- Only one column sorted at a time -- sorting a different column clears the previous sort

### Task 2: Client-side pagination with page size controls (SQLC-03)
- Added `pageSize` (number | 'all', default 50) and `currentPage` state fields
- Implemented `_changePageSize(size)` which resets to page 1
- Implemented `_goToPage(page)` for prev/next navigation
- Replaced the entire results block in `render()` with an IIFE that computes sorted + paginated rows:
  - `_sortRows(allRows)` then slice by page
  - Page info format: `{start}--{end} / {total} 行`
  - Page size select: 25, 50, 100, all (全部)
  - Prev (`‹`) / Next (`›`) buttons with disabled state at boundaries
- All buttons disabled when "All" page size is selected (no nav needed)
- Page info, page nav, page size select, and export button CSS

### Task 3: CSV export via client-side Blob download (SQLC-04)
- Implemented `_exportCSV()` using the active tab's result data (`this.activeTab.result`)
- **RFC 4180 escaping:** Cells containing comma, double-quote, or newline wrapped in double-quotes; inner double-quotes escaped as `""`
- **UTF-8 BOM** added for Excel compatibility
- **Null handling:** NULL/undefined exported as empty string
- **Filename format:** `query-result-{instanceName}-{YYYYMMDDHHmmss}.csv`
- **Sorted export:** Rows sorted before export using `_sortRows()`
- **Button wiring:** `icons.download` icon + "导出 CSV" label in results-header-right

## Task Commits

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Sortable column headers with asc/desc/none cycling | `e4a712417e` |
| 2 | Client-side pagination with page size controls | `de085ba0c1` |
| 3 | CSV export via client-side Blob download | `13ca3edea9` |

## Files Modified
- `frontend/src/openclaw/ui/views/sql-console.ts` -- +131/-0 lines, now 684 lines

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed _exportCSV to read from activeTab.result instead of this.result**
- **Found during:** Task 3 implementation
- **Issue:** The plan's `_exportCSV` template referenced `this.result?.columns` and `this.result?.rows`, but after Plan 02 results are stored per-tab via `this.activeTab.result`. The `this.result` field no longer exists.
- **Fix:** Changed `_exportCSV` to read `const r = this.activeTab?.result` and use `r.columns` / `r.rows`.
- **File modified:** `frontend/src/openclaw/ui/views/sql-console.ts`
- **Commit:** `13ca3edea9`

## Verification Results

| Check | Result |
|-------|--------|
| `npx vitest run` discovers all 18 tests (RED stubs) | PASS |
| `npx vite build` -- pre-existing error in `app-render.ts` | PRE-EXISTING (not caused by this plan) |

## Acceptance Criteria Verification

| Criterion | Result |
|----------|--------|
| Contains `@state() private sortColumn: string \| null = null;` | PASS (line 104) |
| Contains `@state() private sortDirection: 'asc' \| 'desc' \| null = null;` | PASS (line 105) |
| Contains `_toggleSort(` | PASS |
| Contains `_sortRows(` | PASS |
| Contains null-at-end: `if (va === null \|\| va === undefined) return 1;` | PASS |
| Contains numeric-aware: `!isNaN(na) && !isNaN(nb)` | PASS |
| Contains sort reset in _execute: `sortColumn = null; sortDirection = null;` | PASS |
| Contains sort indicators `▲` and `▼` in column header template | PASS |
| Contains `cursor:pointer` on th | PASS |
| Contains `@state() private pageSize: number \| 'all' = 50;` | PASS |
| Contains `@state() private currentPage: number = 1;` | PASS |
| Contains `_changePageSize(` | PASS |
| Contains `_goToPage(` | PASS |
| Contains page info format: `${start}--${end} / ${total} 行` | PASS |
| Contains page size option `value="50"` | PASS |
| Contains `allRows.slice(` | PASS |
| Contains `this.currentPage = 1` reset in _execute | PASS |
| Contains `.page-info`, `.page-nav`, `.page-btn` CSS classes | PASS |
| Contains `private _exportCSV()` | PASS |
| Contains RFC 4180 escaping: `.replace(/"/g, '""')` | PASS |
| Contains UTF-8 BOM: `BOM = '...'` | PASS |
| Contains filename pattern: `query-result-` | PASS |
| Contains `URL.createObjectURL(blob)` and `a.click()` | PASS |
| Using sorted rows in CSV: `this._sortRows(r.rows)` | PASS |
| File is at least 600 lines | PASS (684 lines) |

## Pre-existing Issues (out of scope)

- `npx vite build` fails due to a duplicate `getVisibleCronJobs` import conflict in `app-render.ts`. This is unrelated to sql-console.ts changes and was noted in Plan 02's summary as well.

## Stub Tracking

No new stubs introduced. The 18 RED test stubs from Plan 01 remain -- they will resolve as Plans 04-05 implement query history and EXPLAIN visualization.

## Threat Surface Scan

No new threat surface found. The plan's threat model (T-86-04 CSV export tampering, T-86-05 sort/pagination disclosure) is correctly addressed:
- T-86-04 (Tampering): CSV exports from in-memory result state only, no external data source in the export path. User-initiated download with no side effects. **ACCEPTED** per plan.
- T-86-05 (Information Disclosure): Sort and pagination operate on already-visible result data. No new data exfiltration risk. **ACCEPTED** per plan.

## Self-Check: PASSED

- File `frontend/src/openclaw/ui/views/sql-console.ts` exists and is 684 lines
- Commit `e4a712417e` exists: sortable column headers
- Commit `de085ba0c1` exists: client-side pagination
- Commit `13ca3edea9` exists: CSV export
- All acceptance criteria patterns verified above
- `npx vitest run` discovers all 18 tests (RED stubs as expected)

---
*Phase: 86-sql-console-upgrade*
*Completed: 2026-05-10*
