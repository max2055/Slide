---
phase: 85-rbac-frontend
plan: 02
subsystem: ui
tags: lit, rbac, frontend, admin, users-management

# Dependency graph
requires:
  - phase: 84-rbac-foundation
    provides: RBAC backend API endpoints at /api/v1/rbac/*, JWT role removal
  - phase: 85-rbac-frontend (01)
    provides: RBAC admin management page with rbac tab, UserRoleBindingTab target-user receiver
provides:
  - Updated users-management.ts with RBAC-compatible admin check via /api/v1/rbac/roles
  - Multi-role badges per user loaded from /api/v1/rbac/users/:id/roles
  - Instance permission modal with live instance list and diff-based grant/revoke
  - Badge click navigation to RBAC user-role binding tab
affects: later phases using users-management page

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Admin check: probe /api/v1/rbac/roles endpoint instead of reading JWT role claim"

key-files:
  modified:
    - frontend/src/openclaw/ui/views/users-management.ts
    - frontend/src/openclaw/ui/app-render.ts

key-decisions:
  - "Per-user role loading uses Promise.allSettled for error isolation (one failed user doesn't block others)"
  - "Instance permission modal fetches all instances live from /api/database/instances (no auth endpoint) for accurate data"

patterns-established:
  - "Admin check via RBAC API probe: async fetch /api/v1/rbac/roles, treat 200=admin, 403=not admin"

requirements-completed:
  - RBAC-09

# Metrics
duration: 9min
completed: 2026-05-10
---

# Phase 85 Plan 02: Users Management RBAC Update Summary

**Fixed admin check (replaced JWT role claim probe with RBAC API call), added multi-role badges per user with click navigation to RBAC page, and added instance permission modal with live instance checkboxes and diff-based grant/revoke**

## Performance

- **Duration:** 9 min
- **Started:** 2026-05-10T03:34:36Z
- **Completed:** 2026-05-10T03:43:11Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Replaced `getUserRole()` (reads JWT payload.role, returns null after Phase 84) with async `_checkAdmin()` that probes `GET /api/v1/rbac/roles` (200 = admin, 403 = insufficient permission)
- Added `@state() userRoles` Map with per-user role loading via `Promise.allSettled` for parallel fetches from `/api/v1/rbac/users/:id/roles`
- User table role column now displays multiple role badges instead of a single badge
- Role badges are clickable (cursor:pointer) and dispatch `navigate-to-rbac` custom event
- Added `_navigateToRbac(userId)` method for badge click navigation
- Added "实例权限" button per user row in the actions column (between "重置密码" and "删除")
- Added instance permission modal with: search/filter input, checkbox list of all instances loaded from `/api/database/instances`, diff-based save (POST to grant, DELETE to revoke), loading/empty/error states
- Added `@navigate-to-rbac` event listener in `app-render.ts` on `<users-management>` element that stores `userId` in `(state as any)._rbacTargetUserId` and calls `state.setTab("rbac")`

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix admin check and add per-user role loading** - `15ff0c0602` (fix)
2. **Task 2: Add multi-role badges, instance permission modal, RBAC navigation** - `57cf982652` (feat)

## Files Created/Modified

- `frontend/src/openclaw/ui/views/users-management.ts` - Updated admin check, added multi-role badges, instance permission modal, RBAC navigation event
- `frontend/src/openclaw/ui/app-render.ts` - Added `navigate-to-rbac` event listener on `<users-management>` element

## Decisions Made

- **Per-user role loading with Promise.allSettled:** Using `Promise.allSettled` instead of `Promise.all` so that a single user's role fetch failure (e.g., network glitch) doesn't prevent all users' roles from loading. Failed fetches get an empty array.
- **Live instance list fetch:** Instance permission modal fetches instances live from `/api/database/instances` (no auth required on that endpoint) to ensure data is current, avoiding stale cached lists.
- **Diff-based save pattern:** On save, compute new grants (`saved - granted`) and revocations (`granted - saved`) and execute individual POST/DELETE calls for each change, matching the existing pattern in rbac-page.ts.
- **$(state as any)._rbacTargetUserId$:** Stores the target user ID on state for the RBAC page's RbacAdminPage to read on mount, matching the pattern established in Plan 85-01.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- **Worktree file path confusion (same as Wave 1):** The Edit tool modifies files in the main repo directory (`/Users/max/Library/CloudStorage/OneDrive-个人/03-Coding/39-Slide/frontend/...`), but git operations refer to the worktree's separate working copy (`/Users/max/Library/CloudStorage/OneDrive-个人/03-Coding/39-Slide/.claude/worktrees/agent-.../frontend/...`). After Task 1, the file was copied from the main repo to the worktree directory and recommitted. For Task 2, files were edited directly in the worktree path to avoid this issue.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Users management page fully RBAC-aware: admin check works without JWT role claim, multi-role badges from RBAC API, click navigation to RBAC user-role binding tab
- Instance permission modal provides complete grant/revoke workflow
- Subsequent plans can build on the navigation pattern established here

---
*Phase: 85-rbac-frontend*
*Completed: 2026-05-10*
