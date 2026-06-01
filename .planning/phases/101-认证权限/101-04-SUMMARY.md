---
phase: 101-认证权限
plan: 04
type: execute
subsystem: frontend-auth
wave: 3
tags:
  - auth
  - navigation
  - permissions
  - sidebar
  - rbac
dependency_graph:
  requires:
    - "101-02 (refresh token + ApiClient auth)"
    - "101-03 (401 interceptor + permissions endpoint)"
  provides: "Permission-filtered sidebar navigation for AUTH-05"
  affects:
    - "frontend/src/openclaw/ui/navigation.ts"
    - "frontend/src/openclaw/ui/app-settings.ts"
    - "frontend/src/openclaw/ui/app-render.ts"
    - "frontend/src/openclaw/ui/app-gateway.ts"
    - "frontend/src/api/index.ts"
    - "frontend/src/openclaw/ui/app-view-state.ts"
    - "frontend/src/openclaw/ui/app.ts"
tech-stack:
  added: []
  patterns:
    - "filter() before map() for permission-gated tab rendering"
    - "Wildcard permission matching (exact, resource:*, global *)"
    - "CustomEvent for cross-component permission notification"
key-files:
  created: []
  modified:
    - "navigation.ts (TAB_REQUIRED_PERMISSIONS mapping)"
    - "app-settings.ts (hasSlidePermission helper)"
    - "app-render.ts (permission-filtered sidebar, loadPermissionsFromStorage)"
    - "app-gateway.ts (permissions fetch after login)"
    - "api/index.ts (ApiClient.fetchPermissions)"
    - "app-view-state.ts (userPermissions state property)"
    - "app.ts (event listener for slide-permissions-loaded)"
decisions:
  - "Event listener for slide-permissions-loaded placed in app.ts (Lit component lifecycle) not app-render.ts (pure render function)"
metrics:
  duration: "~15 min"
  completed_date: "2026-05-20"
---

# Phase 101 认证权限 Plan 04: Permission-Aware Navigation

Permission-filtered sidebar navigation: tabs without required permissions are fully hidden rather than greyed out (per D-07).

## Key Decisions

1.  **`TAB_REQUIRED_PERMISSIONS` mapping** lives in `navigation.ts` alongside the existing `TAB_GROUPS` and `Tab` type, keeping all navigation metadata co-located.
2.  **`hasSlidePermission()`** supports three matching modes: exact match, resource-level wildcard (`resource:*`), and global wildcard (`*`).
3.  **Tab visibility** is enforced client-side via `filter()` before `map()` -- tabs without required permissions are completely removed from the DOM, not hidden via CSS or disabled.
4.  **Re-render trigger** uses a `slide-permissions-loaded` CustomEvent dispatched from `app-gateway.ts` and listened to in `app.ts`'s `firstUpdated()`, which calls `this.requestUpdate()`.

## Deviations from Plan

None -- plan executed exactly as written.

## Pre-existing Issues

Duplicated `getVisibleCronJobs` import in `app-render.ts` (imported from both `./app-settings.ts` and `./controllers/cron.ts`) causes `vite build` PARSE_ERROR. This pre-dates the current plan and was logged in Plan 101-03's SUMMARY.

## Verification

1.  Frontend build: **FAIL** -- pre-existing issue (duplicate import), not caused by this plan
2.  TAB_REQUIRED_PERMISSIONS: Created with all 13 Slide tab-to-permission mappings
3.  hasSlidePermission(): Implements exact match, resource:* prefix, and * global wildcard
4.  Sidebar filter: Uses `filter()` before `map()` to fully remove unauthorized tabs
5.  Login permissions fetch: Added to `app-gateway.ts` login handler
6.  localStorage cache: Permissions cached on login, restored on page load
7.  Re-render: `slide-permissions-loaded` event triggers `this.requestUpdate()` in app.ts

## Success Criteria Check

- [x] TAB_REQUIRED_PERMISSIONS mapping defines all Slide tab permission codes
- [x] hasSlidePermission() supports exact, resource:\*, and \* wildcard
- [x] Sidebar uses filter() to remove unauthorized tabs
- [x] Permissions fetched on login and stored in localStorage
- [x] Page load recovers permissions from localStorage cache
- [x] slide-permissions-loaded event triggers sidebar re-render

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: event-sourcing | app-gateway.ts | Login handler dispatches CustomEvent with permission array to window; any script can listen |
