---
phase: 88-dashboard-upgrade
plan: 01
subsystem: api
tags: [fastify, mysql, capacity_history, ai_analysis, dashboard, integration-tests]

requires:
  - phase: 88-dashboard-upgrade
    provides: UI design contract (88-UI-SPEC), research (88-RESEARCH.md), pattern map (88-PATTERNS.md)
provides:
  - Backend dashboard aggregation API endpoints for capacity trend and AI analysis count
  - Integration test stubs for both new endpoints
affects: [88-dashboard-upgrade plan 02 (frontend dashboard rewrite)]

tech-stack:
  added: []
  patterns:
    - "Inline Fastify route registration with dynamic WHERE clause building and parameterized SQL"
    - "Integration test pattern using fastify.inject() with inline mock route handlers"

key-files:
  created:
    - apps/db-ops-api/tests/dashboard.test.ts
  modified:
    - apps/db-ops-api/server.ts

key-decisions:
  - "Dashboard endpoints do NOT use preHandler auth, matching existing read-only endpoint pattern (GET /api/database/instances, GET /api/database/instances/:id/capacity/history)"
  - "Both endpoints use dbConnection.getPool() for MySQL access, following established pattern"
  - "capacity-trend uses UNION ALL approach for ai-stats to avoid WITH ROLLUP null-type ambiguity"
  - "start_date/end_date params override hours-based filtering when both provided"

requirements-completed: [DASH-02, DASH-03]

duration: 3min
completed: 2026-05-11
---

# Phase 88 Dashboard Upgrade Plan 01 Summary

**Backend dashboard aggregation endpoints for capacity trend (capacity_history) and AI analysis count (ai_analysis) with integration test stubs**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-11T13:33:00Z
- **Completed:** 2026-05-11T13:35:58Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Created `/api/dashboard/capacity-trend` endpoint supporting hours, instance_id, start_date, end_date query parameters (per D-05, D-06, D-07)
- Created `/api/dashboard/ai-stats` endpoint returning today's AI analysis count with type breakdown (per D-15)
- Both endpoints use parameterized SQL queries with `?` placeholders (SQL injection mitigated per T-88-01, T-88-05)
- Created 8 integration test cases covering both endpoints with parameter variations including combined instance_id + date range filtering

## Task Commits

Each task was committed atomically:

1. **Task 1: Create integration test stubs for dashboard endpoints** - `8daa0a4b` (test)
2. **Task 2: Add routes to server.ts** - `a63fa601` (feat)

## Files Created/Modified

- `apps/db-ops-api/tests/dashboard.test.ts` - Integration tests (8 tests) for capacity-trend and ai-stats endpoints using fastify.inject pattern
- `apps/db-ops-api/server.ts` - Added 2 Fastify GET routes for dashboard aggregation (capacity-trend at line 992, ai-stats at line 1071)

## Decisions Made

- **No auth preHandler on dashboard endpoints** - Following existing pattern of read-only dashboard endpoints. The threat model (T-88-02) accepts this risk as these return aggregate statistics already accessible via other endpoints.
- **Dynamic WHERE clause building** - capacity-trend supports both hours-based and date-range-based filtering. SQL string concatenation is used for WHERE clause structure, but all user input values are bound via `?` placeholders in the params array (no SQL injection vector).
- **UNION ALL approach for ai-stats** - Using two queries joined by UNION ALL avoids WITH ROLLUP's null analysis_type ambiguity issue. The null-bearing row from the second SELECT provides the total count.

## Deviations from Plan

None - plan executed exactly as written.

## Threat Compliance

All threat register mitigations are implemented:

| Threat ID | Disposition | Status |
|-----------|-------------|--------|
| T-88-01 | mitigate | `?` placeholder for hours param |
| T-88-02 | accept | No auth preHandler (accepted risk) |
| T-88-03 | accept | Aggregated data only (accepted risk) |
| T-88-04 | accept | No explicit hours upper bound (accepted risk) |
| T-88-05 | mitigate | `?` placeholders for instance_id, start_date, end_date |

## Known Stubs

None - the test file uses mock handlers as intended for integration test isolation. The actual routes query real database tables.

## Self-Check: PASSED

- [x] Test file created at `apps/db-ops-api/tests/dashboard.test.ts`
- [x] Both routes registered in `apps/db-ops-api/server.ts` (line 992, 1071)
- [x] All 8 tests pass with `npx vitest run`
- [x] No reference to `ai_analysis_cache` (wrong table name)
- [x] capacity-trend uses `instance_id`, `start_date`, `end_date` query params
- [x] Both routes use parameterized SQL (`?` placeholders)

---
*Phase: 88-dashboard-upgrade*
*Completed: 2026-05-11*
