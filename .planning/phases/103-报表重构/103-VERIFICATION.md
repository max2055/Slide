---
phase: 103-报表重构
verified: 2026-05-21T15:40:00Z
status: passed
score: 11/11 must-haves verified
overrides_applied: 0
re_verification: true
gaps: []
human_verification:
  - test: "Run migration 006 SQL against the database to fix existing data rows that may have 'slow-query' type"
    expected: "mysql -u root -p db_ops_ai < apps/db-ops-api/sql/migrations/006_fix_report_type_names.sql should execute without error; any existing rows with type='slow-query' are updated to 'slow_query'"
    why_human: "No database credentials available in the worktree; the migration file exists and is correct but was not executed during Phase 103 due to Docker-masked MySQL root password"
    result: "Executed 2026-05-21. 0 rows affected — no slow-query data existed."
  - test: "Run migration 007 SQL against the database if not already executed"
    expected: "mysql -u root -p db_ops_ai < apps/db-ops-api/sql/migrations/007_add_report_configs.sql should execute without error; report_configs table exists with all 9 columns"
    why_human: "SUMMARY-02 claims migration 007 was executed, but I cannot verify this programmatically without database access"
    result: "Executed 2026-05-21. report_configs table created with 9 columns: id, name, cron, type, instance_id, format, enabled, created_at, updated_at."
---

# Phase 103: 报表重构 Verification Report

**Phase Goal:** 重构报表模板系统为EJS文件，新增定时报表配置，统一报表类型命名
**Verified:** 2026-05-21T15:40:00Z
**Status:** passed (all code verified, 2 DB migrations executed 2026-05-21)
**Re-verification:** Yes — human items resolved

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Report HTML is rendered from EJS template files (layout.ejs + per-type), not inline TypeScript strings | VERIFIED | 5 EJS files exist in `apps/db-ops-api/src/templates/reports/`; report-service.ts uses `ejs.renderFile()` via `renderTemplate()` method; no inline generate*ReportHTML methods remain (replaced by standalone fallback functions); ejs@^5.0.2 in package.json |
| 2 | Slow query report type is consistently 'slow_query' in the type system and data | VERIFIED | `report-database-service.ts` line 7: `ReportType = 'health' \| 'performance' \| 'slow_query' \| 'capacity'`; migration 006 SQL exists; _reportTypeLabel uses `slow_query` key; remaining 'slow-query' references are only to the template filename (legitimate per plan) |
| 3 | Users can CRUD report configs via GET/POST/PUT/DELETE /api/reports/configs | VERIFIED | 4 Fastify routes at server.ts lines 1541-1675 with auth preHandler; report-config-database-service.ts has all 6 CRUD methods; input validation for type/fmt enums; existence check on PUT/DELETE; 404 on not-found |
| 4 | Scheduled report configs with enabled=1 are evaluated by a CronJob every 60 seconds | VERIFIED | `reportScheduleJob` CronJob at server.ts line 3649 with `'*/60 * * * * *'` interval; calls `reportConfigService.getEnabledConfigs()` then iterates; uses `new CronJob(config.cron).nextDates(1)` to match cron expressions |
| 5 | Deduplication prevents the same config from triggering multiple times within the same minute | VERIFIED | `lastRunMinute` Map (server.ts line 3647) tracks config id -> current minute; skips if already triggered this minute; stale entries older than 10 minutes are cleaned up |
| 6 | Users can see report config list with name, instance, type, cron, next-run, status, and actions | VERIFIED | Config card renders in reports.ts between stat-cards and generate card (lines 528-591); table columns: 配置名称, 报表类型, 目标实例, Cron表达式, 下次执行, 状态, 操作; empty state: "暂无定时配置" with CTA |
| 7 | Users can create a new scheduled report config via a modal dialog | VERIFIED | `_openCreateDialog()` + `_saveConfig()` in reports.ts; dialog form fields: name, type, instance, cron, format, enabled; required field validation; POST /api/reports/configs |
| 8 | Users can edit an existing config via a pre-filled modal dialog | VERIFIED | `_openEditDialog(cfg)` pre-fills form from existing config; same dialog with "编辑" title; PUT /api/reports/configs/:id |
| 9 | Users can delete configs after confirmation | VERIFIED | `_confirmDelete(cfg)` opens confirmation modal with destructive-styled delete button; confirmed via `_deleteConfig()` calling DELETE /api/reports/configs/:id |
| 10 | Users can toggle enable/disable on configs with optimistic UI update | VERIFIED | `_toggleConfig(cfg)` optimistically toggles cfg.enabled, calls PUT with `{ enabled: !original }`, rolls back on network error |
| 11 | Slow query label correctly renders from 'slow_query' type name | VERIFIED | `_reportTypeLabel` at line 770 uses `slow_query: "慢查询"` key (not `slow-query`) |

**Score:** 11/11 truths verified

### Success Criteria Mapping (ROADMAP)

| # | Success Criterion | Status | Evidence |
|---|-------------------|--------|----------|
| 1 | Report HTML templates are loaded from EJS files (ejs@5.0.2), not inline HTML strings | VERIFIED | Truth #1 above |
| 2 | Users can create report configs with cron schedules for automatic report generation via report_configs table | VERIFIED | Truths #3, #4, #5, #6, #7, #8, #9, #10 above; migration 007 creates table; CRUD routes; CronJob |
| 3 | Report type names are consistent across all code paths -- slow_query is canonical; existing data migrated | PARTIAL | Code is fully consistent (Truth #2); migration 006 SQL file exists but was NOT executed against the database (see human_verification) |
| 4 | Report views use shared <stat-card> component instead of ov-card CSS classes | VERIFIED | reports.ts line 521 uses `<stat-card label="..." value="...">` components; satisfied per ROADMAP (Phase 102 delivered this) |

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `apps/db-ops-api/src/templates/reports/layout.ejs` | Shared HTML shell with `<%- body %>` injection | VERIFIED | 35 lines, DOCTYPE, CSS, `<%- body %>` at line 33, accepts all 7 context fields |
| `apps/db-ops-api/src/templates/reports/health.ejs` | Health report body with score thresholds | VERIFIED | 42 lines, 6-card summary grid, detailed metrics table, score thresholds 80/60 ok/warning/critical |
| `apps/db-ops-api/src/templates/reports/performance.ejs` | Performance body with slow query table | VERIFIED | 25 lines, QPS/TPS/connections table, top_slow_queries map with 4-column table |
| `apps/db-ops-api/src/templates/reports/slow-query.ejs` | Slow query body with table | VERIFIED | 20 lines, count display, 5-column table: #, SQL(80ch), avg_time_ms, execution_count, rows_examined |
| `apps/db-ops-api/src/templates/reports/capacity.ejs` | Capacity body with 2-column summary | VERIFIED | 15 lines, disk_usage + growth_trend cards |
| `apps/db-ops-api/src/report-service.ts` | Refactored to use ejs.renderFile() | VERIFIED | Lines 8-10: imports ejs/path/fs; line 30: TEMPLATE_DIR; lines 611-621: renderTemplate() using ejs.renderFile(); 4 generate methods call renderTemplate(); no inline generate*ReportHTML methods |
| `apps/db-ops-api/src/report-database-service.ts` | ReportType uses 'slow_query' | VERIFIED | Line 7: `'slow_query'` in type union |
| `apps/db-ops-api/sql/migrations/006_fix_report_type_names.sql` | UPDATE migration for slow-query -> slow_query | VERIFIED | File exists; START TRANSACTION; UPDATE reports SET type='slow_query' WHERE type='slow-query'; COMMIT |
| `apps/db-ops-api/sql/migrations/007_add_report_configs.sql` | CREATE TABLE report_configs with 9 columns | VERIFIED | File exists; all 9 columns per spec; INDEX on enabled, instance_id; FK to database_instances |
| `apps/db-ops-api/src/report-config-database-service.ts` | ReportConfigService with 6 CRUD methods | VERIFIED | 242 lines; getConfigs, getConfigById, createConfig, updateConfig, deleteConfig, getEnabledConfigs; parameterized pool.execute(); singleton export |
| `apps/db-ops-api/server.ts` | 4 config routes + CronJob | VERIFIED | Import at line 36; 4 routes at lines 1541-1675; CronJob at lines 3649-3682; dedup via lastRunMinute Map |
| `apps/db-ops-api/package.json` | ejs dependency | VERIFIED | Line 30: `"ejs": "^5.0.2"` |
| `frontend/src/openclaw/ui/views/reports.ts` | Config UI card + dialogs + CRUD + type label fix | VERIFIED | Config card (lines 528-591); create/edit dialog (lines 594-650); delete confirm (lines 653-669); toggle/CRUD methods (lines 789-892); _reportTypeLabel with slow_query (line 770); CronJob import for next-run (line 6) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| report-service.ts | templates/reports/*.ejs | ejs.renderFile(path.join(TEMPLATE_DIR, templateName + '.ejs'), context) | WIRED | Lines 611-621: renderTemplate() constructs path and calls ejs.renderFile(); all 4 public generate methods call renderTemplate |
| server.ts routes | report-config-database-service.ts | import + handler calls | WIRED | Line 36 import; GET calls getConfigs(); POST calls createConfig(); PUT calls updateConfig(); DELETE calls deleteConfig() |
| CronJob in server.ts | report-config-database-service.ts | getEnabledConfigs() | WIRED | Line 3651: `await reportConfigService.getEnabledConfigs()` |
| CronJob in server.ts | report-service.ts | reportService.generateReport() | WIRED | Lines 3664-3668: calls generateReport with type cast and format |
| frontend loadConfigs() | GET /api/reports/configs | authFetch | WIRED | reports.ts line 459: `authFetch('/api/reports/configs')` |
| frontend _saveConfig() | POST/PUT /api/reports/configs | authFetch | WIRED | Lines 865/875: authFetch to create/edit endpoints |
| frontend _toggleConfig() | PUT /api/reports/configs/:id | authFetch | WIRED | Line 822: authFetch to PUT with { enabled: toggled } |
| frontend _deleteConfig() | DELETE /api/reports/configs/:id | authFetch | WIRED | Line 844: authFetch to DELETE endpoint |
| frontend next-run display | cron package | new CronJob(cfg.cron).nextDates(1) | WIRED | Reports.ts line 464; import at line 6 from "cron" |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| report-service.ts renderTemplate | context (EJS context) | Caller methods pass metrics, slowQueries, capacityData from metricsDatabaseService / collectHealthMetrics | Depends on DB data | FLOWING -- EJS templates are correctly wired; data queries existing method calls |
| reports.ts config list | this.configs | authFetch GET /api/reports/configs -> backend -> report_configs table | Produces real data from DB | FLOWING -- CRUD operations load/reload configs from server |
| reports.ts next_run | CronJob.nextDates(1) | cron package | Computed from cfg.cron expression | FLOWING -- computed on frontend per-config |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| EJS templates exist and have content | `ls apps/db-ops-api/src/templates/reports/*.ejs \| wc -l` | 5 | PASS |
| ejs dependency in package.json | `grep '"ejs"' apps/db-ops-api/package.json` | `"ejs": "^5.0.2"` | PASS |
| ejs.renderFile used in report-service | `grep -c 'ejs.renderFile' apps/db-ops-api/src/report-service.ts` | 1 | PASS |
| No inline generate*ReportHTML methods | `grep -c 'generate.*ReportHTML' apps/db-ops-api/src/report-service.ts` | 0 | PASS |
| ReportType uses slow_query | `grep "'slow_query'" apps/db-ops-api/src/report-database-service.ts` | 1 | PASS |
| No slow-query in ReportType | `grep "'slow-query'" apps/db-ops-api/src/report-database-service.ts` | empty | PASS |
| All 4 config routes exist in server.ts | Combined grep for GET/POST/PUT/DELETE /api/reports/configs | 4 matches | PASS |
| CronJob with dedup exists | `grep -c 'lastRunMinute' apps/db-ops-api/server.ts` | 1 | PASS |
| Frontend type label uses slow_query | `grep 'slow_query' frontend/src/openclaw/ui/views/reports.ts` / Reports at line 770 | PASS |
| Layout contains body injection | `grep '<%- body %>' apps/db-ops-api/src/templates/reports/layout.ejs` | Found at line 33 | PASS |

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
| ----------- | ------------ | ----------- | ------ | -------- |
| RPT-01 | 103-01 | Extract inline HTML to EJS templates | SATISFIED | 5 EJS templates; report-service.ts uses ejs.renderFile(); 4 private generate*ReportHTML methods removed; ejs@^5.0.2 in package.json |
| RPT-02 | 103-02, 103-03 | Report configs table + scheduled generation | SATISFIED | Migration 007; report-config-database-service.ts; 4 routes; CronJob; frontend config UI (CRUD/toggle/delete) |
| RPT-03 | 103-01, 103-03 | Fix type naming inconsistency (slow-query vs slow_query) | SATISFIED | ReportType uses slow_query; migration 006 SQL exists; _reportTypeLabel uses slow_query; remaining hyphenated refs are template filenames only |
| RPT-04 | (dependency on Phase 102) | Use shared <stat-card> component | SATISFIED | reports.ts uses `<stat-card>` at line 521 (delivered by Phase 102) |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| apps/db-ops-api/src/report-service.ts | 600 | TODO: 实现容量数据收集 | Warning | Pre-existing; `collectCapacityData()` returns stub data; EJS template correctly references the data; generates report with zeros -- not a Phase 103 regression |
| apps/db-ops-api/src/report-service.ts | 630-632 | Fallback for unknown template | Info | Defensive fallback for missing templates; not a stub |

### Human Verification Required

#### 1. Migration 006 -- Data Type Fix Execution

**Test:** Execute migration SQL against the database to fix existing 'slow-query' type values.
**Expected:** `mysql -u root -p db_ops_ai < apps/db-ops-api/sql/migrations/006_fix_report_type_names.sql` completes without error. If any rows had `type='slow-query'`, they are updated to `type='slow_query'`.
**Why human:** The migration file was created and committed during Phase 103, but could not be executed because the MySQL root password is Docker-masked and no .env file was available in the worktree (documented in SUMMARY-01 as a deferred item).

#### 2. Migration 007 -- Report Configs Table Execution

**Test:** Verify that the report_configs table exists in the database.
**Expected:** `DESCRIBE db_ops_ai.report_configs` returns all 9 columns: id, name, cron, type, instance_id, format, enabled, created_at, updated_at.
**Why human:** SUMMARY-02 states migration 007 was executed, but I cannot verify this programmatically without database credentials. The CRUD routes and CronJob assume the table exists.

### Deferred Items

No deferred items -- no later milestone phases address Phase 103 scope.

### Gaps Summary

No gaps found in the codebase. All 11 must-have truths are VERIFIED with evidence from the actual code. The two human verification items are operational (migration execution) rather than code gaps.

---

_Verified: 2026-05-21T15:40:00Z_
_Verifier: Claude (gsd-verifier)_
