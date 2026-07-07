---
phase: 124-server-registration
plan: 01
subsystem: api
tags: ssh, server-management, credential-encryption, aes-256-cbc, permission-control
requires:
  - phase: 123-chat-agent
    provides: existing encryption (encryptData/decryptData), RBAC permission system
provides:
  - Server CRUD API (servers table + REST endpoints)
  - SSH credential secure storage (AES-256-CBC encrypted)
  - SSH connection test endpoint (ssh2 Client)
  - SSH key rotation endpoint
  - servers:view and servers:manage permissions (admin/dba roles)
affects:
  - 124-02-FRONTEND (server management UI)
  - 125-monitoring (SSH host key fingerprint, status checks)
tech-stack:
  added:
    - ssh2@^1.17 (SSH client library)
    - @types/ssh2@^1.15 (type declarations)
  patterns:
    - Server CRUD following instance-database-service.ts singleton pattern
    - AES-256-CBC credential encryption via existing encryptData/decryptData
    - Permission-gated routes via requirePermission middleware
key-files:
  created:
    - apps/db-ops-api/sql/migrations/019_add_servers_table.sql
    - apps/db-ops-api/src/server-database-service.ts
  modified:
    - apps/db-ops-api/server.ts
    - package.json
key-decisions:
  - "Import serverDatabaseService singleton directly rather than instantiate (consistent with instance-database-service.ts pattern)"
  - "SSH test connection uses hostVerifier: () => true (Phase 125 will add host key verification)"
  - "test-connection route is stateless — accepts raw credentials for pre-save testing"
  - "credential_encrypted stores JSON with username + password|privateKey, re-encrypted on every update"
patterns-established:
  - "Server management follows instance management patterns: singleton service class, dynamic UPDATE building, host+port dedup check"
  - "SSH credentials encrypted with existing encryptData/decryptData (AES-256-CBC, iv:hex format)"
  - "Permission-gated routes: servers:view on GET, servers:manage on POST/PUT/DELETE/test-connection/rotate-key"
requirements-completed: [SRV-01, SRV-02, SRV-03, SRV-06]
coverage:
  - id: D1
    description: "Servers table migration (019_add_servers_table.sql) with CREATE TABLE, servers:view/servers:manage permissions, admin + dba role assignments"
    requirement: SRV-01
    verification:
      - kind: other
        ref: "grep -c 'CREATE TABLE IF NOT EXISTS' apps/db-ops-api/sql/migrations/019_add_servers_table.sql"
        status: pass
      - kind: other
        ref: "grep -c servers:view apps/db-ops-api/sql/migrations/019_add_servers_table.sql"
        status: pass
      - kind: other
        ref: "grep -c role_permissions apps/db-ops-api/sql/migrations/019_add_servers_table.sql"
        status: pass
    human_judgment: false
  - id: D2
    description: "ServerDatabaseService with CRUD methods (getAllServers, getServerById, createServer, updateServer, deleteServer), SSH test connection via ssh2 Client, and key rotation"
    requirement: SRV-02
    verification:
      - kind: other
        ref: "test -f apps/db-ops-api/src/server-database-service.ts"
        status: pass
      - kind: other
        ref: "grep -c 'class ServerDatabaseService' apps/db-ops-api/src/server-database-service.ts"
        status: pass
      - kind: other
        ref: "grep -c 'encryptData\\|decryptData' apps/db-ops-api/src/server-database-service.ts"
        status: pass
      - kind: other
        ref: "grep -c 'ssh2' apps/db-ops-api/src/server-database-service.ts"
        status: pass
      - kind: other
        ref: "grep -c 'getAllServers\\|getServerById\\|createServer\\|updateServer\\|deleteServer\\|testConnection\\|rotateKey\\|getDecryptedCredentials' apps/db-ops-api/src/server-database-service.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "7 server API routes registered in server.ts with requirePermission middleware, credential_encrypted stripped from GET responses"
    requirement: SRV-03
    verification:
      - kind: other
        ref: "grep -c '/api/servers' apps/db-ops-api/server.ts"
        status: pass
      - kind: other
        ref: "grep -c \"requirePermission('servers:view')\" apps/db-ops-api/server.ts"
        status: pass
      - kind: other
        ref: "grep -c \"requirePermission('servers:manage')\" apps/db-ops-api/server.ts"
        status: pass
      - kind: other
        ref: "grep -c 'test-connection' apps/db-ops-api/server.ts"
        status: pass
      - kind: other
        ref: "grep -c 'rotate-key' apps/db-ops-api/server.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Key rotation endpoint (POST /api/servers/:id/rotate-key) re-encrypts credentials and resets host_key_fingerprint"
    requirement: SRV-06
    verification:
      - kind: other
        ref: "grep -c 'rotateKey' apps/db-ops-api/src/server-database-service.ts"
        status: pass
      - kind: other
        ref: "grep -c 'host_key_fingerprint = NULL' apps/db-ops-api/src/server-database-service.ts"
        status: pass
    human_judgment: false
duration: 18min
completed: 2026-07-07
status: complete
---

# Phase 124 Server Registration: Plan 01 Summary

**Server CRUD API with encrypted SSH credential storage, SSH connection test via ssh2, and key rotation — backend foundation for server management**

## Performance

- **Duration:** 18 min
- **Started:** 2026-07-07T14:00:00Z
- **Completed:** 2026-07-07T14:18:00Z
- **Tasks:** 3
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- Created SQL migration (019_add_servers_table.sql) with servers table DDL, servers:view and servers:manage permission seeds, and admin/dba role assignments
- Implemented ServerDatabaseService singleton with full CRUD, SSH connection test (ssh2 Client with 10s timeout), credential encryption (AES-256-CBC via existing encryptData/decryptData), and key rotation
- Registered 7 server management API routes in server.ts with requirePermission middleware for proper access control

## Task Commits

Each task was committed atomically:

1. **Task 1: Create SQL migration** - `e62e01b` (feat)
2. **Task 2: Create server-database-service.ts** - `6324207` (feat)
3. **Task 3: Register server routes in server.ts** - `0a39c3e` (feat)

## Files Created/Modified

- `apps/db-ops-api/sql/migrations/019_add_servers_table.sql` - Migration: servers table DDL, permission seeds, role assignments
- `apps/db-ops-api/src/server-database-service.ts` - Service class: CRUD, SSH test, key rotation, credential encryption
- `apps/db-ops-api/server.ts` - 7 REST routes with auth/permission middleware
- `package.json` - Added ssh2@^1.17 and @types/ssh2@^1.15 dependencies

## Decisions Made

- Imported `serverDatabaseService` singleton directly rather than creating a new instance (consistent with `instance-database-service.ts` codebase convention)
- SSH test connection uses `hostVerifier: () => true` — host key fingerprint verification deferred to Phase 125 as planned
- `test-connection` route is stateless, accepting raw credentials directly for pre-save testing (not encrypted)
- `credential_encrypted` stored as JSON `{username, password|privateKey}` format, re-encrypted via `encryptData()` on every update
- Key rotation page resets `host_key_fingerprint = NULL` per SRV-06

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

- Pre-existing TypeScript module resolution errors (`mysql2/promise`, `dotenv/config`, etc.) across the project — not introduced by this plan
- Worktree branch was positioned on phase 123 commits; needed `git reset --hard` to the expected phase 124 base before starting work

## User Setup Required

None — no external service configuration required.

## Known Stubs

- `host_key_fingerprint` column defaults to NULL — Phase 125 will implement SSH host key verification
- `hostVerifier: () => true` in SSH test connection — Phase 125 will add proper host key fingerprint verification
- `status` defaults to 'offline' — Phase 125+ will implement periodic status checks

## Next Phase Readiness

- Backend server CRUD API is complete and ready for frontend (Phase 124-02)
- SSH credential encryption patterns established and ready for extension
- Permission model seeded — future phases can reference servers:view/servers:manage
- Phase 125 can build on this for SSH session pool and host key verification

## Self-Check: PASSED

All claims verified:
- All 3 files created: migration, service, SUMMARY.md
- All 3 commits exist: e62e01b, 6324207, 0a39c3e
- Migration contains CREATE TABLE, servers:view/servers:manage seeds, role_permissions assignments
- Service contains class with all 8 methods, encryptData/decryptData, ssh2
- server.ts has import and 7 routes

---

*Phase: 124-server-registration*
*Completed: 2026-07-07*
