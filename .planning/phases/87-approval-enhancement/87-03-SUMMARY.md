---
phase: 87-approval-enhancement
plan: 03
subsystem: ui
tags: lit, web-components, approval-dashboard, batch-ops, checkbox-multiselect, confirmation-dialog
requires:
  - phase: 87-02
    provides: Backend batch-review API endpoint POST /api/approval/batch-review
provides:
  - approval-dashboard sub-view switching (list/detail)
  - Checkbox multi-select with batch action bar
  - execute-after-approve toggle per pending request
  - Batch confirmation dialog with Escape key dismissal
  - Execution result display in processed tab
affects: [87-04 (detail view enhancement)]

tech-stack:
  added: []
  patterns:
    - Sub-view switching via view state + openDetail/backToList dispatch
    - Batch action bar animation with fade-in for selected state
    - Escape key dismissal via document keydown listener + modal-overlay @keydown
    - Opt-out execute checkbox per row, default checked

key-files:
  modified:
    - frontend/src/openclaw/ui/views/approval-dashboard.ts

key-decisions:
  - "Single _openBatchDialog function used for both batch and single-item approve/reject (unified dialog flow)"
  - "Escape key handled via document.addEventListener (added on open, removed on close) AND modal-overlay @keydown for redundancy"
  - "Notifications removed from review field (AI reasoning shown inline, separate from review notes)"

patterns-established:
  - "Batch operations use Set<number> for selectedIds for O(1) lookup in card rendering"
  - "Execution result display parses JSON string or object, shows duration/rowCount/rowsAffected"

requirements-completed: [APPR-03, APPR-04, APPR-05]

duration: 8min
completed: 2026-05-11
---

# Phase 87 Plan 03: Approval Dashboard List View with Batch Operations

**Restructured approval-dashboard.ts from flat pending/processed list into sub-view switching component with checkbox multi-select, batch action bar, execute-after-approve toggle, unified batch confirmation dialog, and execution result display in processed tab.**

## Performance

- **Duration:** 8 min
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- Added ApprovalEvent interface and sub-view switching infrastructure (view state + openDetail/backToList helpers)
- Added checkbox multi-select with Set<number> state, toggle/selectAll/clear methods
- Implemented batch action bar that auto-shows when items selected (count label + approve/reject buttons)
- Added execute-after-approve checkbox per pending card (opt-out, default checked)
- Implemented unified batch confirmation dialog with notes textarea, overlay click dismiss, and Escape key dismissal (both document listener + @keydown)
- Confirmation sends POST /api/approval/batch-review with ids, action, notes, execute_ids
- Processed tab shows execution result inline (duration, row count, rows affected)
- Removed obsolete per-row rejectNotes/actionLoading state and inline textarea

## Task Commits

Each task was committed atomically:

1. **Task 1: Component restructure** - `038a047c9b` (feat: restructure with sub-view switching, multi-select, Escape key handling)
2. **Task 2: renderList implementation** - `e3d077e0e1` (feat: renderList with batch bar, execute checkbox, batch dialog, execution results)

## Files Modified
- `frontend/src/openclaw/ui/views/approval-dashboard.ts` - Full rewrite from 121 lines to 347 lines. Added sub-view switching, checkbox multi-select, batch bar, execute-after-approve toggle, batch dialog, execution result display

## Decisions Made
- Used single `_openBatchDialog` function for both batch and single-item approve/reject to avoid code duplication
- Escape key handled at two levels: `document.addEventListener('keydown', _handleEscapeKey)` added on dialog open and removed on close, plus `@keydown` on modal-overlay element for UI-SPEC compliance
- Batch action bar uses animation `fade-in 0.2s ease` for smooth appearance when selection changes
- `_renderExecResult` display shows both duration and row count from execution_result data

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- List view fully functional with batch operations, execute toggle, and processed tab results
- renderDetail placeholder ready for Plan 87-04 to implement full detail view with event timeline
- All existing interfaces and data flow maintained - no breaking changes

---

*Phase: 87-approval-enhancement*
*Completed: 2026-05-11*
