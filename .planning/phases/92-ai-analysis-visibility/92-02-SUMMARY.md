---
phase: 92-ai-analysis-visibility
plan: 02
subsystem: ui
tags: [lit, web-components, marked, xss-sanitization, markdown]
requires:
  - phase: 92-ai-analysis-visibility
    plan: 01
    provides: UI contract and design decisions (D-07 through D-10)
provides:
  - Data-driven <ai-analysis-result> Lit Web Component with @property() interface
  - XSS sanitization for LLM-generated Markdown output
  - 6 render states (loading, running, failed, completed+null, completed+Markdown, completed+JSON)
  - Trigger source tag (auto/manual) with UI-SPEC color tokens
affects: [92-03, 92-04, 92-05]

tech-stack:
  added: []
  patterns: ["Data-driven Lit Web Component with @property() decorators", "XSS sanitization via regex stripping of script/iframe/on* before innerHTML"]

key-files:
  created: []
  modified:
    - frontend/src/openclaw/ui/views/ai-analysis-result.ts

key-decisions:
  - "Removed self-contained API/polling logic per D-07 — component now accepts all data via @property()"
  - "Sanitization uses regex-based approach (matching esc() pattern from instance-detail.ts) — no DOMPurify dependency needed"
  - "Null-safe numeric handling uses `value != null ? String(value) : '0'` pattern per Research Pitfall 5"

patterns-established:
  - "Presentational Lit components accept data via @property() only, never call APIs internally"
  - "Markdown output from Agent is sanitized before innerHTML assignment to prevent XSS"

requirements-completed: ["AI-01"]

duration: 3min
completed: 2026-05-14
---

# Phase 92 Plan 02: AI Analysis Result Component Refactor Summary

**Refactored ai-analysis-result.ts from self-contained analysis launcher to data-driven presentational component with XSS sanitization, 6 render states, and trigger source tags**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-14T08:37:00Z
- **Completed:** 2026-05-14T08:40:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Converted `@state()` decorators to `@property()` for all 7 public inputs (`result`, `analysisType`, `triggerType`, `loading`, `status`, `errorMessage`, `title`)
- Removed component-owned API calls (`API_BASE`, `getToken()`, `startAnalysis()`, `_startPolling()`, `_stopPolling()`, polling logic) per D-07
- Fixed "slide_token" bug (Research Pitfall 2) — token key now absent since component no longer manages auth
- Added `sanitize()` function for XSS prevention stripping `<script>`, `<iframe>`, and `on*` event handlers from LLM-generated Markdown
- Implemented 6 render states: loading spinner, running pulse, failed error card, completed+null empty state, completed+Markdown (via `marked.parse`), completed+JSON (backward compat)
- Added trigger source tag pills ("自动分析" for auto, "手动分析" for manual) with UI-SPEC color tokens
- Added complete Markdown rendering CSS: table borders/headers, code blocks with monospace font, heading hierarchy, blockquote styling
- Added null-safe numeric handling in JSON backward-compat renderer

## Task Commits

Each task was committed atomically:

1. **Task 1: Refactor ai-analysis-result.ts to data-driven component** - `611ac4da72e` (feat)

**Plan metadata:** Will be committed after this SUMMARY is created.

## Files Created/Modified

- `frontend/src/openclaw/ui/views/ai-analysis-result.ts` - Refactored from API-driven to data-driven Lit Web Component; 171 insertions, 115 deletions

## Decisions Made

- **Data-driven architecture**: The component no longer manages API calls, polling, or token storage. All data flows in via Lit `@property()` decorators, allowing parent components (alerts.ts, instance-detail.ts) to control data fetching
- **Regex-based XSS sanitization**: Matches the `esc()` pattern from `instance-detail.ts`. Avoids adding DOMPurify as a project dependency. Strips `<script>`, `<iframe>`, and `on*` event handlers from `marked.parse()` output before setting innerHTML
- **Null-safe numeric formatting**: Uses `value != null ? String(value) : "0"` in the JSON backward-compat renderer to prevent crashes from null/undefined numeric fields (Research Pitfall 5)
- **Trigger source tag styling**: Follows UI-SPEC color contract exactly — `--accent-subtle`/`--accent` for auto, `--info-subtle`/`--info` for manual

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - single-file refactor with clean verification.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The refactored `ai-analysis-result.ts` component is ready for Plan 03 (alert list analysis integration) and Plan 04 (instance detail diagnosis section), which will wire the component into their parent views and provide data via Lit properties
- No blocking issues identified

---
*Phase: 92-ai-analysis-visibility*
*Completed: 2026-05-14*
