---
phase: 115-openclaw-todo-ci
plan: 02
subsystem: cleanup
tags: [vite, alias, import-paths, dead-code]
requires: []
provides:
  - Deleted three dead routing files with broken OpenClawConfig imports
  - New config/types.ts with OpenClawConfig type stub
  - All auto-reply/infra/media import paths pointing to config/types.js instead of config/types.openclaw.js
  - Vite alias renamed from openclaw/plugin-sdk to @agent/plugin-sdk
affects: []

tech-stack:
  added: []
  patterns:
    - "Use @agent/plugin-sdk as neutral Vite alias prefix"
    - "config/types.ts as backward-compatibility type stub for removed modules"

key-files:
  created:
    - frontend/src/app/src/config/types.ts
  modified:
    - frontend/vite.config.js
    - 85+ files in frontend/src/app/src/auto-reply/ (import path fix)
    - frontend/src/app/src/infra/update-startup.ts
    - frontend/src/app/src/media/configured-max-bytes.ts

key-decisions:
  - "Created minimal OpenClawConfig interface with only the properties actually accessed across the codebase (agents, session, update) rather than a generic Record<string, any>"
  - "Used 'Record<string, unknown>' for nested config properties to maintain type safety while avoiding circular dependencies"
  - "Kept OpenClawConfig type name to minimize diff — all type annotations remain compatible"

requirements-completed: [D-06, D-09]

duration: ~15min
completed: 2026-06-02
---

# Phase 115 Plan 02: Dead Routing & Alias Cleanup Summary

**Deleted three dead routing files, created config/types.ts stub for broken OpenClawConfig imports, renamed Vite alias to neutral @agent/plugin-sdk across 12 import sites**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-06-02
- **Tasks:** 3
- **Files modified:** 88 source files (3 deleted, 1 created, 84 import path updates)

## Accomplishments

- Deleted `bindings.ts`, `resolve-route.ts`, `bound-account-read.ts` (all imported from the already-deleted `config/types.openclaw.js`, no other files depended on them)
- Created `frontend/src/app/src/config/types.ts` with a minimal `OpenClawConfig` interface covering all properties actually accessed across the codebase (`agents`, `session`, `update`)
- Updated 85 auto-reply and infra files to import from `../config/types.js` instead of `../config/types.openclaw.js` (variant relative depths)
- Fixed a pre-existing broken import in `media/configured-max-bytes.ts` (not in the plan's file list)
- Renamed Vite alias from `openclaw/plugin-sdk/reply-payload` to `@agent/plugin-sdk/reply-payload` in `vite.config.js`
- Updated all 12 auto-reply files importing from the old alias

## Task Commits

Each task was committed atomically:

1. **Task 1: Delete dead routing files** - `f729f84` (feat)
2. **Task 2: Create config/types.ts stub and fix imports** - `f7b41da` + `c15651b` (feat)
3. **Task 3: Rename Vite alias and update imports** - `c58422e` (feat)

## Files Created/Modified

| Path | Action | Purpose |
|------|--------|---------|
| `frontend/src/app/ui/routing/bindings.ts` | Deleted | Dead routing file importing deleted config |
| `frontend/src/app/ui/routing/resolve-route.ts` | Deleted | Dead routing file importing deleted config |
| `frontend/src/app/ui/routing/bound-account-read.ts` | Deleted | Dead routing file importing deleted config |
| `frontend/src/app/src/config/types.ts` | Created | OpenClawConfig type stub |
| `frontend/vite.config.js` | Modified | Renamed alias to `@agent/plugin-sdk/reply-payload` |
| 85 files in `frontend/src/app/src/auto-reply/` | Modified | Import path fix: `types.openclaw.js` to `types.js` |
| `frontend/src/app/src/infra/update-startup.ts` | Modified | Import path fix |
| `frontend/src/app/src/media/configured-max-bytes.ts` | Modified | Import path fix (pre-existing broken import) |

## Decisions Made

- **Minimal interface over generic type**: Created an `OpenClawConfig` interface with only the properties actually accessed (`agents`, `session`, `update`) rather than `Record<string, any>`. This preserves type safety for existing consumers while keeping the stub small.
- **`unknown` over `any`**: Used `Record<string, unknown>` for nested config objects to maintain type checking without inferring arbitrary property access.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Fixed pre-existing broken import in media/configured-max-bytes.ts**
- **Found during:** Task 2 (import verification)
- **Issue:** The file `frontend/src/app/src/media/configured-max-bytes.ts` imports from `../config/types.openclaw.js` but was not listed in the plan's file list for import path updates.
- **Fix:** Changed import to `../config/types.js`
- **Files modified:** `frontend/src/app/src/media/configured-max-bytes.ts`
- **Verification:** `grep -rl 'types.openclaw'` returns zero results outside the intentional comment in `config/types.ts`
- **Committed in:** `c15651b`

---

**Total deviations:** 1 auto-fixed (1 missing import fix)
**Impact on plan:** Necessary for completeness — the file would have remained broken otherwise. No scope creep.

## Issues Encountered

- None. All three tasks executed as specified.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- D-06 and D-09 requirements completed
- Codebase is ready for remaining Phase 115 cleanup plans (tool TODO cleanup, documentation, CI setup)
- No remaining `openclaw/plugin-sdk` or `types.openclaw` references in source files

---
## Self-Check: PASSED

| Check | Result |
|-------|--------|
| routing/bindings.ts deleted | PASS |
| routing/resolve-route.ts deleted | PASS |
| routing/bound-account-read.ts deleted | PASS |
| config/types.ts created | PASS |
| SUMMARY.md created | PASS |
| Commit f729f84 (Task 1) | FOUND |
| Commit f7b41da (Task 2: types.ts) | FOUND |
| Commit c15651b (Task 2: import fix) | FOUND |
| Commit c58422e (Task 3: alias rename) | FOUND |
| Commit 3684fa2 (metadata) | FOUND |

*Phase: 115-openclaw-todo-ci*
*Completed: 2026-06-02*
