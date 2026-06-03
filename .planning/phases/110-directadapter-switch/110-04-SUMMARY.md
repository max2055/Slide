---
phase: 110-directadapter-switch
plan: 04
subsystem: frontend
tags: [app-gateway, direct-gateway, controllers, rest-api, gateway-removal]

requires:
  - 110-02 (DirectGatewayClient auth frame + ConnectionState)
  - 110-03 (gateway.ts deletion + REST API endpoints)

provides:
  - DirectGatewayClient-only app-gateway.ts (no GatewayBrowserClient)
  - REST API state loading for agents and sessions on connect
  - Cleaned scope-errors.ts and connect-error.ts without gateway.ts deps

affects:
  - 110-05: full end-to-end verification

tech-stack:
  added: []
  patterns:
    - "Boot-time state loads via REST API (GET /api/agents, GET /api/sessions)"
    - "initChatClient as replacement for connectGateway"
    - "Generic error formatting without gateway-specific error codes"

key-files:
  created: []
  deleted:
    - frontend/src/openclaw/ui/controllers/health.ts
    - frontend/src/openclaw/ui/controllers/assistant-identity.ts
  modified:
    - frontend/src/openclaw/ui/app-gateway.ts (rewritten: 803 -> 256 lines)
    - frontend/src/openclaw/ui/controllers/scope-errors.ts
    - frontend/src/openclaw/ui/connect-error.ts
    - frontend/src/openclaw/ui/controllers/chat.ts
    - frontend/src/openclaw/ui/controllers/sessions.ts
    - frontend/src/openclaw/ui/controllers/agents.ts
    - frontend/src/openclaw/ui/app-chat.ts
    - frontend/src/openclaw/ui/app.ts
    - frontend/src/openclaw/ui/app-lifecycle.ts
    - frontend/src/openclaw/ui/app-view-state.ts
    - frontend/src/openclaw/ui/app-render.helpers.ts
    - frontend/src/openclaw/ui/chat/slash-commands.ts
    - frontend/src/openclaw/ui/chat/slash-command-executor.ts
    - frontend/src/openclaw/ui/views/overview.ts

decisions:
  - app-chat.ts/slash-commands/slash-command-executor/overview.ts fixed as Rule 2 deviation (broken imports from deleted gateway.ts)
  - hello type replaced with Record<string, unknown> / local type in files that use it
  - subscribeSessions kept as no-op for backward compat; sessions loaded via REST on demand

metrics:
  duration: ~60 min
  completed: "2026-05-26"
---

# Phase 110 Plan 04: Controller Migration and app-gateway.ts Refactoring Summary

**Rewired app orchestration layer from GatewayBrowserClient to DirectGatewayClient-only, migrated boot-time state loading (agents, sessions) to REST API, removed dead controllers (health, assistant-identity), and cleaned gateway.ts dependencies from scope-errors and connect-error.**

## Performance

- **Duration:** ~60 min
- **Started:** 2026-05-26T11:30:00Z (approx)
- **Completed:** 2026-05-26T12:30:00Z (approx)
- **Tasks:** 4
- **Files modified:** 18 (2 deleted, 14 modified, plus 4 pre-Task-3 fixes)

## Accomplishments

### Task 1: Remove dead controllers, clean scope-errors and connect-error

- `controllers/health.ts` and `controllers/assistant-identity.ts` completely removed (D-04)
- `scope-errors.ts`: removed all GatewayRequestError and gateway.ts dependencies. `isMissingOperatorReadScopeError` now returns `false` (no Gateway RPC scope errors)
- `connect-error.ts`: replaced with generic error formatter. Removed all gateway-specific error codes (AUTH_TOKEN_MISMATCH, AUTH_UNAUTHORIZED, etc.)

### Task 2: Rewrite active controllers for DirectGatewayClient + REST API

- `controllers/chat.ts`: `ChatState.client` type changed from `GatewayBrowserClient | null` to `DirectGatewayClient | null`. `isRetryableStartupUnavailable` returns `false` (no Gateway RPC retry). `resolveStartupRetryDelayMs` removed
- `controllers/sessions.ts`: `SessionsState.client` changed to `DirectGatewayClient | null`. `subscribeSessions` is a no-op. `loadSessions` uses `fetch('/api/sessions', ...)` with JWT Bearer token
- `controllers/agents.ts`: `AgentsState.client` changed to `DirectGatewayClient | null`. `loadAgents` uses `fetch('/api/agents', ...)` with JWT Bearer token. `loadToolsCatalog`, `loadToolsEffective` remain using `client.request()` (compatible with DirectGatewayClient)

### Task 3: Rewrite app-gateway.ts

- Completely rewritten from ~803 lines to ~256 lines
- Removed: `connectGateway`, `handleGatewayEvent`, `handleGatewayEventUnsafe`, `GatewayHost` type, `handleTerminalChatEvent`, `handleSessionMessageGatewayEvent`, `applySnapshot`, `applySessionDefaults`, `normalizeSessionKeyForDefaults`
- New exported entry point: `initChatClient(host)` - creates DirectGatewayClient, wires onEvent/onStateChange, loads agents/sessions/permissions on connected state
- Kept: `handleDirectAdapterEvent`, `mapAdapterChatEventToPayload`, `handleChatGatewayEvent` (simplified)

### Task 4: Update app.ts, app-lifecycle.ts, app-view-state.ts, app-render.helpers.ts

- `app.ts`: imports `initChatClient` instead of `connectGateway`. `connect()` calls `initChatClient(this)`. `logout()` calls `this.client.disconnect()` instead of `this.client.stop()`. Removed `loadAssistantIdentity` method/import
- `app-lifecycle.ts`: imports `initChatClient`. `handleDisconnected` uses `disconnect()` instead of `stop()`
- `app-view-state.ts`: `client` type changed to `DirectGatewayClient | null`. Removed `healthLoading/healthResult/healthError` and `loadAssistantIdentity` from interface
- `app-render.helpers.ts`: removed 2 `state.loadAssistantIdentity()` calls

### Fixed broken imports from deleted gateway.ts (Rule 2 deviations)

- `app-chat.ts`: `GatewayBrowserClient -> DirectGatewayClient`, `GatewayHelloOk -> Record<string, unknown>`
- `chat/slash-commands.ts`: `GatewayBrowserClient -> DirectGatewayClient`
- `chat/slash-command-executor.ts`: `GatewayBrowserClient -> DirectGatewayClient` (all 15+ function signatures)
- `views/overview.ts`: `GatewayHelloOk -> local HelloSnapshot type`

## Task Commits

Each task was committed atomically:

| Task | Description | Commit Hash |
|------|-------------|-------------|
| 1 | Remove health.ts/assistant-identity.ts, rewrite scope-errors.ts, connect-error.ts | `cbd4e7f9672` |
| 2 | Rewrite chat/sessions/agents controllers for DirectGatewayClient + REST API | `3ef1d8cd04c` |
| - | Fix broken gateway.ts imports in app-chat.ts, slash-commands, etc. (Rule 2) | `ace8d8f6e9f` |
| 3 | Rewrite app-gateway.ts - DirectGatewayClient-only | `8b9bba729a8` |
| 4 | Update app.ts, app-lifecycle.ts, app-view-state.ts, app-render.helpers.ts | `71940848e08` |

## Files Modified

| File | Change |
|------|--------|
| `frontend/src/openclaw/ui/controllers/health.ts` | DELETED |
| `frontend/src/openclaw/ui/controllers/assistant-identity.ts` | DELETED |
| `frontend/src/openclaw/ui/controllers/scope-errors.ts` | Rewritten (no gateway.ts deps) |
| `frontend/src/openclaw/ui/connect-error.ts` | Rewritten (generic formatter) |
| `frontend/src/openclaw/ui/controllers/chat.ts` | DirectGatewayClient type, simplified retry |
| `frontend/src/openclaw/ui/controllers/sessions.ts` | DirectGatewayClient + REST API |
| `frontend/src/openclaw/ui/controllers/agents.ts` | DirectGatewayClient + REST API |
| `frontend/src/openclaw/ui/app-chat.ts` | Fixed gateway.ts imports |
| `frontend/src/openclaw/ui/chat/slash-commands.ts` | Fixed gateway.ts imports |
| `frontend/src/openclaw/ui/chat/slash-command-executor.ts` | Fixed gateway.ts imports |
| `frontend/src/openclaw/ui/views/overview.ts` | Fixed gateway.ts imports |
| `frontend/src/openclaw/ui/app-gateway.ts` | Rewritten (803 -> 256 lines) |
| `frontend/src/openclaw/ui/app.ts` | initChatClient, disconnect(), removed loadAssistantIdentity |
| `frontend/src/openclaw/ui/app-lifecycle.ts` | initChatClient, disconnect() |
| `frontend/src/openclaw/ui/app-view-state.ts` | DirectGatewayClient, removed health/loadAssistantIdentity |
| `frontend/src/openclaw/ui/app-render.helpers.ts` | Removed loadAssistantIdentity calls |

## Deviations from Plan

### Rule 2 - Auto-add missing critical functionality

**Fixed broken imports from deleted gateway.ts in 4 additional files**

- **Found during:** Pre-Task 3
- **Issue:** `app-chat.ts`, `chat/slash-commands.ts`, `chat/slash-command-executor.ts`, and `views/overview.ts` still imported types from `"./gateway.ts"`, which was deleted in Plan 03. These files are actively used (app-chat.ts is imported by app-gateway.ts). Without fixing, TypeScript compilation would fail.
- **Fix:** Replaced `GatewayBrowserClient` with `DirectGatewayClient` (app-chat.ts, slash-commands.ts, slash-command-executor.ts) and `GatewayHelloOk` with `Record<string, unknown>` / local type (app-chat.ts, overview.ts)
- **Files modified:** 4 (outside plan's file list)
- **Commit:** `ace8d8f6e9f`

## Decisions Made

- **app-chat.ts/slash-commands/slash-command-executor/overview.ts fix as Rule 2:** These files were not in the plan's explicit file list but had broken imports from the deleted gateway.ts. Fixed as auto-add missing critical functionality.
- **subscribeSessions kept as no-op:** Sessions are loaded via REST API on demand. The no-op stub maintains backward compatibility with call sites.
- **hello type replaced with Record:** The `hello` property (previously `GatewayHelloOk`) is only used to access `.snapshot` and `.policy` properties in a few places. Replaced with `Record<string, unknown> | null` to avoid creating a new type dependency.

## Threat Flags

None - all security-relevant changes (JWT Bearer token in REST calls, generic error messages) match the plan's threat model:

| Threat | Component | Status |
|--------|-----------|--------|
| T-110-07 | loadAgents REST call | Mitigated: Bearer token in Authorization header |
| T-110-08 | loadSessions REST call | Mitigated: Bearer token in Authorization header |
| T-110-09 | Error formatting | Accept: generic error messages, no sensitive info leaked |

## Known Stubs

None identified.

## Next Phase Readiness

- Plan 05 (E2E verification) can proceed: all DirectGatewayClient wiring is complete
- The full DirectAdapter switch is wired: login -> initChatClient -> DirectGatewayClient -> REST API state loading -> chat via WS

## Self-Check: PASSED

| Item | Status |
|------|--------|
| Commit 1: `cbd4e7f9672` | Verified |
| Commit 2: `3ef1d8cd04c` | Verified |
| Commit 3: `ace8d8f6e9f` | Verified |
| Commit 4: `8b9bba729a8` | Verified |
| Commit 5: `71940848e08` | Verified |
| File: `controllers/health.ts` | DELETED |
| File: `controllers/assistant-identity.ts` | DELETED |
| File: `app-gateway.ts` | Found (256 lines) |
| No gateway.ts references in modified files | Verified |
