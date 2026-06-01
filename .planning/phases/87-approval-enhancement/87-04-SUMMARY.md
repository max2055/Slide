---
phase: 87-approval-enhancement
plan: 04
subsystem: ui
tags: lit, web-components, approval-dashboard, codemirror, detail-view, event-timeline
requires:
  - phase: 87-02
    provides: Enriched GET /api/approval/:id with instance_name, db_type; GET /api/approval/:id/events
  - phase: 87-03
    provides: Approval sub-view switching infrastructure (view state, openDetail/backToList, renderDetail placeholder)
provides:
  - Detail sub-view with CodeMirror 6 read-only SQL editor (syntax highlighting, dialect selection from db_type)
  - Meta card showing instance name (from enriched API), submitter, time, risk level, status
  - Approval event history timeline with color-coded event dots
affects: []

tech-stack:
  added: []
  patterns:
    - CodeMirror 6 read-only EditorView with dialect switching (MySQL/PostgreSQL based on instance db_type)
    - Parallel fetch of detail + events in _loadDetail
    - EditorView lifecycle: mount after updateComplete, destroy on backToList
    - Timeline rendering with staggered fade-in animation and color-coded dot classes

key-files:
  modified:
    - frontend/src/openclaw/ui/views/approval-dashboard.ts

key-decisions:
  - "CodeMirror dialect selected based on db_type from enriched API: MySQL for 'mysql'/'mariadb', PostgreSQL for 'postgresql'"
  - "Events fetched in parallel with detail data via Promise.all"
  - "_mountCodeMirror called after await this.updateComplete to ensure DOM container exists"
  - "backToList triggers _destroyCodeMirror, resets events/detailError/detailLoading states"
  - "Retry button in error state re-invokes _loadDetail with same request ID"

patterns-established:
  - "detail-split CSS Grid layout with 1fr 360px columns and 32px gap"
  - "Timeline pseudo-element vertical line with absolute positioning"
  - "Event type color mapping: submitted/notified=accent, ai_reviewed=warn, approved/executed=ok, rejected/execution_failed=destructive"

requirements-completed: [APPR-01, APPR-02]

duration: 5min
completed: 2026-05-11
---

# Phase 87 Plan 04: Approval Dashboard Detail View with CodeMirror Editor and Event Timeline

**Implemented full approval detail sub-view with CodeMirror 6 read-only SQL editor (dialect from db_type), metadata card showing instance name from enriched API, and color-coded event history timeline.**

## Performance

- **Duration:** 5 min
- **Tasks:** 1
- **Files modified:** 1
- **File growth:** 347 lines -> 523 lines (+176 lines)

## Accomplishments
- Added CodeMirror 6 imports (`EditorView`, `EditorState`, `sql`, `MySQL`, `PostgreSQL`, `oneDark`, `lineNumbers`)
- Added state variables for detail view: `events`, `detailLoading`, `detailError`
- Added `_codeMirrorView` and `_codeMirrorContainer` class fields for EditorView lifecycle tracking
- Added CSS styles for detail-split grid layout (1fr + 360px columns, 32px gap), meta-card, timeline card, loading/error states, color-coded timeline dots
- Implemented `renderDetail()` with left-right split layout:
  - Left panel: CodeMirror 6 read-only SQL editor with line numbers, syntax highlighting, oneDark theme, `EditorView.editable.of(false)` (T-87-11 mitigation)
  - Right panel: meta card (instance name from enriched API, submitter, submit time, risk level badge, status) + timeline card
- Implemented `_mountCodeMirror()` with dialect switching: PostgreSQL for 'postgresql', MySQL for default (covers 'mysql', 'mariadb') (D-03 checker compliance)
- Implemented `_destroyCodeMirror()` for cleanup on backToList (T-87-12 mitigation), called `EditorView.destroy()` to remove DOM + listeners
- Implemented `_loadDetail()` with parallel fetch of detail + events via `Promise.all`
  - On success: updates `selectedRequest`, mounts CodeMirror after `await this.updateComplete`
  - On error: shows "加载失败，请重试" with retry button
- Modified `openDetail()` to trigger `_loadDetail(request.id)`
- Modified `backToList()` to clean up CodeMirror, reset all detail state
- Added helper methods: `_statusLabel` (zh-CN status labels), `_eventLabel` (zh-CN event type labels), `_eventDetail` (event-type-specific detail formatting)

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement renderDetail with CodeMirror, meta card, timeline** - `7ee0b11f58`

## Files Modified
- `frontend/src/openclaw/ui/views/approval-dashboard.ts` - 347 lines to 523 lines (+176). Added CodeMirror imports/state/fields, detail view CSS, renderDetail implementation, _mountCodeMirror/_destroyCodeMirror, _loadDetail, helper methods.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Verification Results

| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| EditorView references | >= 3 | 5 | PASS |
| _mountCodeMirror references | >= 1 | 2 (def + call) | PASS |
| _destroyCodeMirror references | >= 2 | 4 | PASS |
| _loadDetail references | >= 1 | 3 (def + call x2) | PASS |
| _eventLabel references | >= 1 | 2 | PASS |
| _eventDetail references | >= 1 | 2 | PASS |
| "detail-split" occurrences | >= 2 | 2 (CSS + HTML) | PASS |
| "timeline-list" occurrences | >= 2 | 3 (CSS + HTML) | PASS |
| "cm-container" references | >= 1 | 2 (template + mount call) | PASS |
| "审批历程" header | >= 1 | 1 | PASS |
| "基本信息" header | >= 1 | 1 | PASS |
| loadRequests preserved | >= 1 | 5 | PASS |
| instance_name (D-03) | >= 1 | 1 (meta card) | PASS |
| db_type (checker fix) | >= 1 | 1 (dialect selection) | PASS |
| PostgreSQL (checker fix) | >= 1 | 2 (import + dialect switch) | PASS |
| File min_lines | >= 400 | 523 | PASS |

## Threat Model Compliance

| Threat ID | Category | Disposition | Status |
|-----------|----------|-------------|--------|
| T-87-11 | Tampering | mitigate - `EditorView.editable.of(false)` | VERIFIED |
| T-87-12 | Memory Leak | mitigate - `_destroyCodeMirror()` on backToList and _loadDetail | VERIFIED |
| T-87-13 | Info Disclosure | accept - intentional for approver review | ACKNOWLEDGED |

## Known Stubs

None.

## Next Phase Readiness
- Detail sub-view fully functional with CodeMirror 6 read-only SQL editor, meta card, and event timeline
- All state properly cleaned up on navigation back to list view
- CodeMirror EditorView lifecycle correctly managed with mount/destroy
- No further phases planned for approval-enhancement subsystem

---

*Phase: 87-approval-enhancement*
*Completed: 2026-05-11*
