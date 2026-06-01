---
phase: 112-frontend-cleanup-cron
plan: 01
subsystem: ui
tags: [frontend, cleanup, rename, i18n, vite, lit, web-components]

requires: []
provides:
  - Renamed openclaw/ directory to app/ with updated all imports and Vite aliases
  - Deleted 24+ dead placeholder views, protocol/ directory, and app-gateway.ts
  - Clean navigation.ts and app-render.ts with no dead tab references
  - Clean i18n locale files with no dead Gateway/navigation translation keys
  - initChatClient moved from deleted app-gateway.ts to direct-gateway.ts
  - Local type stubs replace deleted protocol imports in slash-commands.ts
affects: [112-02, 112-03]

tech-stack:
  added: []
  patterns:
    - initChatClient orchestration lives in direct-gateway.ts alongside DirectGatewayClient

key-files:
  created: []
  modified:
    - frontend/src/main.ts (import paths)
    - frontend/vite.config.js (aliases)
    - frontend/src/app/ui/navigation.ts (tab cleanup)
    - frontend/src/app/ui/app-render.ts (placeholder cleanup)
    - frontend/src/app/ui/app.ts (import path)
    - frontend/src/app/ui/app-lifecycle.ts (import path)
    - frontend/src/app/ui/direct-gateway.ts (added initChatClient)
    - frontend/src/app/ui/chat/slash-commands.ts (type stubs)
    - frontend/src/app/ui/views/agents-panels-tools-skills.ts (inlined unavailable page)
    - frontend/src/app/ui/views/agents-panels-status-files.ts (inlined unavailable page)
    - 13 i18n locale files (dead key removal)

key-decisions:
  - "initChatClient moved to direct-gateway.ts rather than creating a new file (keeps all WS initialization in one module)"
  - "Legacy @openclaw aliases removed after Task 2 confirmed no remaining consumers"

requirements-completed: []

duration: 12min
completed: 2026-05-27
---

# Phase 112 Plan 01: Frontend Cleanup Summary

**Renamed openclaw/ to app/, deleted 48 dead files (protocol/ + app-gateway.ts + 24 placeholder views + 23 protocol schema files), updated all consumers, cleaned 13 i18n locale files**

## Performance

- **Duration:** 12 min
- **Started:** 2026-05-27T02:51:01Z
- **Completed:** 2026-05-27T03:03:00Z
- **Tasks:** 3
- **Files modified:** ~60 (including 23 deletions)

## Accomplishments
- Renamed `frontend/src/openclaw/` to `frontend/src/app/` using `git mv` (preserving git history for all 680 files)
- Deleted `protocol/` directory (23 Gateway schema files), `app-gateway.ts` (292 lines), and 24+ placeholder view files (overview*, usage*, cron, skills*, config*, exec-approval, unavailable-page)
- Moved `initChatClient` function from deleted `app-gateway.ts` into `direct-gateway.ts` (both app.ts and app-lifecycle.ts already imported from there)
- Cleaned `navigation.ts`: removed overview/usage/cron/skills tabs, added `cron-jobs` to settings group
- Cleaned `app-render.ts`: removed all placeholder renders for deleted tabs
- Updated Vite aliases: `@openclaw/src` -> `@slide/app/src`, `@openclaw/ui` -> `@slide/app/ui`, removed `@openclaw/protocol`
- Removed dead i18n translation keys (tabs/subtitles for 5 dead tabs, plus overview/usage/cron namespaces) from all 13 locale files
- Replaced protocol import in `slash-commands.ts` with local type stubs

## Task Commits

1. **Task 1: Rename openclaw/ to app/ + update all import paths** - `21959563e76` (feat)
2. **Task 2: Delete dead files + update consumers (navigation, rendering, lifecycle)** - `f612fe5149a` (feat)
3. **Task 3: Clean i18n locale files + slash-commands protocol import** - `5ec383c6e9e` (feat)

## Files Created/Modified
- `frontend/src/main.ts` - Updated import paths from `./openclaw/` to `./app/`
- `frontend/vite.config.js` - Added `@slide/app/src` and `@slide/app/ui` aliases, removed `@openclaw/protocol`
- `frontend/src/app/ui/navigation.ts` - Removed overview/usage/cron/skills tabs, added cron-jobs to settings group
- `frontend/src/app/ui/app-render.ts` - Removed renderOverview import, removed all placeholder renders for deleted tabs
- `frontend/src/app/ui/app.ts` - Changed initChatClient import from app-gateway.ts to direct-gateway.ts
- `frontend/src/app/ui/app-lifecycle.ts` - Same import change
- `frontend/src/app/ui/direct-gateway.ts` - Added initChatClient function (all event mapping and orchestration from deleted app-gateway.ts)
- `frontend/src/app/ui/chat/slash-commands.ts` - Replaced `@slide/app/src/protocol` import with local CommandEntry/CommandsListResult type stubs
- `frontend/src/app/ui/views/agents-panels-tools-skills.ts` - Inlined renderUnavailablePage function
- `frontend/src/app/ui/views/agents-panels-status-files.ts` - Inlined renderUnavailablePage function
- All 13 `frontend/src/app/i18n/locales/*.ts` - Removed dead tab/subtitle keys and overview/usage/cron namespaces

## Decisions Made
- Moved `initChatClient` into `direct-gateway.ts` rather than creating a new orchestration file - keeps all WebSocket client init in one module alongside `DirectGatewayClient` class
- Legacy `@openclaw/src` and `@openclaw/ui` aliases removed only after verifying zero surviving consumers (checked with grep after Task 2 deletions)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] initChatClient not exported from direct-gateway.ts**
- **Found during:** Task 2 (app.ts/app-lifecycle.ts import update)
- **Issue:** Plan assumed `initChatClient` was already exported from `direct-gateway.ts`, but it only existed in the now-deleted `app-gateway.ts`. Both `app.ts` and `app-lifecycle.ts` import from `direct-gateway.ts` after the path change.
- **Fix:** Added the complete `initChatClient` function to `direct-gateway.ts`, including all event mapping helpers (`mapAdapterChatEventToPayload`, `handleTerminalChatEvent`, `handleChatGatewayEvent`, `handleDirectAdapterEvent`) and all necessary imports.
- **Files modified:** `frontend/src/app/ui/direct-gateway.ts`
- **Verification:** `npm run build` passes
- **Committed in:** `f612fe5149a` (Task 2 commit)

**2. [Rule 2 - Missing Critical] Agents sub-panel files import deleted unavailable-page.ts**
- **Found during:** Task 2 build verification
- **Issue:** `agents-panels-tools-skills.ts` and `agents-panels-status-files.ts` imported `renderUnavailablePage` from `./unavailable-page`, which was deleted in Task 2. These files are intentionally kept (D-10).
- **Fix:** Inlined the `renderUnavailablePage` function (a simple Lit template returning a card with title+message) into both files.
- **Files modified:** `frontend/src/app/ui/views/agents-panels-tools-skills.ts`, `frontend/src/app/ui/views/agents-panels-status-files.ts`
- **Verification:** `npm run build` passes
- **Committed in:** `f612fe5149a` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 missing critical)
**Impact on plan:** Both auto-fixes necessary for build correctness. No scope creep.

## Issues Encountered
- Dead view files (overview.ts etc.) imported from `@openclaw/src/` alias during Task 1 build check while still alive - kept old aliases pointing to new paths temporarily, removed after Task 2 deletions
- Build failed twice during Task 2: first for `unavailable-page.ts` import (agents sub-panel files), second for missing `initChatClient` in `direct-gateway.ts`

## Next Phase Readiness
- Phase 112 Plan 02 can proceed with backend changes (no frontend dependency)
- Phase 112 Plan 03 (cron-jobs management UI) will need to add its own i18n keys for the new cron-jobs tab
- `config` tab content-header wrapper remains in `app-render.ts` line 486 (dead code, config removed from Tab type) - harmless, can be cleaned in a future pass

---
*Phase: 112-frontend-cleanup-cron*
*Completed: 2026-05-27*

## Self-Check: PASSED

All claims verified:
- app/ directory exists, openclaw/ removed
- protocol/ and app-gateway.ts deleted
- cron.ts view deleted
- initChatClient in direct-gateway.ts
- cron-jobs tab in navigation.ts
