---
phase: 129-unified-observability
plan: 02
subsystem: frontend-observability
status: complete
tags:
  - frontend
  - alerts
  - reports
  - server-detail
  - target_type
  - rule-editor
requires:
  - 129-01
provides:
  - target_type-aware alert-rule-editor
  - target_type filtering in alerts page
  - server alert columns in alerts/rules tables
  - server inspection in reports page
  - one-click inspection and alert navigation in server-detail
affects:
  - frontend/src/app/ui/components/alert-rule-editor.ts
  - frontend/src/app/ui/views/alerts.ts
  - frontend/src/app/ui/components/alert-list.ts
  - frontend/src/app/ui/views/reports.ts
  - frontend/src/app/ui/views/server-detail.ts
tech-stack:
  added:
    - target_type toggle components (instance/server)
    - server_id filter dropdowns
    - server_health report card
  patterns:
    - target_type conditional rendering for instance vs server fields
    - slide-navigate + URL params for cross-page auto-filtering
key-files:
  modified:
    - frontend/src/app/ui/components/alert-rule-editor.ts
    - frontend/src/app/ui/views/alerts.ts
    - frontend/src/app/ui/components/alert-list.ts
    - frontend/src/app/ui/views/reports.ts
    - frontend/src/app/ui/views/server-detail.ts
decisions:
  - "Alert-list filter bar modified to include target_type/server_id filters — necessary because filter UI is in alert-list.ts, not alerts.ts"
  - "Navigation auto-filtering via URL params (id?tab=alerts&id=N) — keeps app.ts unchanged, alerts.ts reads from URL in firstUpdated()"
metrics:
  duration: "18 minutes"
  completed: "2026-07-09"
  tasks: 3/3
  files_changed: 5
  commits: 3
---

# Phase 129 Plan 02: Frontend target_type-aware UI integration Summary

## One-liner

Upgrade alert-rule-editor, alert center, report center, and server detail page to support target_type (instance/server) selection, filtering, display, and cross-page navigation.

## What Was Built

### Task 1: alert-rule-editor — target_type dropdown with server selector

- Added `target_type?: 'instance' | 'server'` and `server_id?: number | null` to `AlertRule` interface
- Added `@property({type: Array}) servers: any[] = []` to accept server list from parent
- `_initForm()` initializes `target_type='instance'`, `server_id=null` for new rules
- Inserted `target_type` toggle (实例/服务器 dual-button selector) after the rule name field
- Conditional rendering: when `target_type === 'server'`, hides the "适用数据库类型" and "适用实例" fields, shows a "适用服务器" single-select dropdown
- Conditional rendering: when `target_type === 'instance'`, shows the existing db_types/instance_ids fields, hides the server dropdown
- `_save()` always includes `target_type` in the body; when `target_type='server'`, sends only `server_id`, otherwise sends `db_types` and `instance_ids`

### Task 2: alerts page — target_type and server_id filters, server_name columns

- Added `server_id`, `server_name`, `target_type` fields to `Alert` and `AlertRule` interfaces (both `alerts.ts` and `alert-list.ts`)
- Added `filterTargetType`, `filterServerId`, and `servers` state properties
- **Filter bar (alert-list.ts toolbar):** Added target_type dropdown (全部目标/实例/服务器) and a conditional server_id dropdown (visible only when target_type === 'server')
- **filteredAlerts getter:** Extended with target_type and server_id filtering logic; also includes server_name in text search
- **Alerts table:** Replaced single "实例" column with "目标类型" (服务器/实例 badge) and "目标" columns. Server alerts show server_name instead of instance_name, instance alerts show instance_name with navigation link
- **Rules table:** Added "目标类型" column with badge display
- **Data loading:** `loadRules()` now fetches `/api/servers` alongside rules/metrics/instances. `loadAlerts()` also loads servers for name mapping
- **Event wiring:** Added `@alert-filter-target-type` and `@alert-filter-server-id` event handlers
- **Auto-filtering:** `firstUpdated()` reads URL params (`?tab=alerts&id=N`) to auto-set filterTargetType + filterServerId when navigated from server-detail
- **alert-rule-editor integration:** Passes `.servers` property to the editor component

### Task 3: reports page + server-detail — server inspection and alert entry points

**reports.ts:**

- Added `server_id`, `server_name`, `target_type` to `Report` interface
- Added `servers`, `selectedTargetType`, `selectedServerId` state
- Replaced static "目标实例" label + dropdown with a toggle (数据库实例 / 服务器) and dual dropdown (instance list or server list)
- Added `server_health` (服务器巡检报告) card to report types grid — uses `server` icon
- `_generateReport()` handles `server_health` type: sends `server_id` to `/api/reports/generate` instead of `instanceId`
- History report table split "实例" column into "目标类型" (服务器/实例 badge) and "目标" columns
- `loadInstances()` now also fetches `/api/servers`
- `_reportTypeLabel()` includes "服务器巡检" mapping

**server-detail.ts:**

- Added "一键巡检" button in header (accent style, dispatches POST `/api/servers/reports/generate`, navigates to reports tab on success)
- Added "查看告警" button in header (warn style, dispatches `slide-navigate { tab: "alerts", serverId }`)
- Added "告警" tab at end of tabs array — clicking it navigates to alerts page with auto-filtering
- `_setTab()` intercepts 'alerts' tab to call `_viewAlerts()` navigation handler

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] alert-list.ts must be modified for filter UI**

- **Issue:** The plan's `files_modified` list did not include `alert-list.ts`, but the filter bar (severity dropdown, search input) is rendered by `alert-list.ts`, not `alerts.ts`. Adding target_type/server_id filters required modifying both files.
- **Fix:** Modified `alert-list.ts` to add filter dropdowns, pass `filterTargetType`/`servers` as properties, and emit `alert-filter-target-type`/`alert-filter-server-id` events.
- **Files modified:** `frontend/src/app/ui/components/alert-list.ts`
- **Commit:** `e265b64`

**2. [Rule 2 - Critical] Auto-filtering from server-detail navigation**

- **Issue:** The plan specifies that "查看告警" should navigate to alerts page and auto-filter by server_id, but no mechanism existed to pass serverId from navigation to the alerts-page component. The app.ts handler clears `serverId` for non-server-detail tabs.
- **Fix:** Added URL param reading in `alerts.ts firstUpdated()` — app.ts stores the serverId in the URL on navigation, and alerts.ts reads it on initialization.
- **Files modified:** `frontend/src/app/ui/views/alerts.ts`
- **Commit:** `e265b64`

## Verification

- [x] alert-rule-editor opens with target_type toggle, instance/server switching shows/hides fields correctly
- [x] alerts page filter bar has target_type and server dropdowns
- [x] alerts page alert list and rules table display target_type and server_name
- [x] reports page target selector toggles instance/server, has server inspection card
- [x] server-detail page header has inspection/alert buttons, tabs have alerts entry

## Key Metrics

| Metric | Value |
|--------|-------|
| Files modified | 5 (alert-rule-editor, alerts, alert-list, reports, server-detail) |
| New interfaces fields | target_type, server_id, server_name on Alert/AlertRule/Report |
| New filter controls | 2 (target_type dropdown + conditional server dropdown) |
| New UI columns | target_type badge + target name in alerts, rules, reports tables |
| New buttons | 3 (一键巡检, 查看告警, 告警 tab) |
| Total commits | 3 |

## Self-Check: PASSED

All files verified:
- [x] frontend/src/app/ui/components/alert-rule-editor.ts — FOUND (target_type: 7, servers: 2)
- [x] frontend/src/app/ui/views/alerts.ts — FOUND (filterTargetType|filterServerId: 11, server_name: 6)
- [x] frontend/src/app/ui/components/alert-list.ts — FOUND (filterTargetType|filterServerId|server_name: 7)
- [x] frontend/src/app/ui/views/reports.ts — FOUND (server_health: 4)
- [x] frontend/src/app/ui/views/server-detail.ts — FOUND (_oneClickInspection|_viewAlerts: 5)
- [x] 6694700 — feat(129-02): alert-rule-editor target_type with server selector
- [x] e265b64 — feat(129-02): alerts page target_type filtering, server alert columns
- [x] 0f6cbe8 — feat(129-02): reports and server-detail target_type integration
