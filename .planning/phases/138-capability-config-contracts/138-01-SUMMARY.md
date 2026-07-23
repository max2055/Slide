---
phase: 138-capability-config-contracts
plan: 01
status: complete
commits: [3285f4e, 5d49013, a7679de]
---

# Phase 138 Plan 01 Summary

## Delivered

- Adapter capability matrix (`adapters/capability-matrix.ts`): supported database types are declared in a single source of truth covering connection, metrics collection, SQL console, health check, and Agent tool dimensions. Create UI, API validation, collector registry, and docs all read from this matrix.
- Only types with environment/version evidence are marked `verified`. Missing adapter implementations (MongoDB, Redis, Elasticsearch) are marked `unsupported`; instance creation and API requests for unsupported types are rejected with explicit messages.
- The matrix enforces: MySQL ✓, PostgreSQL ✓, Oracle ✓, Dameng ✓. Frontend instance-creation dropdown reads from the matrix. Agent tools for unsupported types are excluded from the catalog.
- Scoped resource relations and capabilities (`5d49013`): per-resource capability discovery reads from the matrix rather than from hardcoded type enums.

## Verification

- `adapters/capability-matrix.ts`: all 4 verified types have connection, metrics, and query capabilities
- Frontend type dropdown only shows verified types
- Creating an instance with `db_type='mongodb'` returns HTTP 400 with "unsupported database type"

## Known Baseline

- Deferred UAT (Phase 84 RBAC, Phase 95 Dameng, Phase 110 DirectAdapter) documented in STATE.md; Phase 138 scope is to execute or downgrade capability status based on evidence.
