---
phase: 110-directadapter-switch
plan: 03
subsystem: api
tags: [gateway-removal, directadapter, controllers, rest-api, fastify]

requires:
  - phase: 109-nanobot
    provides: DirectGatewayClient, chat-database-service, chat history REST API
provides:
  - gateway.ts deletion (D-01: complete removal of GatewayBrowserClient)
  - GET /api/agents REST endpoint for agent list without Gateway RPC
  - GET /api/sessions REST endpoint for session list without Gateway RPC
  - 9 dead controller files updated to import DirectGatewayClient instead of GatewayBrowserClient
affects: [110-04: app-gateway.ts refactoring, 110-05: auth & verification]

tech-stack:
  added: []
  patterns:
    - "Dead controllers for removed OpenClaw tabs now import DirectGatewayClient type"
    - "REST API endpoints for boot-time data loading (agents, sessions) replacing Gateway RPC"

key-files:
  deleted:
    - frontend/src/openclaw/ui/gateway.ts
  modified:
    - apps/db-ops-api/server.ts (added REST endpoints)
    - frontend/src/openclaw/ui/controllers/exec-approvals.ts
    - frontend/src/openclaw/ui/controllers/agent-identity.ts
    - frontend/src/openclaw/ui/controllers/usage.ts
    - frontend/src/openclaw/ui/controllers/cron.ts
    - frontend/src/openclaw/ui/controllers/agent-files.ts
    - frontend/src/openclaw/ui/controllers/agent-skills.ts
    - frontend/src/openclaw/ui/controllers/skills.ts
    - frontend/src/openclaw/ui/controllers/config.ts
    - frontend/src/openclaw/ui/controllers/models.ts

key-decisions:
  - "Static agent list for /api/agents: Slide agent identity is fixed per D-04, no dynamic agent loading needed"
  - "Dead controllers retain DirectGatewayClient type import for compilation; actual functionality is dead code (removed OpenClaw tabs)"

patterns-established:
  - "Boot-time state loads (agents, sessions) use REST API instead of Gateway RPC"

requirements-completed: []

duration: 12min
completed: 2026-05-26
---

# Phase 110 Plan 03: Remove gateway.ts, REST API endpoints, controller import fixes

**Removed GatewayBrowserClient and gateway.ts completely, added REST API endpoints for agents and sessions, and updated 9 dead controller imports to use DirectGatewayClient type**

## Performance

- **Duration:** 12 min
- **Started:** 2026-05-26T10:48:00Z (approx)
- **Completed:** 2026-05-26T11:00:00Z (approx)
- **Tasks:** 2
- **Files modified:** 11 (1 deleted, 1 modified, 9 modified)

## Accomplishments

- gateway.ts (GatewayBrowserClient, 16 exports, ~470 lines) completely removed from the codebase (D-01)
- `GET /api/agents` REST endpoint added to server.ts with verifyToken middleware (T-110-05 mitigated)
- `GET /api/sessions` REST endpoint added to server.ts, fetching from chat-database-service with verifyToken middleware (T-110-06 mitigated, D-08)
- All 9 dead controllers updated to import `DirectGatewayClient` from `"../direct-gateway.ts"` instead of `GatewayBrowserClient` from `"../gateway.ts"`
- No TypeScript compilation errors from dead controller imports (no more reference to deleted file)

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove gateway.ts and add REST API endpoints for agents and sessions** - `2e8941aa8e6` (feat)
2. **Task 2: Fix dead controller imports in 9 controller files** - `5afcd7a9a32` (feat)

## Files Created/Modified

- `apps/db-ops-api/server.ts` - Added `GET /api/agents` and `GET /api/sessions` REST endpoints
- `frontend/src/openclaw/ui/gateway.ts` - DELETED (GatewayBrowserClient, 16 exports, ~470 lines)
- `frontend/src/openclaw/ui/controllers/exec-approvals.ts` - Updated import to DirectGatewayClient
- `frontend/src/openclaw/ui/controllers/agent-identity.ts` - Updated import to DirectGatewayClient
- `frontend/src/openclaw/ui/controllers/usage.ts` - Updated import to DirectGatewayClient
- `frontend/src/openclaw/ui/controllers/cron.ts` - Updated import to DirectGatewayClient
- `frontend/src/openclaw/ui/controllers/agent-files.ts` - Updated import to DirectGatewayClient
- `frontend/src/openclaw/ui/controllers/agent-skills.ts` - Updated import to DirectGatewayClient
- `frontend/src/openclaw/ui/controllers/skills.ts` - Updated import to DirectGatewayClient
- `frontend/src/openclaw/ui/controllers/config.ts` - Updated import to DirectGatewayClient
- `frontend/src/openclaw/ui/controllers/models.ts` - Updated import to DirectGatewayClient

## Decisions Made

- **Static agent list**: /api/agents returns a hardcoded agent identity (Slide Agent) because agent identity is fixed per D-04. No dynamic agent loading needed from Gateway RPC.
- **Dead controllers keep imports**: The 9 dead controllers are for removed OpenClaw tabs and only need their state types to compile. They retain the `DirectGatewayClient | null` type for `client` fields.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Worktree file path resolution: The initial Edit write targeted the main repo copy of server.ts instead of the worktree copy. Detected during verification (worktree `git status` showed no changes). Fixed by reading and editing via the worktree-relative path. Root cause: worktree and main repo are separate filesystems (different inodes) in this workspace configuration.

## User Setup Required

None - no external service configuration required.

## Threat Flags

No new threat surface introduced beyond the plan's threat_model. Both new endpoints are protected by verifyToken middleware.

## Next Phase Readiness

- Plan 04 can proceed: app-gateway.ts refactoring (onHello state loading, chat.ts/health.ts sessions.ts agents.ts import updates)
- Dead controller compilation is fixed — no broken imports remain from the gateway.ts deletion

---

*Phase: 110-directadapter-switch*
*Completed: 2026-05-26*
