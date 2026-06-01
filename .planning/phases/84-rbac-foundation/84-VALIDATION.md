---
phase: 84-rbac-foundation
slug: rbac-foundation
status: verified
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-09
updated: 2026-05-12
---

# Phase 84 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.x (apps/db-ops-api) |
| **Config file** | `apps/db-ops-api/vitest.config.ts` |
| **Quick run command** | `pnpm -C apps/db-ops-api vitest run src/auth/` |
| **Full suite command** | `pnpm -C apps/db-ops-api vitest run` |
| **Estimated runtime** | ~8 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm -C apps/db-ops-api vitest run src/auth/`
- **After every plan wave:** Run `pnpm -C apps/db-ops-api vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 84-01-01 | 01 | 1 | RBAC-01 | T-84-01 | Migration wraps in TRANSACTION with role_backup | integration | `vitest run src/auth/migration.test.ts` | ✅ | ✅ green |
| 84-01-02 | 01 | 1 | RBAC-01/06 | T-84-02/03 | RbacService CRUD + permission lookup, parameterized queries | unit | `vitest run src/auth/rbac-service.test.ts` | ✅ | ✅ green |
| 84-01-03 | 01 | 1 | RBAC-01 | — | 40 test cases for all CRUD operations + edge cases | unit | `vitest run src/auth/rbac-service.test.ts` | ✅ | ✅ green |
| 84-01-04 | 01 | 1 | RBAC-08 | T-84-01 | Migration test validates tables, seeds, user migration | integration | `vitest run src/auth/migration.test.ts` | ✅ | ✅ green |
| 84-02-01 | 02 | 1 | RBAC-02/05/06 | T-84-04/05 | requirePermission wildcard + requireInstanceAccess param checks | unit | `vitest run src/auth/require-permission.test.ts src/auth/require-instance-access.test.ts` | ✅ | ✅ green |
| 84-02-02 | 02 | 1 | RBAC-03/04 | T-84-06 | RBAC API 18 routes with verifyToken + requirePermission('admin:*') | manual | `grep requirePermission src/auth/rbac-api.ts` | ✅ | ✅ green |
| 84-02-03 | 02 | 1 | RBAC-02/05 | T-84-04/05 | Middleware unit tests: 15 + 9 test cases, all wildcard patterns | unit | `vitest run src/auth/require-permission.test.ts src/auth/require-instance-access.test.ts` | ✅ | ✅ green |
| 84-03-01 | 03 | 1 | RBAC-02/04/07 | T-84-08/09 | 139 route registrations audited, requireRole replaced with requirePermission | manual | `grep -r requireRole apps/db-ops-api/server.ts` | ✅ | ✅ green |
| 84-03-02 | 03 | 1 | RBAC-07 | T-84-10 | auth-database-service cleansed of role ENUM, getUserRoleById deleted | manual | `grep "getUserRoleById" apps/db-ops-api/src/auth/auth-database-service.ts` | ✅ | ✅ green |
| 84-03-03 | 03 | 1 | RBAC-07 | — | TypeScript compilation: no Phase 84 errors | manual | `npx tsc --noEmit --skipLibCheck` | ✅ | ✅ green |
| 84-04-01 | 04 | 1 | RBAC-03/04 | T-84-13 | verifyToken decorated before rbacApiRoutes registration (CR-01) | manual | `grep "decorate.*verifyToken" apps/db-ops-api/server.ts` | ✅ | ✅ green |
| 84-04-02 | 04 | 1 | RBAC-06 | T-84-12 | requireInstanceAccess wildcard check before instance_permissions query (CR-03) | manual | `grep "has.*'\*'" apps/db-ops-api/src/auth/require-instance-access.ts` | ✅ | ✅ green |
| 84-04-03 | 04 | 1 | RBAC-01/06 | — | collector:view and collector:manage seeded + assigned to dba (WR-03) | manual | `grep "collector:" apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Requirements to Test Map

| Req ID | Behavior | Test Type | File | Status |
|--------|----------|-----------|------|--------|
| RBAC-01 | Create/edit/delete roles + permissions via RbacService | unit | `src/auth/rbac-service.test.ts` (40 tests) | COVERED |
| RBAC-02 | Permission code namespace + middleware replaces requireRole | unit | `src/auth/require-permission.test.ts` (15 tests) + `require-instance-access.test.ts` (9 tests) | COVERED |
| RBAC-03 | Admin manages RBAC entities via API at /api/v1/rbac/* | manual | `src/auth/rbac-api.ts` — manual curl verification | MANUAL-ONLY |
| RBAC-04 | Only admin role can manage RBAC (requirePermission('admin:*')) | unit | `src/auth/require-permission.test.ts` | COVERED |
| RBAC-05 | Wildcard permission matching: direct, resource:*, *:action, super-admin * | unit | `src/auth/require-permission.test.ts` | COVERED |
| RBAC-06 | No privilege escalation: 403 on unauthorized, system role guards | unit | `src/auth/require-permission.test.ts` + `rbac-service.test.ts` | COVERED |
| RBAC-07 | Existing functionality preserved: requireRole removed, routes migrated | manual | grep + tsc verification | COVERED |
| RBAC-08 | Migration preserves existing user role data via role_backup | integration | `src/auth/migration.test.ts` (10 assertions) | COVERED |

---

## Security Validation

### ASVS Categories

| Category | Applies | Control |
|----------|---------|---------|
| V2 Authentication | yes | JWT verifyToken (existing) |
| V3 Session Management | yes | JWT 24h expiry |
| V4 Access Control | **yes** | requirePermission + requireInstanceAccess (core of Phase 84) |
| V5 Input Validation | yes | Permission code format validation (resource:action) |
| V6 Cryptography | yes | bcrypt (existing) |

### Threat Mitigations Verified

| Threat | STRIDE | Mitigation | Status |
|--------|--------|------------|--------|
| Permission escalation via direct API call | Elevation of Privilege | Middleware preHandler on all RBAC routes | ✅ |
| Instance ID tampering | Tampering | requireInstanceAccess validates against URL params (not body) | ✅ |
| SQL injection in RBAC queries | Tampering | Parameterized queries (mysql2 `?` placeholders) | ✅ |
| Super admin wildcard abuse | Spoofing | '*' assignable only via RbacService with admin:* guard | ✅ |

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No Wave 0 dependencies.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| RBAC API plugin integration (rbac-api.ts) | RBAC-03 | Fastify plugin integration test requires full server + database lifecycle; service (40 tests) + middleware (24 tests) already cover the core logic. API plugin is thin wiring: verifyToken + requirePermission('admin:*') + RbacService delegation. | `curl -H "Authorization: Bearer <token>" http://localhost:3000/api/v1/rbac/roles` — verify 200 with 6 roles. Also test POST/PUT/DELETE endpoints. |

---

## Validation Audit (2026-05-12)

| Metric | Count |
|--------|-------|
| Gaps found | 1 (RBAC-03) |
| Resolved | 0 |
| Escalated to manual-only | 1 |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or documented manual verification
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 10s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-05-12
