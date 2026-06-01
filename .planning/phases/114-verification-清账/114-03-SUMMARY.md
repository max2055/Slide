---
phase: 114-verification-清账
plan: 03
subsystem: alert-engine
tags: alerting dedup auto-recovery availability
provides:
  - Alert dedup: findActiveAlert + touchAlert prevent duplicate alert creation
  - Auto-recovery: active alerts auto-resolve when metrics return to healthy range
  - Missing data handling: getMetricValue returns null (not 0) for absent metrics
  - Availability alert: single alert when instance unreachable instead of 50+ false metric alerts
affects: alert-engine, alert-evaluator, alert-database-service
tech-stack:
  added: []
  patterns:
    - Dedup via findActiveAlert + touchAlert (check-then-touch pattern)
    - Auto-recovery loop inside evaluateAndCreateAlerts
key-files:
  modified:
    - apps/db-ops-api/src/alert-database-service.ts
    - apps/db-ops-api/src/alert-engine.ts
    - apps/db-ops-api/src/alert-evaluator.ts
    - apps/db-ops-api/src/__tests__/alert-evaluator-merge.test.ts
key-decisions:
  - "Use rule_id from tags.tags.rule_id for auto-recovery (alerts table stores rule_id in JSON tags, not as a direct column)"
  - "Availability pseudo-rule uses rule_id=0 — excluded from dedup check, gets availability alert_type via typeMap"
duration: 6min
completed: 2026-05-27
---

# Phase 114: Verification Plan 03 — Alert Mechanism Fix Summary

**Alert dedup, auto-recovery, and missing-data handling: stop alert spam from duplicate creation, auto-resolve on recovery, null instead of 0 for missing metrics, single availability alert on instance down.**

## Performance
- **Duration:** 6 minutes
- **Tasks:** 3/3
- **Files modified:** 4

## Accomplishments
- Alert dedup: `createAlertFromRule()` now calls `findActiveAlert()` before creating — if an unresolved alert exists for the same instance+metric+rule, it touches (updates metric_value/updated_at) instead of creating a duplicate
- Auto-recovery: after each evaluation cycle, iterates all active alerts and auto-resolves any whose metric has returned to the healthy range (checked via `isValueHealthy`)
- Missing data: `getMetricValue()` returns `null` (not `0`) when metric data is absent, preventing false threshold triggers
- Availability detection: when `getRealtimeMetrics()` returns null (instance unreachable), creates a single `_availability` critical alert and skips all metric rules for that instance

## Task Commits
1. **Task 1: Add alert dedup — findActiveAlert + touchAlert** - `8f5162da67c`
2. **Task 2: Add auto-recovery — resolve alerts when metrics return to healthy range** - `2e033e24e59`
3. **Task 3: Handle missing metrics — return null + availability alerts** - `c106e7c00da`
4. **Cleanup: Fix TypeScript type errors** - `bb0b5e8fcb8`

## Files Created/Modified
- `apps/db-ops-api/src/alert-database-service.ts` — Added `_rowToAlert`, `findActiveAlert`, `touchAlert`, `getActiveAlerts`, `getRuleById`
- `apps/db-ops-api/src/alert-engine.ts` — Dedup check before alert creation, auto-recovery loop after evaluation, `_availability` in typeMap
- `apps/db-ops-api/src/alert-evaluator.ts` — `getMetricValue` returns `number | null`, `isValueHealthy` function, updated `checkDuration` null handling, availability alert in `evaluateAllRules`
- `apps/db-ops-api/src/__tests__/alert-evaluator-merge.test.ts` — Updated tests to expect `null` instead of `0` for missing metrics

## Decisions & Deviations
- **Auto-recovery rule lookup**: The `alerts` table stores `rule_id` in the `tags` JSON column, not as a direct column. The auto-recovery loop extracts it from `alert.tags.rule_id` rather than adding a new column.
- **Availability pseudo-rule**: Uses `rule.id = 0` as a sentinel. The dedup check explicitly skips `rule.id !== 0`, so availability alerts always get created fresh. The typeMap maps `_availability` to `'availability'` alert_type.
- **No architectural changes**: All fixes stayed within the existing method signatures and module boundaries — no new tables, services, or API endpoints.

## Next Phase Readiness
- Alert spam root causes addressed (dedup + auto-recovery + false triggers from missing data)
- Notification service can proceed with confidence that it won't see duplicate alerts per cycle
- Future phases can add more sophisticated dedup (time-window merging, severity-based dedup)
