---
phase: 103-报表重构
plan: 01
subsystem: report-service
tags: [ejs, template, migration, type-fix]
requires: []
provides: [ejs-templates, render-template, type-fix-migration]
affects: [report-service, report-database-service, package.json]
tech-stack:
  added:
    - ejs@^5.0.2 (template rendering engine)
  patterns:
    - EJS template rendering with ejs.renderFile()
    - Async template method replacing synchronous inline HTML
    - Layout + body-per-type template architecture
key-files:
  created:
    - apps/db-ops-api/src/templates/reports/layout.ejs
    - apps/db-ops-api/src/templates/reports/health.ejs
    - apps/db-ops-api/src/templates/reports/performance.ejs
    - apps/db-ops-api/src/templates/reports/slow-query.ejs
    - apps/db-ops-api/src/templates/reports/capacity.ejs
    - apps/db-ops-api/sql/migrations/006_fix_report_type_names.sql
  modified:
    - apps/db-ops-api/src/report-service.ts
    - apps/db-ops-api/src/report-database-service.ts
    - apps/db-ops-api/package.json
decisions: []
metrics:
  duration: 10m
  completed_date: 2026-05-21
---

# Phase 103 Plan 01: EJS Templates + Report Type Fix Summary

**One-liner:** Extract 4 inline HTML template strings from report-service.ts into 5 EJS template files (layout.ejs + 4 per-type), add ejs@^5.0.2 dependency, fix ReportType slow-query -> slow_query, and create migration SQL.

## Requirements Coverage

| Requirement | Status | Evidence |
|---|---|---|
| RPT-01 (EJS template extraction) | Done | 5 EJS templates created, report-service.ts refactored to use ejs.renderFile() |
| RPT-03 (Report type naming unification) | Done | ReportType fixed to slow_query, migration 006 created |

## Tasks

| Task | Name | Type | Status | Commit |
|------|------|------|--------|--------|
| 1 | Create EJS template directory and 5 template files | auto | Done | `fd3529e8132` |
| 2 | Verify ejs package legitimacy and install | checkpoint:human-verify | Done (user verified) | `ec4d29c0fa8` |
| 3 | Refactor report-service.ts + fix ReportType + migration SQL | auto | Done | `ad100a85783` |

## What Was Built

### EJS Template Files (5 files)

1. **layout.ejs** — Shared HTML shell with DOCTYPE, meta charset, inline CSS (body font, h1 accent border, table styles), header section (h1 with icon, instance name, generated at), and `<%- body %>` injection point. Uses EJS context: title, instanceName, generatedAt, accentColor, icon, body.

2. **health.ejs** — Health report body with summary grid (6 cards: health score, CPU, memory, disk, connections, QPS) and detailed metrics table. Health score thresholds: >=80 ok, >=60 warning, <60 critical — matches existing logic.

3. **performance.ejs** — Performance report with current metrics table (QPS, TPS, connections) and Top slow queries table with SQL, avg_time_ms, execution_count, total_time_ms.

4. **slow-query.ejs** — Slow query report with count display and numbered table: #, SQL (substring 80 chars), avg_time_ms, execution_count, rows_examined.

5. **capacity.ejs** — Capacity report with 2-column summary grid: disk usage percentage and growth trend.

### Template Architecture

Each per-type template uses `<%- include('layout', { ... }) %>` at the bottom, passing all common context fields plus the rendered body content. The body is captured as a JavaScript template literal string (with `${}` interpolation for EJS-scoped variables) inside a `<%` scriptlet block.

### Report Service Refactoring

- **Added imports**: `ejs`, `path`, `fs`
- **Added `TEMPLATE_DIR` constant**: Resolves to `src/templates/reports`
- **Added `renderTemplate()`**: Async method using `ejs.renderFile()` with fallback to inline HTML when template file is missing
- **Added `getFallbackHTML()`**: Dispatches to 4 standalone fallback HTML generator functions that preserve the original inline HTML strings
- **Updated 4 public methods**: `generateHealthReport`, `generatePerformanceReport`, `generateSlowQueryReport`, `generateCapacityReport` now call `await this.renderTemplate()`
- **Removed 4 private methods**: `generateHealthReportHTML`, `generatePerformanceReportHTML`, `generateSlowQueryReportHTML`, `generateCapacityReportHTML`

### Type Fix (RPT-03)

- `report-database-service.ts` line 7: `'slow-query'` changed to `'slow_query'`
- Migration SQL `006_fix_report_type_names.sql`: `UPDATE reports SET type = 'slow_query' WHERE type = 'slow-query';`

### Dependencies

- Added `"ejs": "^5.0.2"` to package.json dependencies (verified by user via npmjs.com — 15+ years, 30M+ weekly downloads, published by mde)

## Verification Results

| Check | Expected | Actual |
|---|---|---|
| `ejs.renderFile` in report-service.ts | >=1 | 1 |
| `generate.*ReportHTML` in report-service.ts | 0 | 0 |
| `'slow-query'` in report-database-service.ts | empty | empty |
| `'slow_query'` in report-database-service.ts | 1 | 1 |
| EJS template count | 5 | 5 |
| ejs in package.json | present | present |
| Migration SQL exists | present | present |
| `npx tsc --noEmit` (modified files) | no errors | no errors |
| `grep 'slow-query' .ts/.sql` | only filename refs | only filename refs + migration |

## Deviations from Plan

None — plan executed exactly as written.

## Deferred Items

1. **Migration SQL execution**: The migration file `006_fix_report_type_names.sql` was created and committed, but could not be executed against the database because the MySQL root password is Docker-masked and no `.env` file is present in the worktree. A human operator with database access should execute:
   ```
   mysql -u root -p db_ops_ai < apps/db-ops-api/sql/migrations/006_fix_report_type_names.sql
   ```

## Threat Flags

None — no new security-relevant surface introduced.

## Self-Check

- [x] All 5 EJS template files exist at `apps/db-ops-api/src/templates/reports/*.ejs`
- [x] Commit `fd3529e8132` exists (Task 1)
- [x] Commit `ec4d29c0fa8` exists (Task 2)
- [x] Commit `ad100a85783` exists (Task 3)
- [x] All 8 verification checks pass

**Self-Check: PASSED**
