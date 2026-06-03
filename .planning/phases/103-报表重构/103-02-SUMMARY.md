---
phase: 103-报表重构
plan: 02
subsystem: api
tags: [cron, mysql, fastify, reports, scheduled-tasks]

# Dependency graph
requires:
  - phase: 103-01
    provides: EJS template rendering infrastructure
provides:
  - report_configs table with CRUD operations
  - ReportConfigService database service (6 methods)
  - 4 API routes at /api/reports/configs
  - CronJob scheduler for scheduled report generation
affects: [103-03 frontend scheduled report config UI]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - CronJob scanner with in-memory dedup (lastRunMinute Map)
    - Fastify CRUD routes with type validation
    - report-database-service CRUD pattern followed for configs

key-files:
  created:
    - apps/db-ops-api/sql/migrations/007_add_report_configs.sql
    - apps/db-ops-api/src/report-config-database-service.ts
  modified:
    - apps/db-ops-api/server.ts

key-decisions:
  - "report_configs table ENUM type uses slow_query (underscore) matching existing convention"
  - "CronJob dedup uses in-memory Map instead of DB-level locking — single-process enough"
  - "next_run computation uses new CronJob(config.cron).nextDates(1) per config"

patterns-established:
  - "Scheduled config CRUD: follow same route/preHandler/handler pattern as existing report routes"
  - "CronJob dedup: Map<configId, minute> with 10-minute stale cleanup"

requirements-completed: [RPT-02]

# Metrics
duration: 4min
completed: 2026-05-21
---

# Phase 103 Plan 02: Scheduled Report Config Backend Summary

**report_configs table, CRUD database service, 4 Fastify API routes, and 60-second CronJob scanner with dedup**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-05-21T05:49:00Z
- **Completed:** 2026-05-21T05:53:00Z
- **Tasks:** 3
- **Files created:** 2
- **Files modified:** 1

## Accomplishments
- Created migration SQL (007) for `report_configs` table with all 9 columns per D-05 and executed against database
- Created `ReportConfigService` class with 6 CRUD methods (`getConfigs`, `getConfigById`, `createConfig`, `updateConfig`, `deleteConfig`, `getEnabledConfigs`) — follows existing report-database-service.ts pattern exactly
- Added 4 Fastify routes at `/api/reports/configs` (GET/POST/PUT/DELETE) with input validation for type and format enums, between existing report routes and alert-rules section
- Added `reportScheduleJob` CronJob with `*/60 * * * * *` interval, scanning enabled configs, matching cron expressions via `nextDates()`, and preventing same-minute re-trigger via in-memory dedup Map

## Files Created/Modified

### Created
- `apps/db-ops-api/sql/migrations/007_add_report_configs.sql` — CREATE TABLE report_configs with id, name, cron, type, instance_id, format, enabled, created_at, updated_at; indexes on enabled and instance_id; FK to database_instances
- `apps/db-ops-api/src/report-config-database-service.ts` — ReportConfigService class singleton with full CRUD + getEnabledConfigs(), all queries use parameterized pool.execute()

### Modified
- `apps/db-ops-api/server.ts` — Added import for reportConfigService + ReportType, 4 config routes (140 lines), CronJob schedule (39 lines)

## Task Commits

Each task was committed atomically:

1. **Task 1: Migration SQL + config database service** - `67d0b9f52df` (feat)
2. **Task 2: CRUD routes for /api/reports/configs** - `5202a0d13f6` (feat)
3. **Task 3: CronJob scheduler for report configs** - `a7ec27045b2` (feat)

## Decisions Made
- Used `slow_query` (underscore) in report_configs type ENUM — consistent with existing convention per D-09
- CronJob dedup uses in-memory `lastRunMinute` Map with 10-minute stale cleanup — sufficient for single-process deployment
- `next_run` computation in GET route handler uses `new CronJob(config.cron).nextDates(1)` — same library already used project-wide
- Format parameter uses `format as any` cast for CronJob calls — `report_configs.format` enum includes `md`/`json` while `ReportOptions.format` uses different subset

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None — all tasks completed without issues. Pre-existing `baseUrl` deprecation warning in tsconfig.json is not related to this plan's changes.

## Next Phase Readiness
- Backend report config infrastructure complete (table, service, API, scheduler)
- Ready for Plan 03: Frontend scheduled report config management UI
- Frontend can consume GET/POST/PUT/DELETE /api/reports/configs endpoints

## Self-Check: PASSED

- [x] Migration SQL file exists (apps/db-ops-api/sql/migrations/007_add_report_configs.sql)
- [x] Database service file exists (apps/db-ops-api/src/report-config-database-service.ts)
- [x] SUMMARY.md exists (.planning/phases/103-报表重构/103-02-SUMMARY.md)
- [x] Commit 67d0b9f52df (Task 1: migration + service)
- [x] Commit 5202a0d13f6 (Task 2: config routes)
- [x] Commit a7ec27045b2 (Task 3: CronJob scheduler)
- [x] Commit 69c9f920e00 (docs: SUMMARY.md)
- [x] report_configs table exists in database with 7 key columns verified

---
*Plan: 103-02*
*Completed: 2026-05-21*
