---
phase: 105-数据质量
created: 2026-05-21
status: drafted
nyquist_compliance: true
---

# Phase 105: 数据质量 — Validation Strategy

## Critical Failure Modes

| Mode | Description | Mitigation |
|------|-------------|------------|
| F1 | Scoring weights not configurable (hardcoded) | Verify weights read from system_config, not code constants |
| F2 | health_check_history.checks JSON not displayed | Verify per-check detail rendered in instance detail page |
| F3 | Collection capability shows wrong status | Verify db_type matching + actual collection success tracking |
| F4 | Trend chart shows empty or wrong data | Verify health-history API returns correct time-series |
| F5 | Missing dimension returns 0 instead of neutral | Verify neutral-100 fallback for dimensions with no checks |

## Validation Dimensions

### 1. Scoring Algorithm Correctness
- **Metric:** Multi-dimension weighted score matches expected formula
- **Evidence:** Unit test for calculateDimensionScores() with known input

### 2. Configurability
- **Metric:** Weight changes in settings page reflect in score computation
- **Evidence:** Integration test: update weight → recompute → verify new score

### 3. Trend Chart
- **Metric:** Chart renders health_check_history data points correctly
- **Evidence:** Human verification of chart with known time range

### 4. Collection Capability
- **Metric:** Green badge for collected metrics, grey for unsupported
- **Evidence:** Verify capability API returns correct status per instance

### 5. Per-Check Detail
- **Metric:** checks JSON renders as collapsible detail with pass/fail status
- **Evidence:** Human verification of health check breakdown display

## Validation Architecture

| Layer | What to Validate | How |
|-------|-----------------|-----|
| Backend | Scoring algorithm | Unit test: scoring-service.test.ts |
| Backend | Collection tracking | Unit test: collection-capabilities.test.ts |
| Backend | API routes | Integration test: health-history.test.ts |
| Frontend | Trend chart + detail | Human UAT |
| Frontend | Weight settings | Human UAT |

## Test Strategy

### Backend (105-01)
- Test scoring-service.ts calculateDimensionScores() with varied input
- Test collection-capabilities.ts tracking in-memory
- Test health-history and health-checks API endpoints

### Frontend (105-02)
- Verify health score tab renders with ECharts
- Verify per-check detail collapsible sections
- Verify collection capability green/grey badges
- Verify scoring weight settings page saves and loads

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| DB types missing dimension checks | High | Neutral 100 for dimensions with zero checks |
| Collection capability data stale after restart | Medium | Accept for v1; document limitation |
| ECharts rendering issue with new tab | Low | Reuse existing metric-chart component pattern |
