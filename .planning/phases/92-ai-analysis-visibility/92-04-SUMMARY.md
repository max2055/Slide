---
phase: 92-ai-analysis-visibility
plan: 04
subsystem: ui
tags: [lit, web-components, alerts, ai-analysis, config-panel, modal]
requires:
  - phase: 92-02
    provides: AI analysis API endpoints (/api/ai/analysis, /api/ai/config)
  - phase: 92-03
    provides: ai-analysis-result Web Component
provides:
  - Analysis status badges in alert list table (completed/running/failed/no-analysis)
  - Clickable badges open result modal with ai-analysis-result component
  - Auto-analysis config panel with toggle, cron, severity, whitelist, time window
  - Settings button in alert list toolbar
affects: [92-05]

tech-stack:
  added: []
  patterns:
    - Analysis status badge with 4-state rendering via _renderAnalysisBadge()
    - Config panel modal with CRUD operations via PUT /api/ai/config
    - Modal close on X, backdrop click, and ESC key

key-files:
  created:
    - frontend/src/openclaw/ui/views/alerts.ts (updated)
  modified:
    - frontend/src/openclaw/ui/views/alerts.ts

key-decisions:
  - "Config panel rendered as modal from alerts.ts toolbar instead of separate page (aligned with D-15/D-16)"
  - "Status badge component is inline method (_renderAnalysisBadge) not separate Web Component (avoids over-abstraction for 4 states)"

patterns-established:
  - "Analysis badge states: green pill (#22c55e) for completed, violet pill (#d2befc) for running, violet-danger pill (#b08df5) for failed, muted em dash for none"
  - "Config panel saves via PUT /api/ai/config with inline success/error feedback"

requirements-completed: ["AI-01"]
---

# Phase 92 Plan 04: Analysis Badges, Result Modal, Config Panel Summary

**Status badges, clickable result modals, and auto-analysis config panel integrated into alert list page**

## Performance

- **Duration:** 12 min
- **Started:** 2026-05-14T09:00:00Z
- **Completed:** 2026-05-14T09:12:00Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments

- Replaced boolean `analyzedAlertIds` Set with rich `analyzedStatuses` Map storing status, trigger_type, and result
- Added `_renderAnalysisBadge()` with 4 visual states: green pill (已分析), violet pill (分析中), violet-danger pill (分析失败), muted em dash
- Completed and failed badges are clickable, opening the analysis result modal
- Added `_renderAnalysisResultModal()` using the `ai-analysis-result` Web Component at 720px wide
- Added auto-analysis config panel modal with toggle, cron expression, severity filters, instance whitelist, and time window
- Config panel saves via PUT /api/ai/config with inline success/error feedback
- Added settings button to alert list toolbar
- Added `console.warn('[Alerts] _loadAnalyzedStatuses failed:', err)` error logging per D-12
- Added CSS for `.analysis-badge` variants with UI-SPEC specified colors

## Task Commits

1. **Task 1 + Task 2: Analysis status badges, result modal, config panel** - `5c58d74b4e3` (feat)

## Files Modified

- `frontend/src/openclaw/ui/views/alerts.ts` - Core changes: status badges, result modal integration, config panel with all form fields, CSS for badge and config styling (expanded from 2338 to 2780 lines)

## Decisions Made

- Combined Task 1 and Task 2 into a single commit since both modify the same file with intertwined changes (state variables, methods, CSS)
- `_renderAnalysisBadge()` checks both the active running analysis (`activeRCAAnalysis`) and stored records (`analyzedStatuses`) for comprehensive state coverage
- Config panel uses map-render pattern for severity checkboxes and tag pills for whitelist, consistent with existing alerts.ts form patterns

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Worktree was checked out from OpenClaw upstream commit missing Slide project's `frontend/` directory tree. Restored `alerts.ts` and `icons.ts` from `slide-custom` branch before editing.
- Both tasks modify the same single file with overlapping changes (Task 1's `activeAnalysisRecord` state is consumed by Task 2's result modal). Combined into one commit rather than creating an empty second commit.

## Stub Tracking

- `_renderAnalysisResultModal()` renders `<ai-analysis-result>` component with result/analysisType/triggerType/status/title properties. The component expects external data per D-07 refactoring plan.
- Badge method `_renderAnalysisBadge()` uses `this.analyzedStatuses.get(alertId)` which depends on `_loadAnalyzedStatuses()` API response format. Polling-based status updates are not implemented here (handled by parent's existing `_startDiagnosisPolling`).

## Threat Flags

None - no new network endpoints, auth paths, or trust boundary changes introduced. Config panel (`_saveConfig`) calls PUT /api/ai/config which is server-side validated per mitigation T-92-06.

## Self-Check

- [x] `analyzedStatuses` Map replaces `analyzedAlertIds` Set
- [x] `_loadAnalyzedStatuses` has `console.warn` in catch block
- [x] `.analysis-badge` CSS with UI-SPEC colors (completed=#22c55e, running=#d2befc, failed=#b08df5)
- [x] `_renderAnalysisBadge()` exists with 4 badge states
- [x] Completed/failed badges clickable via `_openAnalysisResult()`
- [x] `_renderAnalysisResultModal()` uses `<ai-analysis-result>` component
- [x] Config panel with all 5 form fields (toggle, cron, severity, whitelist, time window)
- [x] Settings button in toolbar
- [x] Save calls PUT /api/ai/config
- [x] Modal closes on X and backdrop click

## Verification

- grep verified: analyzedStatuses Map, console.warn in load function, badge CSS classes, ai-analysis-result component, showConfigPanel/configForm/activeAnalysisRecord state, /api/ai/config reference

## Next Phase Readiness

- Alert list now has full analysis status visibility (badges, modals)
- Config panel wired to backend PUT endpoint
- Ready for 92-05 (instance detail diagnosis history) or other phase 93 work

---

*Phase: 92-ai-analysis-visibility*
*Completed: 2026-05-14*
