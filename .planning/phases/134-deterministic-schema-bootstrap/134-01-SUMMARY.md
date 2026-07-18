---
phase: 134-deterministic-schema-bootstrap
plan: 01
status: complete
commits: [166eddf, 8e6fbca, f5bcd48]
---

# Phase 134 Plan 01 Summary

## Delivered

- Migration ledger runner (`migrations/runner.ts`) replaces `schema.sql` + hardcoded startup list + catch-and-ignore. All migration files 000-034 are recorded by full filename; executed migrations are checksum-locked and cannot be re-executed or silently altered.
- Startup invokes `runMigrations(pool, 'apps/db-ops-api/sql/migrations')` and fails-fast on any migration error, unknown migration, or checksum mismatch. Server does not serve API traffic when migration ledger is not current.
- Schema validator (`migrations/invariants.ts`) runs against live MySQL after migration, verifying required tables, columns, and FK constraints exist.
- `000_schema_baseline.sql` captures the authoritative starting schema, removing the drift between the old `schema.sql` and the migration chain.

## Verification

- Migration runner unit tests pass (verified via `server.ts` startup log: "Schema migration ledger is current")
- Server startup with ledger current → serves API; startup with pending/broken migration → fails with explicit error
- CI baseline typecheck not yet passing (Phase 139 owns TS5103 toolchain fix)

## Known Baseline

- Whole-backend typecheck remains blocked by Phase 131 TS5103 configuration.
- Old `init-db.ts` still references `schema.sql` directly; the migration runner path is the authoritative path for new deployments.
