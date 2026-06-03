---
phase: 86-sql-console-upgrade
plan: 05
subsystem: ui
tags: [explain, plan-visualization, tree-view, table-view, efficiency-grade, sql-console]

requires:
  - "86-02: Multi-tab editor with autocomplete"
  - "86-03: Sortable/paginated result table with CSV export"
  - "86-04: Query history panel with backend API"
provides:
  - EXPLAIN normalizer for MySQL query_block and PostgreSQL plan array formats
  - Collapsible tree view of execution plan with expand/collapse
  - Flat sortable table view with Operation, Rows, Cost, Details columns
  - Tree/Table view toggle ("树形"/"表格")
  - Summary bar with total cost, rows examined, and efficiency grade
  - "分析计划" button in the toolbar next to Execute
  - "返回结果" back-to-results link
affects: [Plan 06]

tech-stack:
  added: []
  patterns:
    - "Recursive Lit template for collapsible EXPLAIN tree rendering"
    - "Pure-function normalizer bridging MySQL and PostgreSQL EXPLAIN JSON structures"
    - "Efficiency grade heuristics from plan node operation names"

key-files:
  modified:
    - frontend/src/openclaw/ui/views/sql-console.ts

key-decisions:
  - "Normalizer uses db_type from instance metadata (not from EXPLAIN JSON) to route between MySQL and PG normalization paths"
  - "Root node expanded by default (_expandedNodes initialized with root node after fetch)"
  - "Efficiency grade recurses into children for worst-grade detection"
  - "Column details rendered as tooltip badge with count badge (e.g., '3 详情') to keep row compact"
  - "explainData > explainLoading > explainError > result priority chain in render()"

requirements-completed: [SQLC-07]

duration: 4min
completed: 2026-05-10
---

# Phase 86 Plan 05: EXPLAIN JSON Visualization with Tree/Table Toggle

**EXPLAIN visualization with collapsible tree view, flat sortable table view, view toggle between "树形"/"表格", efficiency grade summary bar, and "分析计划" button in the SQL console toolbar.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-10T12:14:28Z
- **Completed:** 2026-05-10T12:19:08Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments

### Task 1: EXPLAIN normalizer, efficiency grades, tree view, and summary bar

- Added `PlanNode` interface with `operation`, `rows`, `cost`, `children`, `details`
- Added 4 reactive state fields: `explainData`, `explainViewMode`, `explainLoading`, `explainError`
- Added `_expandedNodes: Set<PlanNode>` for collapsible tree state
- Implemented `_explainNormalizer` with MySQL (`query_block`) and PostgreSQL (`Node Type` / `Plans` array) format support
- Implemented `_normalizeMySQLNode` that reads `table.access_type`, `table.key`, `table.rows_examined_per_scan`, `cost_info.query_cost`
- Implemented `_normalizePGNode` that reads `Node Type`, `Plan Rows`, `Total Cost`, `Relation Name`
- Implemented `_efficiencyGrade` with heuristics for index scan (high), full table scan/seq scan (warn), temporary table (warn), filesort (warn), const/eq_ref (high)
- Implemented `_calculateSummary` for recursive total cost and rows aggregation
- Implemented `_renderPlanTree` recursive Lit template with expand/collapse chevrons
- Added CSS for `.plan-tree`, `.plan-node`, `.plan-node-row`, `.plan-children`

### Task 2: EXPLAIN button, table view, view toggle, summary bar, and back-to-results

- Added `_fetchExplain` method calling `GET /api/database/instances/:id/explain?sql=...`
- Added "分析计划" button (`.btn-explain`) with `icons.eye` next to Execute button
- Added `_flattenPlan` to flatten nested plan nodes into flat rows
- Added `_renderPlanTable` for flat sortable table with columns: 操作, 行数, 成本, 详情
- Added "树形" / "表格" toggle buttons with `.explain-toggle-btn.active` state
- Added summary bar with "总成本: {cost}" and "扫描行数: {rows}"
- Added "返回结果" back-to-results link to restore data table view
- Added `explainData > explainLoading > explainError > result` priority chain in render()
- Added CSS for `.explain-container`, `.explain-summary`, `.explain-toolbar`, `.plan-table`

## Task Commits

| Task | Description | Commit |
|------|-------------|--------|
| 1 | EXPLAIN normalizer, efficiency grades, tree view renderer | `6c0dbebb08` |
| 2 | EXPLAIN button, table view, view toggle, summary bar, back-to-results | `19720045f7` |

## Files Modified

- `frontend/src/openclaw/ui/views/sql-console.ts` -- +310/-1 lines, now 1142 lines

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

| Check | Result |
|-------|--------|
| `npx vitest run` discovers all 18 tests (RED stubs) | PASS |
| `npm run build` (frontend) | PASS |

## Acceptance Criteria Verification

### Task 1 Acceptance Criteria

| Criterion | Result |
|-----------|--------|
| Contains `interface PlanNode` with operation, rows, cost, children, details | PASS |
| Contains `_explainNormalizer(plan: any, dbType: string): PlanNode` | PASS |
| Contains `_normalizeMySQLPlan` and `_normalizePGPlan` | PASS |
| Contains `_normalizeMySQLNode` reading `node.query_block` and `node.table` | PASS |
| Contains `_normalizePGNode` reading `node['Node Type']` and `node['Plans']` | PASS |
| Contains `_efficiencyGrade(` with '索引扫描', '全表扫描', '临时表', '文件排序' | PASS |
| Contains `_renderPlanTree(` recursive method | PASS |
| Contains `_togglePlanNode(` and `_expandedNodes: Set<PlanNode>` | PASS |
| Contains `.plan-tree`, `.plan-node`, `.plan-node-row`, `.plan-children` CSS | PASS |

### Task 2 Acceptance Criteria

| Criterion | Result |
|-----------|--------|
| Contains `private async _fetchExplain(` | PASS |
| Contains `encodeURIComponent(sql)` for safe parameter passing | PASS |
| Contains `this._explainNormalizer(plan, dbType)` call | PASS |
| Contains `_flattenPlan(` and `_renderPlanTable(` | PASS |
| Contains `.btn-explain` CSS class with accent color border | PASS |
| Contains `${icons.eye} 分析计划` in toolbar | PASS |
| Contains `explainViewMode: 'tree' \| 'table'` toggle logic | PASS |
| Contains `树形` and `表格` toggle buttons | PASS |
| Contains `返回结果` button (back-to-results link) | PASS |
| Contains `正在分析执行计划...` (loading text) | PASS |
| Contains `总成本:` and `扫描行数:` in summary bar | PASS |
| Contains `explainData` in render conditional chain | PASS |
| File has at least 850 lines | PASS (1142 lines) |

## Pre-existing Issues (out of scope)

The same pre-existing TypeScript compilation errors in `apps/db-ops-api` noted in prior plans remain -- none are caused by Plan 05 changes.

## Stub Tracking

No new stubs introduced. The 18 RED test stubs remain and will resolve as plans implement features.

## Threat Surface Scan

No new threat surface beyond the plan's documented threat model:
- T-86-08 (Information Disclosure): EXPLAIN fetch reuses the existing backend endpoint which is guarded by `requirePermission('instance:query')` + `requireInstanceAccess()`.
- T-86-09 (Tampering): Normalizer is a pure function with no write path -- malformed JSON produces "unknown" node safely.

## Next Phase Readiness

- EXPLAIN visualization complete for SQLC-07
- Ready for any remaining phase tasks or phase completion

## Self-Check: PASSED

- File `frontend/src/openclaw/ui/views/sql-console.ts` exists and is 1142 lines
- Commit `6c0dbebb08` exists: Task 1 (EXPLAIN normalizer, tree view)
- Commit `19720045f7` exists: Task 2 (EXPLAIN UI integration)
- All acceptance criteria patterns verified above
- `npx vitest run` discovers all 18 tests (RED stubs as expected)
- `npm run build` succeeds

---
*Phase: 86-sql-console-upgrade*
*Completed: 2026-05-10*
