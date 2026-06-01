---
phase: 85-rbac-frontend
plan: 01
subsystem: ui
tags: lit, rbac, frontend, admin, crud

# Dependency graph
requires:
  - phase: 84-rbac-foundation
    provides: RBAC backend API endpoints at /api/v1/rbac/*
provides:
  - RBAC admin management page with 4 sub-tab views
  - Settings navigation entry for RBAC tab
  - UserRoleBindingTab with split-pane layout and role badge management
  - InstancePermissionsTab with instance checkbox modal
affects: 85-rbac-frontend (subsequent plans)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Sub-tab switching: parent shell with RbacSubTab union type"
    - "Permission checkbox modal: diff-based save pattern (grant new, revoke removed)"
    - "User role badge: split-pane layout with client-side search"

key-files:
  created:
    - frontend/src/openclaw/ui/views/rbac-page.ts
  modified:
    - frontend/src/openclaw/ui/navigation.ts
    - frontend/src/openclaw/ui/app-render.ts
    - frontend/src/openclaw/i18n/locales/zh-CN.ts
    - frontend/src/openclaw/i18n/locales/en.ts

key-decisions:
  - "5 LitElement classes in a single file (rbac-page.ts) following existing project convention"
  - "Inline fetch wrappers per component (self-contained, no shared api/rbac.ts module)"
  - "RbacAdminPage checks admin access by attempting /api/v1/rbac/roles call on mount"
  - "User-role binding uses GET /api/users with Array.isArray fallback for response format"

patterns-established:
  - "Permission checkbox list grouped by resource using HTML <details> accordion"
  - "Diff-based batch save: track saved state on modal open, compute grant/revoke on save"

requirements-completed:
  - RBAC-09

# Metrics
duration: 45min
completed: 2026-05-10
---

# Phase 85 Plan 01: RBAC Frontend Page Infrastructure Summary

**RBAC admin management page with 4 sub-tab views (roles, permissions, user-role binding, instance permissions), navigation tab registration, i18n labels, and LitElement components for full CRUD operations**

## Performance

- **Duration:** 45 min (total across retries)
- **Started:** 2026-05-10
- **Completed:** 2026-05-10
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Registered "rbac" tab in sidebar navigation (TAB_GROUPS settings, TAB_PATHS, iconForTab) with shield icon
- Created RbacAdminPage parent shell with 4 sub-tab navigation and D-03 target-user receiving logic
- Implemented RoleManagementTab with full CRUD: role table, create/edit modal, delete with confirm, permission edit modal with grouped checkboxes and diff-based save
- Implemented PermissionManagementTab with full CRUD: permission table, create modal with resource:action code validation, delete with confirm
- Implemented UserRoleBindingTab with split-pane layout: searchable user list on left, role badges with add/remove on right
- Implemented InstancePermissionsTab with user table and modal-based instance checkbox management with diff-based grant/revoke
- All 5 custom elements registered and TypeScript-compatible

## Task Commits

Each task was committed atomically:

1. **Task 1: Register "rbac" tab in navigation system and app renderer** - `6623a607df` (feat)
2. **Task 2: Create rbac-page.ts with RbacAdminPage shell, RoleManagementTab, and PermissionManagementTab** - `1282d7089b` (feat)
3. **Task 3: Add UserRoleBindingTab and InstancePermissionsTab to rbac-page.ts** - `575f8d9526` (feat)

## Files Created/Modified

- `frontend/src/openclaw/ui/navigation.ts` - Added "rbac" to Tab type, TAB_GROUPS settings, TAB_PATHS, iconForTab
- `frontend/src/openclaw/ui/app-render.ts` - Added import and render case for rbac-admin-page
- `frontend/src/openclaw/ui/views/rbac-page.ts` - Main RBAC page: 5 LitElement classes (1695 lines)
- `frontend/src/openclaw/i18n/locales/zh-CN.ts` - Chinese labels for rbac tab and subtitle
- `frontend/src/openclaw/i18n/locales/en.ts` - English labels for rbac tab and subtitle

## Decisions Made

- **Single-file convention:** All 5 LitElement classes in one `rbac-page.ts` file following existing project pattern (users-management.ts, llm-config.ts)
- **Self-contained API helpers:** Each sub-tab component has its own `_fetch`/`_fetchJson` helpers rather than a shared api/rbac.ts module
- **Admin access check:** RbacAdminPage probes `/api/v1/rbac/roles` on mount; 403 shows "no permission" message rather than checking JWT role claim (which Phase 84 removed)
- **Instance response handling:** `/api/database/instances` returns an array; `/api/v1/rbac/users/:userId/instances` response is normalized from either IDs or objects via map accessor
- **No shared state module:** Cross-component navigation (badge click to RBAC user-role tab) uses `(window as any).__appState._rbacTargetUserId` pattern matching existing conventions

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- **Worktree file path confusion:** This is a parallel worktree agent. The Edit tool modifies files in the main repo directory, but git operations refer to the worktree's separate working copy. After identifying the issue, the edited file was copied from the main repo to the worktree directory for correct git tracking.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All 4 sub-tab components ready for backend API integration
- D-03 target user navigation receiver implemented (reads `__appState._rbacTargetUserId`)
- Subsequent plan (85-02) can update `users-management.ts` for multi-role badges and instance permission buttons

---
*Phase: 85-rbac-frontend*
*Completed: 2026-05-10*
