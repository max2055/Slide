---
phase: 129-unified-observability
plan: 03
subsystem: backend-observability
status: complete
tags:
  - backend
  - reports
  - server-reports
  - persistence
  - server_id
  - scheduling
requires:
  - 129-01
provides:
  - reports table server_id column
  - report_configs table server_id column + server_health type
  - ReportDatabaseService server_id support with target_type filtering
  - ReportConfigDatabaseService server_id support
  - server-report-service generateAndPersist persistence
  - target_type-aware report API routes
affects:
  - apps/db-ops-api/sql/migrations/022_unified_observability.sql
  - apps/db-ops-api/src/report-database-service.ts
  - apps/db-ops-api/src/report-config-database-service.ts
  - apps/db-ops-api/src/server-report-service.ts
  - apps/db-ops-api/server.ts
tech-stack:
  added:
    - generateAndPersist() pattern (generate → HTML → createReport)
    - target_type query param on report list/configs routes
  patterns:
    - server_id and instance_id are mutually exclusive (null vs value)
    - target_type filtering via IS NULL / IS NOT NULL on server_id column
key-files:
  created: []
  modified:
    - apps/db-ops-api/sql/migrations/022_unified_observability.sql
    - apps/db-ops-api/src/report-database-service.ts
    - apps/db-ops-api/src/report-config-database-service.ts
    - apps/db-ops-api/src/server-report-service.ts
    - apps/db-ops-api/server.ts
decisions:
  - "report_configs type ENUM extended with 'server_health' to identify server inspection configs"
  - "target_type filtering uses server_id IS NULL/IS NOT NULL rather than a separate column (consistent with alert tables)"
  - "report_configs target_type filtering done at route level (not service level) to keep ConfigService API simple"
metrics:
  duration: "10 minutes"
  completed: "2026-07-09"
  tasks: 3/3
  files_changed: 5
  commits: 3
---

# Phase 129 Plan 03: Server Report Persistence and Scheduling Summary

## One-liner

Add server_id columns to reports and report_configs tables, update ReportDatabaseService and ReportConfigDatabaseService for server report support, wire ServerReportService to persist generated reports via ReportDatabaseService, and add target_type-aware report API routes.

## What Was Built

### Task 1: Migration — server_id on reports and report_configs tables

Appended 3 sections to `022_unified_observability.sql`:

- **Section 4 (reports):** Idempotent addition of `server_id INT UNSIGNED DEFAULT NULL AFTER instance_id` with foreign key `fk_report_server` → `servers(id) ON DELETE CASCADE` and index `idx_report_server_id`.
- **Section 5 (report_configs):** Idempotent addition of `server_id INT UNSIGNED DEFAULT NULL AFTER instance_id` with foreign key `fk_rc_server` → `servers(id) ON DELETE CASCADE` and index `idx_rc_server_id`.
- **Section 5 continued:** Extended `report_configs.type` ENUM from `('health','performance','slow_query','capacity')` to include `'server_health'` via idempotent `ALTER TABLE MODIFY COLUMN` (checks COLUMN_TYPE with `LOCATE('server_health', ...)` first).

All operations use `information_schema` existence checks for idempotent re-execution.

### Task 2: Database Service Updates for server_id

**ReportDatabaseService:**
- Added `server_id?: number | null` and `server_name?: string` to `Report` interface
- Added `server_id?: number` to `CreateReportData` interface
- Added `server_id?: number` and `target_type?: 'instance' | 'server'` to `ReportFilters` interface
- `createReport()` INSERT SQL includes `server_id` column and value (nullable)
- `getReportById()` SELECT includes `r.server_id` and LEFT JOIN `servers s ON r.server_id = s.id` for `s.host as server_name`
- `getReportsByFilters()` SELECT includes `r.server_id`, LEFT JOIN servers for `server_name`, and WHERE conditions supporting `filters.server_id` and `filters.target_type` (server_id IS NULL for instance, IS NOT NULL for server)
- Extended `ReportType` to include `'server_health'`

**ReportConfigDatabaseService:**
- Added `server_id?: number | null` to `ReportConfig` interface
- Added `server_id?: number` to `CreateReportConfigData` and `UpdateReportConfigData`
- `createConfig()` INSERT SQL includes `server_id` column
- `updateConfig()` handles `server_id` field updates
- All SELECT queries (`getConfigs`, `getConfigById`, `getEnabledConfigs`) include `server_id` column

### Task 3: ServerReportService Persistence + API Routes

**ServerReportService:**
- Added import of `reportDatabaseService` from `report-database-service.js`
- Added `generateAndPersist(serverIds?: number[])` method:
  - Calls `this.generateReport()` to get ReportData
  - Generates HTML via `this.generateHtml(reportData)`
  - Persists to `reports` table via `reportDatabaseService.createReport()` with `type: 'server_health'`, `instance_id: null`, and `server_id` set when a single server ID is provided
  - Returns `{ success, reportId }` or `{ success: false, error }`

**Server routes:**
- `POST /api/servers/reports/generate` updated to call `generateAndPersist()` instead of `generateReport()`, returning `{ reportId, message }`
- `GET /api/reports` now accepts `target_type` query param (server/instance), passed to `getReportsByFilters()` filters
- `GET /api/reports/configs` now accepts `target_type` query param for route-level filtering by server_id presence

## Deviations from Plan

None — plan executed exactly as written.

## Key Metrics

| Metric | Value |
|--------|-------|
| Migration sections added | 2 (reports + report_configs) |
| ENUM value extended | 1 ('server_health') |
| Foreign keys added | 2 (fk_report_server, fk_rc_server) |
| Indexes added | 2 (idx_report_server_id, idx_rc_server_id) |
| Interfaces updated | 5 (Report, CreateReportData, ReportFilters, ReportConfig, CreateReportConfigData, UpdateReportConfigData) |
| Service methods updated | 8 (createReport, getReportById, getReportsByFilters, createConfig, updateConfig, getConfigs, getConfigById, getEnabledConfigs) |
| New service method | 1 (generateAndPersist) |
| Routes updated | 3 (POST reports/generate, GET reports, GET reports/configs) |
| Api routes enhanced | 2 (target_type query param) |
| Total commits | 3 |

## Self-Check: PASSED

All files verified:
- [x] apps/db-ops-api/sql/migrations/022_unified_observability.sql — has server_id for reports (Section 4) and report_configs (Section 5) + ENUM extension
- [x] apps/db-ops-api/src/report-database-service.ts — has server_id, target_type, LEFT JOIN servers
- [x] apps/db-ops-api/src/report-config-database-service.ts — has server_id in all interfaces, queries, and CRUD
- [x] apps/db-ops-api/src/server-report-service.ts — has generateAndPersist method and server_health type
- [x] apps/db-ops-api/server.ts — has generateAndPersist route, target_type query params
- [x] 8f6833f — feat(129-03): add server_id to reports and report_configs via migration
- [x] 4da638c — feat(129-03): update ReportDatabaseService and ReportConfigDatabaseService for server_id
- [x] 0f7f31a — feat(129-03): persist server reports and update routes
