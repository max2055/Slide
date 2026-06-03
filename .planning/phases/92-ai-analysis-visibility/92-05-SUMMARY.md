---
phase: 92-ai-analysis-visibility
plan: 05
subsystem: ui
tags: [lit, web-components, ai, diagnosis, modal]
requires:
  - phase: 92-02
    provides: Refactored ai-analysis-result component with data-driven properties
  - phase: 92-03
    provides: Recent analysis API endpoint GET /api/ai/analysis/recent
provides:
  - Diagnosis history section in instance detail page showing 5 most recent summaries
  - Simplified _renderDiagnosisCard() using ai-analysis-result component
  - Modal view for full Markdown diagnosis results
affects: [92-continued, 93-ai-agent-ops-assistant]
tech-stack:
  added: []
  patterns:
    - Parent-child pattern: instance-detail.ts passes data to ai-analysis-result component via Lit properties
    - Modal overlay for analysis result display (720px wide)
    - History list with status badges + truncated summaries + chevron navigation
key-files:
  created: []
  modified:
    - frontend/src/openclaw/ui/views/instance-detail.ts
key-decisions:
  - "Parent instance-detail.ts controls visibility of diagnosis card (showDiagnosisResult/diagnosisStatus) and passes data to ai-analysis-result as Lit properties"
  - "loadDiagnosisHistory() called on instance load AND after diagnosis polling completes to refresh the summary list"
  - "Close button placed below ai-analysis-result component (not inside it) for the inline diagnosis card context"
  - "Modal uses backdrop click + ESC key + X button for dismissal, consistent with existing alerts.ts pattern"
requirements-completed: ["AI-01"]
duration: 12min
completed: 2026-05-14
---

# Phase 92 Plan 05: Instance Detail Diagnosis History Summary

**Diagnosis history section with recent 5 summaries and refactored diagnosis card using ai-analysis-result component**

## Performance

- **Duration:** 12 min
- **Started:** 2026-05-14T... (after worktree setup)
- **Completed:** 2026-05-14
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- Added diagnosis history card showing up to 5 recent diagnosis summaries with status badges, relative time, truncated text, and chevron navigation
- Added modal (720px wide) with ai-analysis-result component for viewing full Markdown results from history items
- Refactored _renderDiagnosisCard() to use ai-analysis-result component instead of custom JSON rendering (esc(), renderSection, sections array removed)
- Preserved existing diagnosis polling logic (_startDiagnosis, _startDiagnosisPolling, _stopDiagnosisPolling)
- Wired loadDiagnosisHistory() on instance load and after diagnosis completion to auto-refresh the list
- Added CSS for diagnosis-history-item, modal-overlay, modal, and .status-badge.accent for running status

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1+2 | Diagnosis history + refactored card | cd69db64399 | instance-detail.ts |

**Plan metadata commit:** (pending - final commit after SUMMARY.md)

## Files Modified
- `frontend/src/openclaw/ui/views/instance-detail.ts` - 292 insertions, 72 deletions; added diagnosis history section, modal, and refactored diagnosis card

## Decisions Made
- Used parent visibility control (_startDiagnosis / _renderDiagnosisCard) rather than ai-analysis-result managing its own lifecycle -- the component is purely presentational per D-07
- Close button placed below ai-analysis-result in the inline card context (diagnosis card), not inside the component
- Modal for history items includes ai-analysis-result component with full result properties (result, analysisType, triggerType, status, errorMessage, title)
- loadDiagnosisHistory() loads on initial load and refreshes after polling completes, ensuring new diagnoses appear in the history list

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Instance detail page shows diagnosis history card above tabs with up to 5 recent summaries
- One-click diagnosis result renders via ai-analysis-result component with proper Markdown rendering
- New diagnoses auto-refresh the history list when polling completes
- Modal provides full Markdown view with proper XSS sanitization via ai-analysis-result

---
*Phase: 92-ai-analysis-visibility*
*Completed: 2026-05-14*
