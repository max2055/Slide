---
phase: 126-server-alerts
plan: 01
subsystem: backend
tags: [alerts, servers, monitoring, migration]
depends_on:
  - 125-01
requires: []
provides:
  - ALR-01: alert_rules extended with target_type and server_id columns
  - ALR-02: server metric threshold evaluation via ServerAlertEvaluator
  - ALR-03: server unreachable detection after 10 min of failed collections
  - ALR-04: server alerts routed through existing alert engine pipeline
affects:
  - apps/db-ops-api/src/alert-database-service.ts
  - apps/db-ops-api/src/alert-engine.ts
  - apps/db-ops-api/sql/migrations/021_add_server_alert_fields.sql
  - apps/db-ops-api/src/server-alert-evaluator.ts
tech-stack:
  added: []
  patterns: []
key-files:
  created:
    - apps/db-ops-api/sql/migrations/021_add_server_alert_fields.sql
    - apps/db-ops-api/src/server-alert-evaluator.ts
  modified:
    - apps/db-ops-api/src/alert-database-service.ts
    - apps/db-ops-api/src/alert-engine.ts
decisions:
  - Rule: Server alert evaluation runs inside the existing 60s alert engine cron cycle
  - Rule: createAlert() accepts server_id parameter alongside existing instance_id
  - Rule: findActiveServerAlert() mimics findActiveAlert() but uses server_id instead
  - Rule: Server alerts tagged with source='server-monitor' and tags.target_type='server'
  - Rule: Unreachable detection checks servers with status='unreachable' for >10 min
  - Rule: Dedup via findActiveServerAlert + touchAlert to avoid duplicate alert flooding
metrics:
  duration: ~12 min
  completed_at: '2026-07-07T16:50:00Z'
  tasks_completed: 2
  files_created: 2
  files_modified: 2
status: complete
---

# Phase 126 Plan 01: Backend Server Alert Rule Extension

## Summary

Extended alert_rules, alerts, and alert_events tables with server_id and target_type columns. Created ServerAlertEvaluator with evaluateServerRules() for CPU/memory/disk/load threshold breaches and checkUnreachable() for server unreachable episodes. Wired both into the existing alert engine evaluation loop so server alerts flow through existing notification channels.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create SQL migration for server alert fields | `24afeca` | `apps/db-ops-api/sql/migrations/021_add_server_alert_fields.sql` |
| 2 | Create ServerAlertEvaluator + wire into alert engine | `e28b14e` | `apps/db-ops-api/src/server-alert-evaluator.ts`, `apps/db-ops-api/src/alert-database-service.ts`, `apps/db-ops-api/src/alert-engine.ts` |

## Verification

- [x] Migration 021_add_server_alert_fields.sql exists and contains target_type/server_id references
- [x] server-alert-evaluator.ts exists with evaluateServerRules() and checkUnreachable() methods
- [x] Server alerts wired into existing alert engine cron loop (alert-engine.ts)
- [x] alertDatabaseService.createAlert() accepts server_id parameter
- [x] findActiveServerAlert() available for server alert dedup

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Worktree HEAD mismatch**
- **Found during:** Startup
- **Issue:** Worktree was based on Phase 123 commit (`8006757`), not the expected Phase 125 base (`8a58c54`). Phase 124 and 125 commits (server registration, SSH metric collection) were missing from the worktree.
- **Fix:** Fast-forward merged worktree branch to `8a58c54` via `git merge --ff-only`
- **Files modified:** N/A (git operation only)
- **Commit:** N/A — pre-execution fix

**2. [Migration column placement] Adjusted ALTER TABLE position**
- **Found during:** Task 1
- **Issue:** Plan's SQL template referenced `ALTER TABLE alert_rules ... AFTER instance_id`, but `alert_rules` has `instance_ids` (JSON), not a single `instance_id` column.
- **Fix:** Used `AFTER instance_ids` instead, matching the actual schema.
- **Files modified:** `apps/db-ops-api/sql/migrations/021_add_server_alert_fields.sql`

## Known Stubs

None — all implementations are functional with no placeholder data.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: schema_change | apps/db-ops-api/sql/migrations/021_add_server_alert_fields.sql | New columns on alert_rules, alerts, alert_events tables |
| threat_flag: new_source | apps/db-ops-api/src/server-alert-evaluator.ts | New alert source 'server-monitor' flows through existing pipeline |

## Self-Check: PASSED

- [x] `apps/db-ops-api/sql/migrations/021_add_server_alert_fields.sql` — exists, 17 target_type/server_id references
- [x] `apps/db-ops-api/src/server-alert-evaluator.ts` — exists, 11 evaluateServerRules/checkUnreachable/target_type references
- [x] `apps/db-ops-api/src/alert-database-service.ts` — createAlert accepts server_id, findActiveServerAlert added
- [x] `apps/db-ops-api/src/alert-engine.ts` — imports serverAlertEvaluator, calls evaluateServerRules() and checkUnreachable()
- [x] Commits: `24afeca`, `e28b14e`
