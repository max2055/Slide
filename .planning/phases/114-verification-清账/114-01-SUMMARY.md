---
phase: 114
plan: 01
subsystem: backend, frontend
tags: [auth, jwt, security, api-client, audit]
requires: []
provides: [VER-01]
affects:
  - apps/db-ops-api/server.ts
  - frontend/src/app/ui/views/users-management.ts
  - frontend/src/app/ui/views/rbac-page.ts
tech-stack:
  added: []
  patterns:
    - "preHandler: [verifyToken]" in all route registrations that return non-public data
    - apiClient.get/post/put/delete instead of raw fetch() + localStorage.getItem('token')
key-files:
  created: []
  modified:
    - apps/db-ops-api/server.ts
    - frontend/src/app/ui/views/users-management.ts
    - frontend/src/app/ui/views/rbac-page.ts
decisions: []
metrics:
  duration: 5m
  completed_date: "2026-05-27"
---

# Phase 114 Plan 01: Auth Audit & Fix Summary

Close authentication gaps by adding `verifyToken` JWT middleware to 17 unprotected API routes and replacing raw `fetch()` calls with `ApiClient.fetchWithAuth()` in two frontend settings pages.

## Completed Tasks

| Task | Name                                                            | Commit     | Files                                                                 |
| ---- | --------------------------------------------------------------- | ---------- | --------------------------------------------------------------------- |
| 1    | Add verifyToken to 17 unprotected routes in server.ts           | efbf7c8ffc9 | apps/db-ops-api/server.ts                                            |
| 2    | Standardize frontend API calls in users-management.ts and rbac-page.ts | 7791d5e2d4c | frontend/src/app/ui/views/users-management.ts, frontend/src/app/ui/views/rbac-page.ts |

## Task Details

### Task 1: Add verifyToken to 17 unprotected routes

Added `preHandler: [verifyToken]` to the following routes in server.ts:

| #  | Method | Route URI                                                      |
| -- | ------ | -------------------------------------------------------------- |
| 1  | GET    | /api/version                                                   |
| 2  | GET    | /api/docs/list                                                 |
| 3  | GET    | /api/docs/files/:file                                          |
| 4  | GET    | /api/llm/configs                                               |
| 5  | GET    | /api/llm/configs/:id                                           |
| 6  | POST   | /api/llm/test                                                  |
| 7  | GET    | /api/dashboard/capacity-trend                                  |
| 8  | GET    | /api/dashboard/ai-stats                                        |
| 9  | GET    | /api/database/instances/:id/tables                             |
| 10 | GET    | /api/database/instances/:id/tables/:tableName/describe         |
| 11 | GET    | /api/database/instances/:id/tables/:tableName/indexes          |
| 12 | GET    | /api/alerts/escalation/rules                                   |
| 13 | GET    | /api/maintenance-windows                                       |
| 14 | GET    | /api/maintenance-windows/check/:instanceId                     |
| 15 | GET    | /api/silence                                                   |
| 16 | GET    | /api/baseline/:instanceId/:metricName                          |
| 17 | GET    | /api/chat/greeting                                             |

Routes that remain unprotected (intentionally): `GET /api/health` (healthcheck), `POST /api/auth/login` (login), `POST /api/auth/refresh` (token refresh). OPTIONS/Preflight routes are handled by Fastify's CORS plugin.

### Task 2: Standardize frontend API calls

**users-management.ts:**
- Removed `API_BASE` constant and `_getToken()` helper
- Replaced all raw `fetch()` + `Authorization: Bearer ${token}` calls with `apiClient.get/post/put/delete`
- Status-checking logic (401, 403) migrated to try/catch with error message prefix matching

**rbac-page.ts:**
- Removed `_token`, `_headers`, `_fetch`, `_fetchJson` helpers from all 5 sub-components (RbacAdminPage, RoleManagementTab, PermissionManagementTab, UserRoleBindingTab, InstancePermissionsTab)
- All API calls now use `apiClient.get/post/put/delete`
- 403 status checks migrated from `res.status === 403` to `e.message?.startsWith("HTTP 403")` in catch blocks
- Net reduction: 334 lines deleted, 72 lines added

## Deviations from Plan

None - plan executed exactly as written.

## Success Criteria Verification

- [x] 17 routes now require JWT auth (verifyToken) -- confirmed via grep
- [x] users-management.ts uses ApiClient for all API calls -- confirmed (0 raw fetch calls remain)
- [x] rbac-page.ts uses ApiClient for all API calls -- confirmed (0 raw fetch calls remain)
- [x] TypeScript compilation: no new errors introduced -- confirmed (errors are all pre-existing)
- [x] No `localStorage.getItem('token')` remains in either frontend file -- confirmed
- [x] No `Authorization: Bearer` header construction remains in either frontend file -- confirmed

## Self-Check: PASSED
