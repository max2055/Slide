---
phase: 89-gap-closure
plan: 03
subsystem: ui
tags: [topsql, diagnosis-polling, schema-management, lit-element]

# Dependency graph
requires:
  - phase: 86-sql-console-upgrade
    provides: instance detail page base
  - phase: 88-dashboard-upgrade
    provides: shared instance detail components
provides:
  - topsql badge-content consistency via pre-load
  - diagnosis polling 5-minute timeout
  - schema collect/detect error message handling
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Pre-load data outside tab switch for badge consistency
    - Non-OK HTTP response handling with structured error display

key-files:
  created: []
  modified:
    - frontend/src/openclaw/ui/views/instance-detail.ts
    - frontend/src/openclaw/ui/views/schema-management.ts

key-decisions:
  - "Frontend-side polling timeout (5 min) as safety net for stuck backend analysis"
  - "Pre-load topsql data outside the activeTab switch ensures badge/content consistency"
  - "Non-OK HTTP responses in schema collect/detect show API error message or HTTP status instead of generic Bad Request"

requirements-completed: []

# Metrics
duration: 2min
completed: 2026-05-13
---

# Phase 89 Plan 03: Gap Closure Summary

**Fix topsql pre-loading, diagnosis polling timeout, and schema error handling (D-02 frontend, D-03, D-04)**

## Performance

- **Duration:** 2 min
- **Started:** 2026-05-13T01:41:58Z
- **Completed:** 2026-05-13T01:43:30Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments

- Topsql data pre-loaded on initial page load (not only when tab clicked), ensuring badge count matches content consistently. Added `_loadTopSqlData()` method called unconditionally in `loadTabData()`, with loading state to prevent empty-state flash.
- Diagnosis polling now tracks elapsed time and stops after 5 minutes with "诊断超时，请重试" timeout error. Existing success/fail detection for normal cases is preserved.
- Schema collect and detect POST handlers now check `res.ok` before parsing JSON. Non-OK responses display the API error body or HTTP status code as meaningful text instead of generic "Bad Request".

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix topsql tab data consistency** - `70c5c0d6f7` (fix)
2. **Task 2: Add diagnosis polling timeout** - `a1955920b7` (fix)
3. **Task 3: Fix schema collect/detect error handling** - `6553e2df0c` (fix)

## Files Modified

- `frontend/src/openclaw/ui/views/instance-detail.ts` - topsql pre-load with loading state, diagnosis polling 5-minute timeout
- `frontend/src/openclaw/ui/views/schema-management.ts` - non-OK HTTP response handling for collect and detect POST handlers

## Decisions Made

- Frontend-side 5-minute polling timeout as independent safety net, in addition to backend 10-minute timeout (Plan 02). This provides faster fallback for the user.
- Pre-load in `loadTabData()` runs before the switch, so topsql data is loaded on every data load call (initial page load and background auto-refresh), not only when the tab is clicked.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness

- All three D-02/D-03/D-04 issues addressed.
- Ready for Plan 04 (D-05 tooltip, D-06 EXPLAIN normalizer, D-07 checkbox separation).

---
*Phase: gap-closure-89*
*Completed: 2026-05-13*
