---
phase: 92-ai-analysis-visibility
plan: 03
subsystem: api
tags: [fastify, system_config, config-service, ai-analysis]

requires:
  - phase: 00
    provides: server.ts Fastify app with auth middleware, db-connection singleton

provides:
  - ai-analysis-config-service.ts with getConfig/saveConfig persisted to system_config table
  - GET /api/ai/analysis/recent endpoint for recent diagnosis queries
  - GET /api/ai/config and PUT /api/ai/config endpoints for auto-analysis config CRUD

affects: [92-04, 92-05, frontend config panel]

tech-stack:
  added: []
  patterns: ["system_config-based feature toggles", "dbConnection.getPool() singleton service pattern"]

key-files:
  created:
    - apps/db-ops-api/src/ai-analysis-config-service.ts
  modified:
    - apps/db-ops-api/server.ts

key-decisions:
  - "REPLACE INTO (ON DUPLICATE KEY UPDATE) used for config persistence, matching existing system_config table patterns"
  - "GET /api/ai/analysis/recent registered before GET /api/ai/analysis/:id to avoid Fastify route conflicts"
  - "No server-side cron format validation — per UI-SPEC Edge Cases, client-side validation only"
  - "Default config returned on database error to avoid blocking frontend rendering"

patterns-established:
  - "Configuration services follow singleton + getPool/isConnected pattern from ai-analysis-database-service.ts"
  - "Config stored as JSON.stringify in system_config.config_value, parsed and merged with defaults on read"

requirements-completed: ["AI-01"]

duration: 4min
completed: 2026-05-14
---

# Phase 92 Plan 03: Auto-Analysis Config Service and Diagnosis Query API

**Config service with getConfig/saveConfig in system_config, recent diagnosis endpoint by instance_id + analysis_type, and config CRUD routes**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-14
- **Completed:** 2026-05-14
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Created `AiAnalysisConfigService` with `getConfig()` reading from `system_config` and `saveConfig()` with field-level validation
- Added `GET /api/ai/analysis/recent` returning completed diagnoses filtered by instance_id + analysis_type with configurable limit
- Added `GET /api/ai/config` returning auto-analysis configuration
- Added `PUT /api/ai/config` saving validated configuration via `REPLACE INTO system_config`

## Task Commits

Each task was committed atomically:

1. **Task 1: Create ai-analysis-config-service.ts** - `ed7735c3fd7` (feat)
2. **Task 2: Add API routes for recent diagnosis and config CRUD** - `81e31ff9d3c` (feat)

**Plan metadata:** (committed in wave-final commit by orchestrator)

## Files Created/Modified

- `apps/db-ops-api/src/ai-analysis-config-service.ts` - Config service class with getConfig/saveConfig, AiAnalysisConfig interface with 6 fields, DEFAULT_CONFIG constant, field validation
- `apps/db-ops-api/server.ts` - Added import for aiAnalysisConfigService, 3 new routes (GET /api/ai/analysis/recent, GET /api/ai/config, PUT /api/ai/config)

## Decisions Made

- Used `REPLACE INTO` (INSERT ... ON DUPLICATE KEY UPDATE) for config persistence, matching existing system_config usage in server.ts `/api/version` route
- Registered `/recent` route before `/:id` route per Fastify static-before-parametric registration best practice
- Cron expression validated only as non-empty string server-side; format validation deferred to client per UI-SPEC Edge Cases
- Default config returned on any database error to ensure frontend can always render the config panel

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Backend API layer for auto-analysis config is complete, ready for frontend config panel (Plan 04)
- Recent diagnosis endpoint available for instance detail page diagnosis history (Plan 05)

## Self-Check

- [x] ai-analysis-config-service.ts exports AiAnalysisConfig interface and singleton
- [x] GET /api/ai/analysis/recent route registered
- [x] GET /api/ai/config route registered
- [x] PUT /api/ai/config route registered with validation
- [x] Import added to server.ts
- [x] TypeScript compiles clean (no new errors)

## Known Stubs

None.

---
*Phase: 92-ai-analysis-visibility (Plan 03)*
*Completed: 2026-05-14*
