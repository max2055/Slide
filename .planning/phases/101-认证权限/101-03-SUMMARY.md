---
phase: 101-认证权限
plan: 03
subsystem: "Auth"
tags:
  - refresh-token
  - 401-interceptor
  - token-refresh
  - retry-queue
dependency_graph:
  requires: ["refresh_token_flow (101-01)"]
  provides: ["client_side_token_refresh"]
  affects: ["permission-gated navigation (101-04)"]
tech_stack:
  added: []
  patterns:
    - "401 interceptor with shared refreshPromise for request deduplication"
    - "fetchWithAuth as single entry point for all HttpClient HTTP methods"
    - "Plain fetch for refresh endpoint to avoid recursion"
key_files:
  created: []
  modified:
    - "frontend/src/api/index.ts"
    - "frontend/src/openclaw/ui/app-gateway.ts"
decisions:
  - "Refresh token stored in localStorage under 'refreshToken' key, matching existing 'token' pattern"
  - "refreshPromise deduplication: concurrent 401s share one /api/auth/refresh call via promise chaining"
  - "attemptTokenRefresh uses plain fetch() not fetchWithAuth() to avoid recursion (T-101-11 mitigation)"
  - "Network errors during refresh do NOT clear tokens (may succeed on retry); HTTP errors DO clear tokens"
  - "Existing token storage pattern (localStorage.setItem) preserved in app-gateway.ts per minimal change policy"
metrics:
  duration: "8m"
  completed_date: "2026-05-20"
---

# Phase 101 认证权限 Plan 03: Frontend 401 Interceptor + Token Refresh Summary

**One-liner:** Frontend ApiClient automatically intercepts 401 responses, transparently refreshes the access token via /api/auth/refresh, and retries the original request -- all without user-visible interruption.

## Overview

Implemented client-side 401 interceptor in the ApiClient class (`frontend/src/api/index.ts`) and wired refresh token storage in the login handler (`frontend/src/openclaw/ui/app-gateway.ts`). This completes the frontend half of the dual-token auth system -- after backend refresh token support was added in 101-01, the frontend now knows how to use it.

### Changes Made

**1. api/index.ts -- ApiClient** (0fe1c7117d0, fc754fb49c2)
- Added `setRefreshToken(token)` / `getRefreshToken()` methods for localStorage persistence
- Added `refreshPromise` field for deduplicating concurrent refresh attempts
- Added `attemptTokenRefresh()` -- uses plain `fetch()` (not fetchWithAuth) to avoid recursion per T-101-11
- Added `fetchWithAuth()` -- shared auth method that intercepts 401 responses, chains onto the shared refreshPromise, and transparently retries with the new token
- Refactored `get()`, `post()`, `put()`, `delete()` to delegate to `fetchWithAuth`
- Failed refresh (HTTP error) clears both tokens from localStorage forcing re-login
- Network errors during refresh preserve tokens (may succeed on next attempt)

**2. app-gateway.ts -- Login handler** (e89233452fc)
- Imported `apiClient` from `../../api/index.ts`
- Modified the login .then handler to store `d.refreshToken` via `apiClient.setRefreshToken()`
- Existing token/user storage pattern preserved unchanged

### Threat Model Compliance

| Threat ID | Category | Component | Disposition | Status |
|-----------|----------|-----------|-------------|--------|
| T-101-10 | Information Disclosure | localStorage tokens | accept | Internal tool with CSP; accepted per risk profile |
| T-101-11 | Tampering | 401 interceptor recursion | mitigate | attemptTokenRefresh uses plain fetch(), not fetchWithAuth() |
| T-101-12 | Denial of Service | Race condition on 401 retry | mitigate | refreshPromise ensures single refresh call for concurrent 401s |
| T-101-13 | Tampering | Refresh token via non-HTTPS | accept | Development only; production assumes HTTPS proxy |

## Deviations from Plan

### Out-of-Scope Discoveries

**1. Pre-existing build failure in app-render.ts**
- **Found during:** Verification build
- **Issue:** `frontend/src/openclaw/ui/app-render.ts` has duplicate import declarations for `loadAgents` and `getVisibleCronJobs`, causing `vite build` to fail with PARSE_ERROR
- **Impact on this plan:** None -- the errors are in an unrelated file and pre-date our changes
- **Action:** Logged to `deferred-items.md`

### Auto-fixed Issues

None -- plan executed exactly as written.

## Success Criteria Verification

- [x] ApiClient has setRefreshToken/getRefreshToken methods
- [x] get/post/put/delete all go through fetchWithAuth
- [x] 401 responses trigger attemptTokenRefresh using refreshPromise deduplication
- [x] Successful refresh retries original request; failed refresh clears all tokens
- [x] app-gateway.ts login handler stores refreshToken from response

## Self-Check: PASSED

- [x] File `frontend/src/api/index.ts` modified -- setRefreshToken, getRefreshToken, fetchWithAuth, attemptTokenRefresh, refreshPromise, refactored HTTP methods
- [x] File `frontend/src/openclaw/ui/app-gateway.ts` modified -- apiClient import, refreshToken storage
- [x] Commit 0fe1c7117d0 -- refresh token storage methods
- [x] Commit fc754fb49c2 -- 401 interceptor with retry queue
- [x] Commit e89233452fc -- refreshToken from login response

