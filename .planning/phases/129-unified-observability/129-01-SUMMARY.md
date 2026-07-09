---
phase: 129-unified-observability
plan: 01
subsystem: backend-observability
status: complete
tags:
  - backend
  - metrics
  - alerts
  - templates
  - target_type
  - server-observability
requires: []
provides:
  - metric_definitions target_type
  - server OS metrics in MetricRegistry
  - alert_rule_templates table + CRUD
  - target_type-aware API routes
affects:
  - apps/db-ops-api/server.ts
  - apps/db-ops-api/src/metric-registry.ts
  - apps/db-ops-api/src/metric-database-service.ts
tech-stack:
  added:
    - alert-rule-template-service.ts (new service)
    - 022_unified_observability.sql (migration)
  patterns:
    - target_type ENUM('instance','server') for metric/alert differentiation
    - ENUM column added AFTER id (consistent with migration 021)
    - MetricRegistry getAll/getByTargetType dual access pattern
key-files:
  created:
    - apps/db-ops-api/sql/migrations/022_unified_observability.sql
    - apps/db-ops-api/src/alert-rule-template-service.ts
  modified:
    - apps/db-ops-api/src/metric-registry.ts
    - apps/db-ops-api/src/metric-database-service.ts
    - apps/db-ops-api/server.ts
decisions:
  - "MetricRegistry shares same metric IDs between instance and server (cpu_usage, memory_usage, disk_usage) — differentiated by target_type + db_types"
  - "Server metrics have db_types=[] because they don't differentiate by database type"
  - "alert_rule_templates CRUD follows template-database-service pattern"
metrics:
  duration: "15 minutes"
  completed: "2026-07-08"
  tasks: 3/3
  files_changed: 5
  commits: 3
---

# Phase 129 Plan 01: Backend Metric Registry target_type + Alert Template Service Summary

## One-liner

Add target_type support to metric_definitions table and MetricRegistry, register 9 server OS-level metric definitions, create alert_rule_templates table with 5 server preset templates, and expose target_type-aware API routes.

## What Was Built

### Task 1: Migration SQL (022_unified_observability.sql)

- **metric_definitions** — idempotent addition of `target_type ENUM('instance','server') NOT NULL DEFAULT 'instance'` column AFTER id, with bulk UPDATE setting existing rows to 'instance'
- **alert_rule_templates** — new table with 13 columns, indexes on `target_type` and `metric_name`, ENGINE InnoDB utf8mb4
- **Seed data** — 5 server preset alert templates (CPU过高, 内存过高, 磁盘过高, 负载过高, 服务器不可达) inserted via INSERT IGNORE
- All operations wrapped in START TRANSACTION / COMMIT

### Task 2: MetricRegistry target_type support + Server Metrics

- Added `target_type?: string` to `MetricDefinitionRow` interface
- Added `target_type?: 'instance' | 'server'` to `MetricDefinition` interface
- Updated `_rowToDefinition()` to map DB rows' target_type
- Added `getByTargetType(targetType: string): MetricDefinition[]` method
- Updated `getAll()` with optional `targetType?: string` parameter for in-place filtering
- Updated `_seedPredefinedToDB()` to pass `target_type` field, and `createMetric()` in metric-database-service to accept it
- Registered 9 server OS-level metrics: cpu_usage(OS), memory_usage(OS), disk_usage(OS), load_1min, load_5min, load_15min, swap_usage, uptime, os_type

### Task 3: AlertRuleTemplateService + API Routes

- Created `apps/db-ops-api/src/alert-rule-template-service.ts` with `AlertRuleTemplateDatabaseService` class:
  - `listTemplates(options?)` — filter by target_type/enabled
  - `getTemplate(id)` — single template by ID
  - `createTemplate(data)` — create with full field support
  - `updateTemplate(id, data)` — partial update
  - `deleteTemplate(id)` — delete with not-found check
- Added 5 API routes in server.ts:
  - `GET /api/alert-rule-templates` — list with target_type/enabled query params
  - `GET /api/alert-rule-templates/:id` — single
  - `POST /api/alert-rule-templates` — create (requirePermission 'alerts:manage')
  - `PUT /api/alert-rule-templates/:id` — update (requirePermission 'alerts:manage')
  - `DELETE /api/alert-rule-templates/:id` — delete (requirePermission 'alerts:manage')
- Updated `GET /api/metrics/registry` to accept `?target_type=` query param
- Added `022_unified_observability.sql` to auto-applied migrations list

## Deviations from Plan

None — plan executed exactly as written.

## Verification

- [x] Migration SQL file contains target_type column and alert_rule_templates table
- [x] MetricRegistry returns server metrics (`grep -c getByTargetType` = 1, `grep -c target_type` = 16 in metric-registry.ts)
- [x] GET /api/metrics/registry?target_type=server returns server metrics (via updated route handler)
- [x] GET /api/alert-rule-templates routes registered (5 routes) with alertRuleTemplateService import

## Key Metrics

| Metric | Value |
|--------|-------|
| Migration file | 022_unified_observability.sql |
| Server metrics registered | 9 (cpu, memory, disk, load_1/5/15, swap, uptime, os_type) |
| Server preset alert templates seeded | 5 |
| API routes added | 5 (alert templates) + 1 enhanced (metrics registry) |
| New files | 2 |
| Modified files | 3 |
| Total commits | 3 |

## Self-Check: PASSED

All files verified:
- [x] apps/db-ops-api/sql/migrations/022_unified_observability.sql — FOUND (67 lines, target_type + alert_rule_templates)
- [x] apps/db-ops-api/src/alert-rule-template-service.ts — FOUND (209 lines, CRUD service)
- [x] apps/db-ops-api/src/metric-registry.ts — has target_type field, getByTargetType method
- [x] apps/db-ops-api/src/metric-database-service.ts — has target_type in createMetric
- [x] apps/db-ops-api/server.ts — has import, alert-rule-templates routes, metrics/registry target_type support
- [x] 6ecfe4f — feat(129-01): migration file
- [x] c0fc359 — feat(129-01): MetricRegistry target_type
- [x] 704b142 — feat(129-01): AlertRuleTemplateService + routes
