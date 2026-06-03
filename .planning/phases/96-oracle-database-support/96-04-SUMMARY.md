---
phase: 96-oracle-database-support
plan: 04
subsystem: database
tags: [oracle, oracledb, thin-mode, tls, ssl, fetch-as]
requires:
  - phase: 96
    plan: 03
    provides: Oracle connection scaffolding with sslOptions/fetchAs module-level assignments (which caused TypeError in Thin mode v6+)
provides:
  - Oracle pool creation with per-pool fetchAsString/fetchAsBuffer config (no module-level mutation)
  - Oracle testConnection without oracledb.sslOptions assignment (Thin mode TCPS handles TLS automatically)
affects: [96-oracle-database-support verification]
tech-stack:
  added: []
  patterns:
    - Pass fetchAsString/fetchAsBuffer as createPool() options instead of module-level oracledb property assignment
    - Omit sslOptions for Oracle Thin mode — TCPS handles TLS negotiation automatically
key-files:
  created: []
  modified:
    - apps/db-ops-api/src/database-service.ts
    - apps/db-ops-api/src/instance-database-service.ts
key-decisions:
  - "oracledb v6+ Thin mode freezes the module singleton — module-level property assignments (sslOptions, fetchAsString, fetchAsBuffer) throw TypeError: Cannot add property, object is not extensible"
  - "Pass fetchAsString/fetchAsBuffer via createPool() options instead of module-level assignment"
  - "Drop sslOptions entirely — Thin mode TCPS handles TLS negotiation automatically without rejectUnauthorized flag"
requirements-completed: [DB-02]
duration: 5min
completed: 2026-05-19
---

# Phase 96 Plan 04: Fix sslOptions / fetchAs Module-Level Mutation Blocker

**Remove oracledb module-level property assignments causing TypeError in Thin mode v6+; pass fetchAs config via createPool() options; drop sslOptions (handled by Thin mode TCPS)**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-19
- **Completed:** 2026-05-19
- **Tasks:** 2/2
- **Files modified:** 2

## Accomplishments

- Removed `oracledb.fetchAsString`, `oracledb.fetchAsBuffer`, `oracledb.sslOptions` module-level assignments from `database-service.ts` (addConnection)
- Added `fetchAsString: [oracledb.NUMBER]` and `fetchAsBuffer: [oracledb.CLOB]` as `createPool()` options
- Removed `oracledb.sslOptions` assignment from `instance-database-service.ts` (testConnection)

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix database-service.ts (addConnection)** - `f54cad254f8` (fix)
2. **Task 2: Fix instance-database-service.ts (testConnection)** - `1e1bf42a709` (fix)

## Files Modified

- `apps/db-ops-api/src/database-service.ts` - Removed 3 module-level assignments, added 2 fetchAs options to createPool()
- `apps/db-ops-api/src/instance-database-service.ts` - Removed oracledb.sslOptions assignment (3 lines deleted)

## Decisions Made

- **Per-pool fetchAs config over module-level assignment**: oracledb v6+ Thin mode freezes the module singleton. Module-level property assignment throws `TypeError: Cannot add property, object is not extensible`. The fix is to pass `fetchAsString` and `fetchAsBuffer` as `createPool()` options — each pool gets its own config.
- **Drop sslOptions entirely**: oracledb Thin mode TCPS handles TLS negotiation automatically. The `rejectUnauthorized: false` flag was only needed for Thick mode development scenarios. Thin mode does not expose or require `sslOptions`.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## Verification

- `grep` confirms no `oracledb.fetchAsString`, `oracledb.fetchAsBuffer`, or `oracledb.sslOptions` in `database-service.ts`
- `grep` confirms `fetchAsString:` and `fetchAsBuffer:` exist as options inside `createPool()` call
- `grep` confirms no `sslOptions` in `instance-database-service.ts`

## Next Phase Readiness

- The UAT test 1 blocker (`Cannot add property sslOptions, object is not extensible`) is resolved.
- Oracle connection creation and testConnection will no longer throw TypeError in Thin mode v6+.
- Ready for plan 05 (gap closure) or UAT re-verification.

---

*Phase: 96-oracle-database-support*
*Completed: 2026-05-19*
