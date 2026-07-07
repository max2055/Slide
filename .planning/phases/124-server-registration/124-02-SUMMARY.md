---
phase: 124-server-registration
plan: 02
subsystem: frontend
tags: [navigation, i18n, servers-page, tab-integration]
requires: [124-01]
provides: [navigation-servers-tab, i18n-servers-labels, app-render-servers-integration]
affects: [frontend/src/app/ui/navigation.ts, frontend/src/app/i18n/locales/zh-CN.ts, frontend/src/app/i18n/locales/en.ts, frontend/src/app/ui/app-render.ts]
tech-stack:
  added: []
  patterns: [shared component import, i18n label mapping, permission-gated tab routing]
key-files:
  created: []
  modified:
    - frontend/src/app/ui/navigation.ts
    - frontend/src/app/i18n/locales/zh-CN.ts
    - frontend/src/app/i18n/locales/en.ts
    - frontend/src/app/ui/app-render.ts
decisions:
  - servers tab icon: 'server' (available in icons.ts)
  - servers tab placement: before 'instances-db' in TAB_GROUPS (D-11)
  - servers permission: 'servers:view' (matching backend route guard)
  - servers tab path: '/servers'
metrics:
  duration: 5m
  tasks: 1
  files-modified: 4
  commits: 4
status: complete
---

# Phase 124 Plan 02: Update Navigation, i18n, and App Integration — Summary

Updated navigation sidebar, Chinese/English i18n labels, and app-render to integrate the servers management tab. Navigation now shows "服务器管理" under "运维" group above "数据库管理" per D-10/D-11/D-12 label conventions.

## Changes Made

**A) navigation.ts** — Added "servers" to TAB_GROUPS (before "instances-db"), Tab type union, TAB_PATHS (`/servers`), DEFAULT_TAB_OPTIONS, TAB_REQUIRED_PERMISSIONS (`servers:view`), and iconForTab (`server` icon).

**B) zh-CN.ts** — Renamed nav.slide ("数据库运维" to "运维"), tabs.instances-db ("实例管理" to "数据库管理"), subtitles.instances-db ("数据库实例管理" to "纳管数据库实例"). Added tabs.servers ("服务器管理"), subtitles.servers ("纳管服务器与SSH凭据管理"), nav.servers ("服务器管理").

**C) en.ts** — Renamed tabs.instances-db ("Instances" to "Databases"), subtitles.instances-db ("Database instances management." to "Managed database instances."). Added tabs.servers ("Servers"), subtitles.servers ("Manage servers and SSH credentials.").

**D) app-render.ts** — Added import for `./views/servers-page.ts` and render case for `state.tab === "servers"` -> `<servers-page>` after instances-db.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None.

## Commits

| # | Hash | Message |
|---|------|---------|
| 1 | 66d7b0b | feat(124-02): update navigation.ts with servers tab entry |
| 2 | 0a575f1 | feat(124-02): update zh-CN i18n with renamed labels and servers entries |
| 3 | 02824ee | feat(124-02): update en i18n with renamed labels and servers entries |
| 4 | 90a9894 | feat(124-02): integrate servers-page into app-render |

## Self-Check: PASSED

- [x] navigation.ts: servers in TAB_GROUPS, Tab type, TAB_PATHS, TAB_REQUIRED_PERMISSIONS, DEFAULT_TAB_OPTIONS, iconForTab (6 occurrences of 'servers')
- [x] zh-CN.ts: servers tab ("服务器管理", 2 occurrences), nav.slide ("运维"), tabs.instances-db ("数据库管理")
- [x] en.ts: servers tab ("Servers"), tabs.instances-db ("Databases")
- [x] app-render.ts: import + render case (2 occurrences of 'servers-page', including render tag)
- [x] No old "实例管理" label remains in zh-CN tabs
- [x] Each change committed individually (4 commits, all feat type)
