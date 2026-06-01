---
phase: 84-rbac-foundation
slug: rbac-foundation
status: verified
threats_open: 0
asvs_level: 1
created: 2026-05-12
---

# Phase 84 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Client -> API | All RBAC endpoints require verifyToken + requirePermission('admin:*') | JWT token, permission check |
| Client -> Server (instance) | 19 instance-scoped routes with requireInstanceAccess() | instanceId from URL params |
| API -> MySQL | All queries parameterized via mysql2 pool.execute() | Permission data, role assignments |
| Server -> RbacService | getUserPermissions called per-request, no cache | User permission Set |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status |
|-----------|----------|-----------|-------------|------------|--------|
| T-84-01 | Tampering | SQL Migration DROP COLUMN | mitigate | TRANSACTION wrapping + role_backup column preserved for rollback | closed |
| T-84-02 | Info Disclosure | RbacService list endpoints | mitigate | All 18 RBAC API routes enforce requirePermission('admin:*') in preHandler | closed |
| T-84-03 | Elevation of Privilege | RbacService.assignRoleToUser | mitigate | Only accessible via requirePermission('admin:*') on RBAC API routes | closed |
| T-84-04 | Elevation of Privilege | requirePermission bypass | mitigate | Factory returns 403 on mismatch; hasPermission() is local scope — no external override | closed |
| T-84-05 | Tampering | instanceId spoofing | mitigate | Canonical rule: instanceId from request.params.id (URL), logs warning if body mismatch | closed |
| T-84-06 | Spoofing | Super admin '*' wildcard | mitigate | '*' permission only via RbacService, which requires admin:* to assign | closed |
| T-84-07 | Repudiation | RBAC API operations | accept | Phase 84 backend only; Phase 85 frontend logging will add audit trail | closed |
| T-84-08 | Elevation of Privilege | Route audit omission | mitigate | 139 routes audited by URL prefix + HTTP method; requireRole references removed from server.ts | closed |
| T-84-09 | Tampering | Unauthenticated route exploitation | accept | 26 unauthenticated routes (health, login, read-only GETs) remain open — out of scope per RESEARCH.md | closed |
| T-84-10 | Information Disclosure | JWT role claim vestigial | accept | requirePermission ignores JWT role entirely; uses RbacService.getUserPermissions only | closed |
| T-84-11 | Repudiation | instanceId mismatch | mitigate | requireInstanceAccess logs warning when request.body has different instanceId | closed |
| T-84-12 | Elevation of Privilege | requireInstanceAccess wildcard | mitigate | Exact string match for '*' and 'instance:*' only — no regex, no partial match | closed |
| T-84-13 | Spoofing | RBAC API verifyToken decorator | mitigate | Same verifyToken function as all authenticated routes; fastify.decorate before register(rbacApiRoutes) | closed |
| T-84-14 | Information Disclosure | Login response lacks role field | accept | requirePermission uses RbacService (not JWT role). Client loses role display but gains permission-based access | closed |

*Status: closed — all threats have verified dispositions.*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-84-01 | T-84-07 | RBAC operation audit logging deferred to Phase 85 frontend | Claude (gsd-security-auditor) | 2026-05-12 |
| AR-84-02 | T-84-09 | 26 unauthenticated routes (health, login, public GETs) are by design per RESEARCH.md | Claude (gsd-security-auditor) | 2026-05-12 |
| AR-84-03 | T-84-10 | JWT role claim is vestigial — all authorization via RbacService, not JWT | Claude (gsd-security-auditor) | 2026-05-12 |
| AR-84-04 | T-84-14 | Login response no longer includes role field — client loses role display, gains accurate permission-based access | Claude (gsd-security-auditor) | 2026-05-12 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-05-12 | 14 | 14 | 0 | Claude (gsd-security-auditor) |

---

## Verification Evidence

### T-84-01 — TRANSACTION + role_backup
```
apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql:11  START TRANSACTION;
apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql:235 ALTER TABLE users ADD COLUMN role_backup;
apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql:254 COMMIT;
```

### T-84-02/03/08/13 — RBAC API protection + requireRole removed
```
apps/db-ops-api/src/auth/rbac-api.ts:27  preHandler: [verifyToken, requirePermission('admin:*')]  (all 18 routes)
apps/db-ops-api/server.ts:136            fastify.decorate('verifyToken', verifyToken)
apps/db-ops-api/server.ts                grep requireRole → 0 matches
```

### T-84-04 — requirePermission local scope
```
apps/db-ops-api/src/auth/require-permission.ts:29  hasAccess = requiredCodes.some(code => hasPermission(userPermissions, code))
apps/db-ops-api/src/auth/require-permission.ts:31  return reply.code(403).send({ error: '权限不足' })
```

### T-84-05/11/12 — instanceId from params + wildcard exact match
```
apps/db-ops-api/src/auth/require-instance-access.ts:7  实例 ID 必须来自 request.params.id
apps/db-ops-api/src/auth/require-instance-access.ts:26  userPermissions.has('*') || userPermissions.has('instance:*')
apps/db-ops-api/src/auth/require-instance-access.ts:36  发现 request.body.instanceId 但 request.params.id 缺失
```

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-05-12
