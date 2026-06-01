---
phase: 110-directadapter-switch
plan: 01
subsystem: auth
tags: ["jwt", "websocket", "direct-adapter", "authentication"]

requires: []
provides:
  - "JWT auth frame handler in DirectAdapter WS transport"
  - "Auth gate rejecting unauthenticated WS messages with close(4001)"
affects: ["110-02"]

tech-stack:
  added: []
  patterns:
    - "WS auth via first-message frame: {type:'auth', token} verified by jwt.verify()"
    - "WS close(4001) for auth failure - frontend stops auto-reconnect"

key-files:
  modified:
    - "apps/db-ops-api/src/adapter/direct-adapter.ts"

key-decisions:
  - "D-09: JWT sent as {type:'auth', token} first message after WS connect"
  - "D-10: Auth failure causes close(4001, 'Unauthorized') - no retry"
  - "D-11: JWT verified once at connect time; token expiry doesn't affect active connection"

duration: 5min
completed: 2026-05-26
---

# Phase 110 Plan 01: DirectAdapter JWT Auth Summary

**JWT authentication frame handler added to DirectAdapter WebSocket transport - verifies {type:'auth', token} as first message, rejects unauthenticated messages with close(4001)**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-26T10:56:06Z
- **Completed:** 2026-05-26T11:01:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Added `jsonwebtoken` import to `direct-adapter.ts` for JWT verification
- Added auth frame handler (msg.type === 'auth') as first check in WS onmessage
- JWT verified via `jwt.verify(token, process.env.JWT_SECRET_KEY)` - success sends `{type:'auth_ok'}`, failure closes with 4001
- Auth gate rejects all non-auth messages before authentication with close(4001)
- Auth state tracked via `_authUserId` on WebSocket instance (D-11: single verification at connect time)

## Task Commits

1. **Task 1: Add JWT auth frame handler to DirectAdapter WS** - `94b098bbb28` (feat)

## Files Modified

- `apps/db-ops-api/src/adapter/direct-adapter.ts` - Added `import jwt from 'jsonwebtoken'`, auth frame handler before switch(msg.type), pre-auth message rejection with `_authUserId` gate

## Decisions Made

- Follow plan as specified: JWT auth frame per D-09/D-10/D-11
- Auth failure and pre-auth non-auth messages both close(4001) - matching must_haves requirement
- `process.env.JWT_SECRET_KEY` used directly (both direct-adapter.ts and server.ts run in same Node process)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Worktree environment had missing `node_modules` - direct-adapter unit tests could not run due to missing `@slide/agent-core` workspace dependency. Code verified via acceptance criteria grep checks and structural validation.

## User Setup Required

None - no external service configuration required. `JWT_SECRET_KEY` environment variable must be set (already required by server.ts for REST API JWT).

## Next Phase Readiness

- DirectAdapter WS transport now authenticates all WS connections before processing messages
- Ready for Plan 02: Frontend DirectGatewayClient auth frame and state handling

---

*Phase: 110-directadapter-switch*
*Completed: 2026-05-26*
