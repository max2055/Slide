---
phase: 120-ui
plan: 04
subsystem: ui
tags: [lit, web-components, god-component-split, alerts, refactor]
requires:
  - phase: 120-ui
    plan: 02
    provides: app-dialog, app-form-field, app-toast-container
  - phase: 120-ui
    plan: 03
    provides: app-card, app-data-table, app-empty-state, app-badge
provides:
  - alert-list component (list table with app-badge for severity/status)
  - alert-detail-modal component (detail view in app-dialog with AI analysis)
  - alert-rule-editor component (rule form in app-dialog with app-form-field)
  - alert-analysis-viewer component (AI analysis results in app-dialog)
  - Refactored alerts.ts orchestrator
affects:
  - 120-ui plan 06 (remaining god component splits using same patterns)
tech-stack:
  added: []
  patterns:
    - Feature subcomponent pattern (shadow DOM, event-driven communication)
    - God component extraction: move rendering to subcomponents, keep data fetching + state in orchestrator
    - Component-to-orchestrator communication via CustomEvents with `bubbles: true, composed: true`
    - Shared component adoption: app-badge replaces severity-badge/status-badge/alert-status-badge; app-dialog replaces hand-rolled modals; app-form-field replaces form inputs
key-files:
  created:
    - frontend/src/app/ui/components/alert-list.ts
    - frontend/src/app/ui/components/alert-detail-modal.ts
    - frontend/src/app/ui/components/alert-rule-editor.ts
    - frontend/src/app/ui/components/alert-analysis-viewer.ts
  modified:
    - frontend/src/app/ui/views/alerts.ts
key-decisions:
  - D-18: alerts.ts split into 4 subcomponents per the plan's functional boundaries
  - D-21: Each subcomponent <300 lines, alerts.ts reduced by ~800 lines
  - Subcomponents use Shadow DOM (matching existing component pattern) rather than Light DOM
  - Event-driven communication: subcomponents emit CustomEvents, orchestrator handles data operations
  - alert-rule-editor validates locally and emits save event — orchestrator handles API errors via error property
  - app-badge replaces .severity-badge, .status-badge-sm, .alert-status-badge, .alert-status-dot CSS classes
requirements-completed: [UI-OPT-01]
duration: ~30min
completed: 2026-06-18
---

# Phase 120 Plan 04: Split alerts.ts Summary

**Split the alerts.ts god component (2805 lines) into 4 focused subcomponents with proper event-driven communication, reducing alerts.ts by ~800 lines. Uses shared component library (app-dialog, app-badge, app-form-field).**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-06-18
- **Completed:** 2026-06-18
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- **alert-list (249 lines)** — Extracted alert table rendering with severity/status badges via `<app-badge>`, pagination, filter/search toolbar, empty state, and analysis status badges. Communicates via 11 custom events (alert-select, alert-acknowledge, alert-rca, alert-navigate-instance, alert-navigate-chat, alert-create, alert-filter-severity, alert-search, alert-refresh, alert-page-change, alert-list-tab-change).

- **alert-detail-modal (182 lines)** — Extracted alert detail view with timeline, metadata grid, AI analysis section, and analysis history. Uses `<app-dialog size="lg">` instead of hand-rolled modal overlay. Uses `<app-badge>` for severity and status indicators.

- **alert-rule-editor (228 lines)** — Extracted rule create/edit form with local validation (name, thresholds), `<app-dialog size="lg">` wrapper, and `<app-form-field>` for structured inputs. Manages form state internally, emits `save` event with validated body. Parent handles API call via `_onRuleSave` event handler.

- **alert-analysis-viewer (81 lines)** — Extracted AI analysis result modal with `<app-dialog size="xl">`, alert metadata display, and `<ai-analysis-result>` for completed results. Handles failed/empty/completed states.

- **alerts.ts (1967 lines, from 2805)** — Refactored as orchestrator: removed ~800 lines of template rendering, inline modals, badge rendering helpers, and unused CSS classes. Keeps all data fetching (loadAlerts, loadRules, etc.), state management, CRUD methods (escalation, maintenance, silence, baselines), RCA polling, and event wiring. The remaining tabs (rules table, escalation, maintenance, silence, baselines) with their CRUD and inline modals stay in the orchestrator.

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract alert-list + alert-detail-modal** — `c699da3` (feat)
2. **Task 2: Extract alert-rule-editor + alert-analysis-viewer** — `d6bd11f` (feat)
3. **Task 3: Refactor alerts.ts orchestrator** — `e78697e` (refactor)

## Files Created

- `frontend/src/app/ui/components/alert-list.ts` — Alert list table with filtering, pagination, severity/status badges
- `frontend/src/app/ui/components/alert-detail-modal.ts` — Alert detail in app-dialog with timeline, AI analysis, history
- `frontend/src/app/ui/components/alert-rule-editor.ts` — Rule create/edit form in app-dialog with local validation
- `frontend/src/app/ui/components/alert-analysis-viewer.ts` — AI analysis result viewer in app-dialog

## Decisions Made

- **Shadow DOM for feature subcomponents** — Unlike shared components (app-* which use Light DOM per D-09), feature subcomponents (alert-list, etc.) use Shadow DOM to match the existing AlertsPage pattern and avoid style leakage.
- **Event-driven communication** — Subcomponents emit typed CustomEvents (`@alert-select`, etc.) with `bubbles: true, composed: true`. The orchestrator event handler receives the event and calls the appropriate CRUD/data-fetching method. This keeps subcomponents stateless and testable.
- **alert-rule-editor error propagation** — Validates name/metric/thresholds locally, emits `save` with body; orchestrator calls API. On API failure, orchestrator sets `.error` property on the editor, which displays it inline. User edits clear the error.
- **app-badge adoption** — Replaced `.severity-badge` (CSS classes red/orange/blue) and `.alert-status-badge`/`.alert-status-dot` (CSS classes unread/read/acknowledged/resolved/closed) with `<app-badge variant="danger|warn|info|muted|ok">`.

## Deviations from Plan

### Task 3: alerts.ts line count (1967 vs target 700)

The plan's target of 700 lines for alerts.ts was not achievable because the remaining 5 tabs (rules table, escalation, maintenance, silence, baselines) with their CRUD methods and inline form modals were not included in the extraction scope. These tabs account for ~1500 lines of code and CSS that remain in the orchestrator. The 4 specified subcomponents were successfully extracted, and alerts.ts was reduced by ~800 lines (29% reduction). A future plan could extract these remaining tabs into additional subcomponents.

## Issues Encountered

- **Import path resolution** — The original alerts.ts imported `ai-analysis-result` from the same `views/` directory (`./ai-analysis-result.js`), but alert-analysis-viewer.ts is in `components/`, requiring `../views/ai-analysis-result.js`. Similarly, stat-card import path needed adjustment for the subcomponent's directory location.
- **Removed helper methods still referenced** — `_severityLabel()` was removed during extraction but is still used by `_renderRules` and `_renderEscalation`. Re-added during the refactoring pass. Helper methods `_cleanTitle`, `_typeLabel`, and `_formatTime` were confirmed to be only used by extracted code and safely removed.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: event-data-flow | alert-rule-editor.ts | `save` event carries validated AlertRule body to parent. Parent validates again before API call per T-120-01. |

## Next Phase Readiness

- Pattern established for extracting god components into event-driven subcomponents
- Remaining tabs (escalation, maintenance, silence, baselines) are candidates for future extraction
- Shared components (app-dialog, app-badge, app-form-field) are proven to work in real feature code
- Template for future extractions: event property names, error property pattern for dialogs

---

*Phase: 120-ui*
*Completed: 2026-06-18*
