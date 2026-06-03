---
phase: 111
plan: 04
subsystem: frontend
tags: [gateway-simplify, placeholder-pages, dead-code-removal]
depends_on: []
provides: [simplified-app-render, cleaned-chat-imports]
affects: [app-render.ts, app-render-usage-tab.ts, app-chat.ts, app.ts]
tech-stack:
  added: []
  patterns:
    - Inline html placeholders for DirectAdapter-mode tabs
    - No-op callbacks for deleted controller references
key-files:
  created:
    - frontend/src/openclaw/ui/views/unavailable-page.ts
  modified:
    - frontend/src/openclaw/ui/views/usage.ts
    - frontend/src/openclaw/ui/views/cron.ts
    - frontend/src/openclaw/ui/views/config.ts
    - frontend/src/openclaw/ui/views/skills.ts
    - frontend/src/openclaw/ui/views/exec-approval.ts
    - frontend/src/openclaw/ui/views/agents-panels-tools-skills.ts
    - frontend/src/openclaw/ui/views/agents-panels-status-files.ts
    - frontend/src/openclaw/ui/app-render-usage-tab.ts
    - frontend/src/openclaw/ui/app-render.ts
    - frontend/src/openclaw/ui/app-chat.ts
    - frontend/src/openclaw/ui/app.ts
decisions:
  - Use reusable renderUnavailablePage() template for all placeholder views
  - Use inline html placeholders in app-render.ts (not lazy views) for simplicity
  - Keep loadAgents, saveAgentsConfig, loadChatHistory, loadSessions controller imports
  - Keep agents tab with no-op callbacks (not fully removed) for structure preservation
metrics:
  duration: ~2 sessions (partial continuation)
  files-created: 1
  files-modified: 10
  lines-removed: ~1165
---

# Phase 111 Plan 04: Gateway Simplify — Placeholder Views & Import Cleanup

Replace 7 UI view files + app-render-usage-tab with DirectAdapter-mode placeholders, clean app-render.ts of dead controller imports and tab rendering, and remove abortChatRun from chat files.

## Tasks Completed

### Task 1: Create placeholder views
- Created `views/unavailable-page.ts` with reusable `renderUnavailablePage()` template
- Replaced 7 view files to delegate to `renderUnavailablePage()`:
  - `views/usage.ts`, `views/cron.ts`, `views/config.ts`, `views/skills.ts`
  - `views/exec-approval.ts`, `views/agents-panels-tools-skills.ts`, `views/agents-panels-status-files.ts`
- **Commit:** `bd47c365102`

### Task 2: Clean app-render.ts and app-render-usage-tab.ts
- Removed imports from 8 deleted controllers (agent-files, agent-identity, agent-skills, config, cron, exec-approvals, sessions checkpoint, skills)
- Kept only `loadAgents`, `saveAgentsConfig`, `loadChatHistory`, `loadSessions` from controllers
- Removed lazy cron/skills view modules and 200+ lines of dead constants/helpers
- Replaced usage, cron, skills, config tabs with inline html "暂不可用" placeholders
- Simplified sessions tab (checkpoint/patch/delete callbacks to no-ops)
- Made agents tab callbacks no-ops (kept state.agentsSelectedId/agentsPanel assignments)
- app-render-usage-tab.ts: replaced with `return nothing` stub
- **Commit:** `57fe850bf57` (1735 -> 888 lines, -847 lines)

### Task 3: Clean app-chat.ts and app.ts
- Removed `abortChatRun` import from app-chat.ts (was from controllers/chat.ts)
- Made `handleAbortChat()` a no-op (clears chat message only)
- Removed `handleAbortChat` import alias from app.ts
- Made `handleAbortChat()` method in app.ts a no-op
- **Commit:** `5a46c6354e7`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2] Dead function references after import removal**
- **Found during:** Task 2
- **Issue:** After removing config.ts imports, `findAgentIndex`, `ensureAgentIndex`, and `resolveAgentToolsPath` still referenced `findAgentConfigEntryIndex` and `ensureAgentConfigEntry` which were no longer imported
- **Fix:** Simplified `resolveAgentToolsPath` to return null; removed `findAgentIndex` and `ensureAgentIndex`
- **Files modified:** `app-render.ts`

**2. [Rule 2] Dead query/selection state cleanup in helper functions**
- **Found during:** Task 2
- **Issue:** `loadAgentPanelDataForSelectedAgent`, `refreshAgentsPanelSupplementalData`, and `resetAgentSelectionPanelState` referenced deleted controller functions (`loadAgentFiles`, `loadAgentSkills`, `loadToolsCatalog`, `loadChannels`, `resetToolsEffectiveState`)
- **Fix:** Simplified all four functions to no-ops or return-early stubs
- **Files modified:** `app-render.ts`

## Verification

- [x] All 7 placeholder view files contain "暂不可用" string
- [x] No dead controller imports remain in app-render.ts
- [x] No `abortChatRun` references in app-chat.ts
- [x] app-render.ts reduced from 1735 to 888 lines
- [x] All 3 tasks committed individually

## Self-Check: PASSED
