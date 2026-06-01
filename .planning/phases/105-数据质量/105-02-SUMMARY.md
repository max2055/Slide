---
phase: "105-数据质量"
plan: "02"
subsystem: "frontend"
tags: [health-score, trend-chart, scoring-settings, collection-capability]
requires: ["105-01"]
provides: ["健康评分tab", "评分设置页面"]
affects: ["instance-detail", "app-render", "navigation", "i18n"]
tech-stack:
  added: []
  patterns: [metric-chart, collapsible-section, range-slider-form]
key-files:
  created:
    - frontend/src/openclaw/ui/views/health-score-tab.ts
    - frontend/src/openclaw/ui/views/scoring-settings.ts
  modified:
    - frontend/src/openclaw/ui/views/instance-detail.ts
    - frontend/src/openclaw/ui/app-render.ts
    - frontend/src/openclaw/ui/navigation.ts
    - frontend/src/openclaw/i18n/locales/zh-CN.ts
    - frontend/src/openclaw/i18n/locales/en.ts
decisions: []
metrics:
  duration: ""
  completed_date: "2026-05-21"
---

# Phase 105 Plan 02: 前端数据质量展示 Summary

**Objective:** 实现前端数据质量展示：健康评分趋势图、逐项检查详情、采集能力标签、权重配置页面

## Overview

实现了实例详情页「健康评分」tab 的完整前端功能，以及独立的评分权重配置页面。所有组件均使用 LitElement Web Components 构建，遵循现有代码模式。

## Tasks Executed

### Task 1: Create health-score-tab.ts (557 lines)
- Created self-contained LitElement component `health-score-tab` 
- ECharts trend chart via `<metric-chart>` with time range selector (24h/7d/30d)
- Collapsible per-check health detail section with status icons (check-circle/triangle-alert/circle-x) and dimension labels (可用性/性能/容量/安全性)
- Collection capability badges with green (available) or grey (unavailable) indicators
- Parallel data fetching from 3 APIs in `connectedCallback`, authenticated via Bearer token
- Overall score display with color coding (>=80 green, >=60 yellow, <60 red)

**Files:** `frontend/src/openclaw/ui/views/health-score-tab.ts`
**Commit:** 0961992a156

### Task 2: Modify instance-detail.ts for "健康评分" tab
- Added import for `./health-score-tab.js`
- Extended `activeTab` type to include `"health"`
- Added "健康评分" tab button between "趋势" and "会话" tabs
- Added `case "health"` in `_renderTabContent()` switch rendering `<health-score-tab>`

**Files:** `frontend/src/openclaw/ui/views/instance-detail.ts`
**Commit:** 9024618cd29

### Task 3: Create scoring-settings.ts + register in navigation
- Created `scoring-settings.ts` with range sliders for 4 dimensions (0-1, step 0.05), percentage display, sum validation, save via PUT API
- Pattern follows `ai-settings.ts` (token auth, form layout, CSS variables, error/success messages)
- Registered `scoring-settings` as new Tab in `navigation.ts` (TAB_GROUPS, Tab type, TAB_PATHS)
- Added render branch in `app-render.ts` for `state.tab === "scoring-settings"`
- Added i18n entries for zh-CN ("评分权重配置") and en ("Scoring Weights")

**Files:** `frontend/src/openclaw/ui/views/scoring-settings.ts`, `frontend/src/openclaw/ui/app-render.ts`, `frontend/src/openclaw/ui/navigation.ts`, i18n locales
**Commit:** bb942f70d42

## Key Links / Integration Points

| From | To | Pattern |
|------|-----|---------|
| instance-detail.ts | health-score-tab.ts | Import + render in '健康评分' tab case |
| health-score-tab.ts | /api/database/instances/:id/health-history | Fetch score trend data |
| health-score-tab.ts | /api/database/instances/:id/health-checks | Fetch latest per-check details |
| health-score-tab.ts | /api/database/instances/:id/collection-capabilities | Fetch collection capability status |
| scoring-settings.ts | /api/scoring/config | Fetch and save scoring weights |

## Deviations from Plan

None — plan executed exactly as written.

## Known Issues

- **Pre-existing build error:** `frontend/src/openclaw/ui/app-render.ts` has duplicate import of `getVisibleCronJobs` from both `app-settings.ts` and `controllers/cron.ts`. This existed before this plan's changes and causes Vite/Rolldown build to fail. My changes (adding `import "./views/scoring-settings.ts"` and a render branch) are syntactically and semantically correct.

## Threat Surface

No new threat surface introduced. All API calls use the existing Bearer token authentication pattern. No new external packages added. All data fetching endpoints are the same ones established in Plan 105-01.

## Must-Have Verification

| Must-Have | Status |
|-----------|--------|
| "健康评分" tab in instance detail page | Done |
| Trend chart with time range selector (24h/7d/30d) | Done |
| Collapsible per-check health detail with name/status/score/dimension | Done |
| Collection capability badges (green/grey) | Done |
| Scoring weight config page with save | Done |
| health-score-tab.ts >= 200 lines | 557 lines |
| scoring-settings.ts >= 100 lines | 257 lines |

## Success Criteria

- [x] "健康评分" tab renders in instance detail with trend chart, per-check details, collection badges
- [x] Trend chart uses ECharts via metric-chart component with time range selector (24h/7d/30d)
- [x] Per-check items show status icons, scores, dimension labels in collapsible layout
- [x] Collection capability badges show green (available) or grey (unavailable)
- [x] Scoring weight settings page loads current weights and saves updated weights
