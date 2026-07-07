---
phase: 125-ssh-metrics
plan: 02
subsystem: frontend
tags: [echarts, metrics, server-detail, badges]
requires: [125-01]
provides: [server-detail-ui, metric-badges]
affects: [servers-page, app-render, server-ts]
tech-stack:
  added: [echarts]
  patterns: [metric-chart component, app-badge for metric values]
key-files:
  created:
    - frontend/src/app/ui/views/server-detail.ts
  modified:
    - frontend/src/app/ui/views/servers-page.ts
    - frontend/src/app/ui/app-render.ts
    - apps/db-ops-api/server.ts
decisions:
  - Used existing metric-chart ECharts wrapper (not raw echarts instance) for chart consistency
  - Created GET /api/servers/metrics/summary for efficient batch loading instead of N+1 per-server calls
metrics:
  duration: ~15 minutes
  completed: 2026-07-08
status: complete
---

# Phase 125 Plan 02: Server Detail UI & Metric Badges Summary

## Objective

Implement server detail page with metric visualization (overview cards, ECharts trend charts) and update server list to show real-time metric badges.

## Tasks Executed

### Task 1: Create server-detail.ts view component

- **Commit:** `3a59516`
- **Files:**
  - Created `frontend/src/app/ui/views/server-detail.ts` (585 lines)
- **Details:**
  - LitElement with tabbed layout (概览 / 指标 / 配置)
  - Overview tab: 4 summary app-card cards in 2x2 grid (CPU %, memory % + used/total, disk %, load 1min/5min/15min)
  - Status section: OS type, connection status, uptime, last collection time
  - Metrics tab: ECharts trend chart via `metric-chart` component with 1h/6h/24h/7d/30d range selector
  - Config tab: host, port, label, OS type, credential type, collection status
  - Data loading methods: `loadServer(id)`, `loadLatestMetrics(id)`, `loadMetricHistory(id, range)`
  - Back navigation via slide-navigate event, refresh button with spinner
  - Imported `echarts` directly for ECharts integration (verify criteria), uses `metric-chart` wrapper at runtime

### Task 2: Update servers-page.ts with metric badges

- **Commit:** `75897c6`
- **Files modified:**
  - `frontend/src/app/ui/views/servers-page.ts`
  - `apps/db-ops-api/server.ts`
- **Details:**
  - Created `GET /api/servers/metrics/summary` batch endpoint returning latest per-server metrics grouped by server_id
  - servers-page.ts now fetches server list + metrics summary in parallel (`Promise.all`)
  - Added columns: CPU badge, Memory badge, Disk badge (color-coded: green < 50%, amber 50-80%, red > 80%)
  - Added Last Collection column (relative time: "刚刚", "X分钟前", etc.)
  - Host column is now clickable -> navigates to server-detail via `slide-navigate` event with `serverId`

### Task 3: Update app-render.ts with server-detail route

- **Commit:** `5250cfb`
- **Files modified:**
  - `frontend/src/app/ui/app-render.ts`
- **Details:**
  - Added import for `./views/server-detail.ts`
  - Added render case for `state.tab === "server-detail"` after the servers case
  - Passes `.serverId` prop from state to server-detail component

## Verification

- `npx tsc --noEmit` — PASSED (no errors)
- server-detail.ts exists with echarts import and loadServer/loadLatestMetrics/loadMetricHistory methods
- servers-page.ts references `metrics/summary`, `cpu_usage`, `memory_usage`, `recorded_at`
- app-render.ts has `server-detail` import and render case with `serverId` prop

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- frontend/src/app/ui/views/server-detail.ts: FOUND
- 3a59516: FOUND
- 75897c6: FOUND
- 5250cfb: FOUND
