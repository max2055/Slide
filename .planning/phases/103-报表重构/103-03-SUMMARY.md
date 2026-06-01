---
phase: 103-报表重构
plan: 03
subsystem: ui
tags: [lit, web-components, report-configs, cron, typescript]
requires: []
provides:
  - Scheduled report config management UI (CRUD, toggle, confirm delete)
  - Type label fix for slow_query key
affects: []

tech-stack:
  added: []
  patterns:
    - "Modal dialog for CRUD forms with overlay close and escape support"
    - "Optimistic UI update for toggle switch with rollback on error"

key-files:
  created: []
  modified:
    - frontend/src/openclaw/ui/views/reports.ts

key-decisions:
  - "Report interface type field fixed from report_type to type to match API response"
  - "Use cron package (already in frontend deps) for next-run computation"
  - "Optimistic toggle with rollback on error for enable/disable switch"

patterns-established:
  - "Config CRUD dialog follows same modal pattern as existing alerts.ts cfg-toggle"

requirements-completed: [RPT-02, RPT-03]

duration: 8min
completed: 2026-05-21
---

# Phase 103 Plan 03: Scheduled Config UI Summary

**Scheduled report config management UI with create/edit/delete/toggle dialogs and empty state, plus slow_query type label fix**

## Performance

- **Duration:** 8 min
- **Started:** 2026-05-21T14:30:00Z
- **Completed:** 2026-05-21T14:38:00Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments

- ReportConfig interface defined matching backend model with all fields
- Config card rendered between stat-cards and generate card with table columns: 配置名称, 报表类型, 目标实例, Cron 表达式, 下次执行, 状态, 操作
- Create/edit dialog with form fields (name, type, instance, cron, format, enabled toggle)
- Delete confirmation dialog with destructive-styled delete button and cancel option
- CRUD operations wired via authFetch to backend API (POST/PUT/DELETE /api/reports/configs)
- Toggle enable/disable with optimistic UI update and rollback on error
- Next-run time computed on frontend using CronJob.nextDates() from cron package
- Empty state renders with correct copy when no configs exist
- _reportTypeLabel fixed to use slow_query key instead of slow-query (D-09, D-10)
- Report interface type field fixed to match actual API response

## Task Commits

Each task was committed atomically:

1. **Task 1: Add scheduled config card UI with config list, empty state, refresh, and fix _reportTypeLabel** - `be210431985` (feat)
2. **Task 2: Implement config dialog (create/edit), delete confirmation, toggle, and CRUD wiring** - `4f5b4baa774` (feat)

## Files Created/Modified

- `frontend/src/openclaw/ui/views/reports.ts` - Added ReportConfig interface, config card section with table/empty state, create/edit/delete dialog HTML, CRUD methods, toggle with optimistic rollback, dialog CSS styles, CronJob import for next-run computation, fixed _reportTypeLabel key from "slow-query" to slow_query

## Decisions Made

- Used the existing `cron` package (already a frontend dependency) for computing next_run on the client side, avoiding extra API trips
- Optimistic toggle pattern with rollback on network error provides responsive UX at the cost of brief inconsistency if the PUT fails
- Fixed pre-existing `Report` interface: renamed `report_type` to `type` to match actual API response data

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Report interface type field to match API response**
- **Found during:** Task 2 (TypeScript compilation check)
- **Issue:** `Report` interface had `report_type?: string` but the template used `report.type`. This pre-existing bug caused TS2339 compilation error: property 'type' does not exist on type 'Report'.
- **Fix:** Renamed `report_type` to `type` in the `Report` interface to match the API response field name used in the template.
- **Files modified:** `frontend/src/openclaw/ui/views/reports.ts`
- **Verification:** `npx tsc --noEmit` now passes with no errors in reports.ts
- **Committed in:** `4f5b4baa774` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Necessary fix for TypeScript compilation compliance. The error was pre-existing but in the same file being modified.

## Issues Encountered

- Pre-existing TS2339 error on `report.type` (Report interface had `report_type` not `type`) — fixed as part of Task 2
- No new issues during implementation — all API routes from plan 103-02 were already merged and available

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Scheduled config management UI is complete with full CRUD, toggle, and delete confirmation
- All wire-up to existing backend API endpoints is verified
- Ready for integration testing and visual verification

---
*Phase: 103-报表重构*
*Completed: 2026-05-21*
