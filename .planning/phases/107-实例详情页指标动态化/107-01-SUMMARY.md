---
phase: 107-实例详情页指标动态化
plan: 01
subsystem: api
tags: [metrics, registry, history-api, json-extract, typescript]
requires:
  - phase: 106-指标采集可配置化
    provides: MetricDefinitionRow with category/value_type fields in DB schema
provides:
  - MetricDefinition interface with category and value_type fields
  - getHistoricalMetricsWithRange with 4th optional metricIds parameter
  - JSON_EXTRACT-based SELECT for dynamic (non-fixed-column) metric IDs
affects: [107-02, frontend history chart]

tech-stack:
  added: []
  patterns:
    - Dynamic column selection via JSON_EXTRACT for non-fixed-column metrics
    - Backward-compatible 4th parameter pattern (undefined = old behavior)
    - Fixed vs dynamic column split for history queries

key-files:
  created: []
  modified:
    - apps/db-ops-api/src/metric-registry.ts
    - apps/db-ops-api/src/metrics-database-service.ts

key-decisions:
  - "Made value_type optional in MetricDefinition interface to allow predefined metrics to omit it (defaults to gauge)"
  - "Defined FIXED_COLUMNS as const tuple for compile-time safety when filtering metric IDs"

patterns-established:
  - "Dynamic metric columns: query via JSON_EXTRACT(metrics_data, '$.<id>') with AS alias matching the metric ID"

requirements-completed: [DYNMET-01]

duration: 15min
completed: 2026-05-27
---

# Phase 107 Plan 01: Backend History API + Registry category/value_type Summary

**MetricDefinition interface gains category/value_type; getHistoricalMetricsWithRange supports JSON_EXTRACT for dynamic metric lookups**

## Performance

- **Duration:** 15 min
- **Started:** 2026-05-27T12:26:00Z
- **Completed:** 2026-05-27T12:41:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- MetricDefinition interface extended with `category?: string` and `value_type?: 'gauge' | 'counter' | 'histogram'`
- _rowToDefinition() maps both fields from MetricDefinitionRow (category defaults to undefined, value_type defaults to 'gauge')
- getHistoricalMetricsWithRange() accepts optional 4th `metricIds?: string[]` parameter
- FIXED_COLUMNS const defines the 11 physical columns for backward-compat default behavior
- Both aggregated (DATE_FORMAT) and non-aggregated (interval='1m') paths support JSON_EXTRACT for dynamic metric IDs
- Existing server.ts 4-argument call compiles correctly after the change
- Backward compatible: no metricIds = same behavior as before (11 fixed columns)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add category and value_type to MetricDefinition interface and _rowToDefinition** - `71869bf` (feat)
2. **Task 2: Implement 4th metricIds parameter with JSON_EXTRACT support** - `ee5370b` (feat)

## Files Created/Modified

- `apps/db-ops-api/src/metric-registry.ts` - Added `category?: string` and `value_type?:` to MetricDefinition interface; added field mappings in _rowToDefinition()
- `apps/db-ops-api/src/metrics-database-service.ts` - Added 4th `metricIds?` param to getHistoricalMetricsWithRange; FIXED_COLUMNS const; JSON_EXTRACT-based SELECT for dynamic metric IDs in both aggregated and non-aggregated paths

## Decisions Made

- Made `value_type` optional in the interface (not required) so predefined metrics in _getPredefinedMetrics() can omit it (they default to 'gauge' when loaded from DB via _rowToDefinition)
- Used `as const` on the FIXED_COLUMNS tuple for better type inference

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Made value_type optional to avoid breaking predefined metrics compilation**
- **Found during:** Task 1 (TypeScript compilation check)
- **Issue:** Plan specified `value_type: 'gauge' | 'counter' | 'histogram'` as a required field, but all 24 predefined MetricDefinition objects in _getPredefinedMetrics() lack this field. Plan instructed "Do NOT modify predefined metrics." Making it required breaks compilation.
- **Fix:** Changed to `value_type?: 'gauge' | 'counter' | 'histogram'` (optional with `?`). The _rowToDefinition mapping already provides `row.value_type || 'gauge'` for DB-loaded rows. Predefined metrics without value_type are treated as 'gauge' at query time.
- **Files modified:** apps/db-ops-api/src/metric-registry.ts
- **Verification:** TypeScript compilation passes for metric-registry.ts (only remaining error is pre-existing `metrics` vs `metric` dead-code bug on line 456)
- **Committed in:** 71869bf (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Minimal - value_type is still present on all DB-loaded metrics. The only difference is that predefined fallback metrics without value_type will have it as undefined instead of required. This matches the plan's stated intent that "value_type defaults to 'gauge'."

## Issues Encountered

- Worktree HEAD was on the wrong commit (upstream `732db752790` instead of target `60f39d3b6a7`). The merge-base assertion in the startup workflow was using `git merge-base` instead of comparing HEAD directly, so it didn't trigger a reset even though HEAD was wrong. Manually reset to the correct base commit.

## Known Stubs

None - all changes are functional wiring with no placeholder data.

## Threat Flags

None - no new security-relevant surface introduced. The category/value_type fields are non-sensitive metadata (T-107-02 accepted). The metricIds parameter is already whitelist-validated in server.ts (T-107-01 mitigated).

## Next Phase Readiness

- Ready for Phase 107-02: frontend integration to read `category` from metric definitions and `metricIds` from query parameters for the history chart
- The server.ts call at line 1112 now compiles with 4 arguments

---
## Self-Check: PASSED

- FOUND: apps/db-ops-api/src/metric-registry.ts
- FOUND: apps/db-ops-api/src/metrics-database-service.ts
- FOUND: .planning/phases/107-实例详情页指标动态化/107-01-SUMMARY.md
- FOUND: 71869bf (Task 1 commit)
- FOUND: ee5370b (Task 2 commit)

*Phase: 107-实例详情页指标动态化*
*Completed: 2026-05-27*
