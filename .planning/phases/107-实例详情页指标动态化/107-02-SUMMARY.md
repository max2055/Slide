---
phase: 107-实例详情页指标动态化
plan: 02
subsystem: ui
tags: [lit, web-components, dynamic-rendering, metric-cards, trend-charts]

requires:
  - phase: 107-01
    provides: metricRegistry API with category, is_collected, value_type fields
provides:
  - Dynamic metric card rendering grouped by category from _filteredRegistry
  - Dynamic trend chart rendering per collected metric
  - Record-based state types for arbitrary metric IDs
affects: [108, 109]

tech-stack:
  added: []
  patterns:
    - "Data-driven rendering from metric_definitions registry"
    - "Hash-based chart color assignment (_getChartColor)"
    - "Threshold-based metric value coloring (_getMetricColor)"

key-files:
  modified: [frontend/src/app/ui/views/instance-detail.ts]

key-decisions:
  - "Rendering groups metric cards by category but trends as flat list"
  - "Per-metric empty state (暂无数据) rather than entire-section empty for metrics with no value"
  - "Hash-based palette for chart color consistency across renders"

requirements-completed: [DYNMET-01]

duration: 35min
completed: 2026-05-27
---

# Phase 107 Plan 02: Dynamic Metric Rendering Summary

**Frontend instance-detail.ts updated from 4 hardcoded metric cards to data-driven rendering iterating _filteredRegistry with category grouping, per-metric empty states, and dynamic trend charts**

## Performance

- **Duration:** 35 min
- **Started:** 2026-05-27T12:20:00Z
- **Completed:** 2026-05-27T12:55:00Z
- **Tasks:** 3
- **Files modified:** 1

## Accomplishments

- State types (trendData, metricsHistory, overviewHistory) changed from hardcoded keys to `Record<string, number[]>` for arbitrary metric ID support
- metricsHistory update now iterates `_filteredRegistry` dynamically instead of 4 hardcoded keys
- loadTrendData builds `metrics` query parameter from collected metric IDs
- New `_renderDynamicMetrics()` groups collected metrics by category with per-category cards
- New `_renderDynamicCard()` shows value from fixed column or metrics_data JSON, with per-metric empty state
- New `_renderDynamicTrend()` renders `<metric-chart>` for each collected metric with data
- Overview sparklines now use first 4 collected metrics dynamically
- `_getChartColor()`, `_getMetricColor()`, `_getProgressClass()` helpers for dynamic coloring

## Task Commits

Each task was committed atomically:

1. **Task 1: Update state types for dynamic metrics** - `24d8986` (feat)
2. **Task 2: Update data-loading methods** - `c6a3ace` (feat)
3. **Task 3: Implement dynamic rendering** - `4cfb069` (feat)

**Deviations:** `94bebae` (fix - added metrics_data to MetricsData interface)

## Files Created/Modified

- `frontend/src/app/ui/views/instance-detail.ts` - State types, data loading, and rendering methods updated for dynamic metric-driven display

## Decisions Made

- Metric cards are grouped by category (from `metric_definitions.category`) but trends render as a flat list
- Per-metric empty state renders "暂无数据" with 0.5 opacity for metrics that have no current value
- Chart colors are assigned via hash of metric ID over an 8-color palette, ensuring consistency across renders
- Color thresholds use threshold_template levels when available, or default 80/60 thresholds as fallback

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added metrics_data field to MetricsData interface**
- **Found during:** Task 3 (Dynamic rendering implementation)
- **Issue:** `MetricsData` interface lacked `metrics_data?: Record<string, number>` field, causing TS2339 compile error when `_renderDynamicCard()` tried to access `this.metrics?.metrics_data?.[def.id]`
- **Fix:** Added `metrics_data?: Record<string, number>` to the `MetricsData` interface (line ~55)
- **Files modified:** `frontend/src/app/ui/views/instance-detail.ts`
- **Verification:** TypeScript compilation for instance-detail.ts passes with no errors
- **Committed in:** `94bebae` (separate fix commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Essential for custom metrics stored in metrics_data JSON column to render correctly. No scope creep.

## Issues Encountered

- TypeScript error TS2339 on `this.metrics?.metrics_data` - fixed by adding missing field to MetricsData interface

## Known Stubs

None. All metrics render dynamically from registry data with proper empty states.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| (none) | | No new security-relevant surface introduced |

All changes are in frontend rendering code. No new network endpoints, auth paths, or data access patterns were introduced.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Dynamic metric rendering ready for consumption by follow-up phases (108+) that need metric-driven UI
- Backend history API with `metricIds` query parameter is consumed by loadTrendData but still needs the server-side handler to process the parameter (if not already done in 107-01)

---
*Phase: 107-实例详情页指标动态化*
*Completed: 2026-05-27*
