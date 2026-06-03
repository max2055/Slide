---
phase: 101-认证权限
plan: 01
subsystem: "Auth"
tags:
  - refresh-token
  - grant-expiry
  - dual-token-auth
  - rotation
  - replay-detection
dependency_graph:
  requires: []
  provides: ["refresh_token_flow", "grant_expiry_filtering"]
  affects: ["frontend 401 interceptor (101-03)", "permission-gated navigation (101-04)"]
tech_stack:
  added:
    - "crypto.randomBytes for refresh token generation"
    - "crypto.createHash for SHA-256 token hashing"
  patterns:
    - "Dual-token auth: 1h access + 7d refresh with rotation"
    - "Replay detection: revoked token reuse triggers full user revocation"
    - "Grant expiry: WHERE clause filtering at query time (no cron needed)"
key_files:
  created:
    - "apps/db-ops-api/sql/migrations/005_add_refresh_tokens_and_grant_expiry.sql"
  modified:
    - "apps/db-ops-api/src/auth/rbac-service.ts"
    - "apps/db-ops-api/server.ts"
decisions:
  - "SHA-256 hash stored in DB; randomBytes(48)=384 bits entropy per token"
  - "Replay detection revokes ALL tokens for user on reused revoked token (D-02)"
  - "Grant expiry filtered at SQL query time; no background cron or invalidation needed"
  - "Startup cleanup removes tokens expired >30 days, not all expired tokens"
metrics:
  duration: "5m"
  completed_date: "2026-05-20"
---

# Phase 101 认证权限 Plan 01: Refresh Token + Grant Expiry Summary

**One-liner:** Dual-token auth with 1h JWT access token + 7d SHA-256 hashed refresh token with rotation/replay detection, plus grant_expiry column on user_roles and instance_permissions for automatic permission expiry via SQL WHERE clause filtering.

## Overview

Implemented the refresh token backend infrastructure and time-bound authorization. Converted the original 24h JWT to a 1h access token + 7d refresh token dual-token architecture, created the `refresh_tokens` table and `/api/auth/refresh` route. Also added `grant_expiry` columns to `user_roles` and `instance_permissions` tables with automatic filtering at query time.

### Changes Made

**1. SQL Migration 005** (e290c471fe8)
- Created `refresh_tokens` table: token_hash (SHA-256), user_id (FK), expires_at, revoked, created_at with indexes
- Added `grant_expiry` DATETIME column to `user_roles` table
- Added `access_level` ENUM + `grant_expiry` DATETIME columns to `instance_permissions` table

**2. rbac-service.ts** (0fc8997652d)
- Added `createRefreshToken` — generates randomBytes(48) hex, stores SHA-256 hash in DB
- Added `validateRefreshToken` — looks up by token_hash, returns row or null
- Added `revokeRefreshToken` — marks single token as revoked
- Added `revokeAllUserTokens` — revokes ALL tokens for a user (replay detection)
- Added `cleanupExpiredRefreshTokens` — deletes tokens expired >30 days
- Modified `getUserPermissions` — adds `AND (ur.grant_expiry IS NULL OR ur.grant_expiry > NOW())`
- Modified `checkInstanceAccess` — adds `AND (grant_expiry IS NULL OR grant_expiry > NOW())`
- Modified `getUserInstanceAccess` — adds grant_expiry WHERE clause
- Modified `getUsersWithInstanceAccess` — adds grant_expiry WHERE clause

**3. server.ts** (afe2fe19129)
- Changed `JWT_EXPIRES_IN` from `'24h'` to `'1h'`
- Login endpoint now returns `refreshToken` (raw hex) + `expiresIn: 3600`
- Added `POST /api/auth/refresh`: validates SHA-256 hash, enforces rotation (revoke old, issue new pair), detects replay (revokes ALL tokens), expired tokens return 401
- Added startup cleanup for tokens expired >30 days
- Imported and instantiated `RbacService` in server.ts

### Threat Model Compliance

| Threat ID | Category | Disposition | Status |
|-----------|----------|-------------|--------|
| T-101-01 | Tampering | mitigate | Token rotation + replay detection implemented |
| T-101-02 | Info Disclosure | mitigate | SHA-256 hashes stored; randomBytes(48)=384 bits entropy |
| T-101-03 | Elevation of Privilege | mitigate | Grant expiry filtered in SQL WHERE clause on every query |
| T-101-04 | Tampering | mitigate | JWT expiry enforced by jwt.verify(); 1h window limits exposure |
| T-101-05 | Brute Force | accept | 384-bit token infeasible to brute force; rate limit available |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added RbacService import and instantiation in server.ts**
- **Found during:** Task 3
- **Issue:** Plan assumed `rbacService` was already available in server.ts scope, but the RbacService class was only instantiated in other modules (rbac-api.ts, require-permission.ts)
- **Fix:** Added `import { RbacService } from './src/auth/rbac-service.js'` and `const rbacService = new RbacService()` at module level in server.ts
- **Files modified:** apps/db-ops-api/server.ts
- **Commit:** afe2fe19129

## Success Criteria Verification

- [x] All new refresh token methods exist and are callable in rbac-service.ts
- [x] grant_expiry filtering applied to all 4 permission queries
- [x] login endpoint returns refreshToken field
- [x] /api/auth/refresh handles normal rotation, replay detection, expiry detection
- [x] Startup cleanup removes tokens expired >30 days
- [x] JWT_EXPIRES_IN changed to '1h'

## Self-Check: PASSED

- [x] File `apps/db-ops-api/sql/migrations/005_add_refresh_tokens_and_grant_expiry.sql` exists
- [x] Commit e290c471fe8 — migration file commit
- [x] Commit 0fc8997652d — rbac-service.ts modifications
- [x] Commit afe2fe19129 — server.ts modifications
- [x] All 5 refresh token methods present in rbac-service.ts
- [x] All 4 permission queries filter by grant_expiry
- [x] Login returns refreshToken, /api/auth/refresh endpoint exists
