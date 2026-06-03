---
phase: 104-告警系统增强
plan: 01
subsystem: api
tags: alert-rules, threshold-type, dynamic-config, silence-minutes, crud

requires: []
provides:
  - AlertRule CRUD with threshold_type, dynamic_config, silence_minutes persistence
  - PUT/POST /api/alert-routes forwarding all new fields
affects: [104-02, 104-03, frontend alert-rule forms]

tech-stack:
  added: []
  patterns:
    - UPDATE if-block pattern for optional field writes
    - JSON.stringify for complex config fields in INSERT/UPDATE

key-files:
  modified:
    - apps/db-ops-api/src/alert-database-service.ts
    - apps/db-ops-api/server.ts

key-decisions:
  - "threshold_type defaults to 'static' on INSERT when not provided"
  - "silence_minutes defaults to 5 on INSERT when not provided (nullish coalescing)"
  - "threshold_template and dynamic_config are JSON-stringified for MySQL TEXT columns"
  - "PUT route forwards all fields as-is from request body (no defaults)"
  - "resolveDynamicThreshold() requires no code change — database now populates threshold_type"

patterns-established:
  - "JSON config fields (threshold_template, dynamic_config) use JSON.stringify() before storage and are undefined-guarded"
  - "Simple scalar fields (threshold_type, silence_minutes) use direct assignment with ?? or || defaults"

requirements-completed: [ALERT-01, ALERT-03]

duration: 2min
completed: 2026-05-21
---

# Phase 104: Plan 01 Alert System Enhancement Summary

**Backend CRUD persistence for AlertRule threshold_type, dynamic_config, and silence_minutes — completing the full interface-to-route data flow**

## Performance

- **Duration:** 2 min
- **Started:** 2026-05-21T13:59:00Z
- **Completed:** 2026-05-21T14:00:59Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- AlertRule interface now declares `threshold_type: 'static' | 'dynamic'`, `dynamic_config`, and `silence_minutes` fields
- SELECT query reads all three columns from MySQL, making them available to alert-evaluator's resolveDynamicThreshold()
- INSERT writes them with defaults ('static', null, 5) when not provided
- UPDATE builds parameterized query blocks for all four new fields (threshold_type, threshold_template, dynamic_config, silence_minutes)
- POST /api/alert-rules forwards all four fields to createAlertRule() with safe defaults
- PUT /api/alert-rules/:id forwards all four fields to updateAlertRule() as-is
- resolveDynamicThreshold() now receives populated threshold_type from the service layer — the existing `if (rule.threshold_type !== 'dynamic')` condition correctly distinguishes static vs. dynamic rules

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix AlertRule interface + SELECT + INSERT + UPDATE** - `9ab9ad908da` (feat)
2. **Task 2: Fix POST/PUT route handlers** - `5cb933015f1` (feat)

**Plan metadata:** (committed below)

## Files Created/Modified

- `apps/db-ops-api/src/alert-database-service.ts` — AlertRule interface expanded, SELECT/INSERT/UPDATE support for 3 new fields (+ threshold_template added to UPDATE)
- `apps/db-ops-api/server.ts` — POST and PUT /api/alert-rules handlers forward 4 new fields

## Decisions Made

- `threshold_type` defaults to `'static'` on INSERT when not provided — maintains backward compatibility with existing API consumers that don't send the field
- `silence_minutes` defaults to `5` on INSERT using `??` nullish coalescing (treats undefined as 5, allows explicit 0)
- JSON config fields (threshold_template, dynamic_config) use `JSON.stringify()` before storage, null when falsy
- PUT handler passes fields as-is from request body without defaults — the service layer's `undefined` check prevents no-ops when fields are omitted
- No code change needed in alert-evaluator.ts — the existing resolveDynamicThreshold() correctly reads rule.threshold_type, which is now populated from database

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None — both tasks completed without issues.

## User Setup Required

None — no external service configuration required. Backend restart needed to pick up changes.

## Next Phase Readiness

- Backend CRUD for AlertRule threshold_type, dynamic_config, silence_minutes complete
- Ready for frontend alert-rule form integration (Plan 02) and alert-evaluator dynamic threshold verification (Plan 03)
- resolveDynamicThreshold() now receives populated threshold_type — Plan 03 can verify end-to-end

---
*Phase: 104-告警系统增强*
*Completed: 2026-05-21*
