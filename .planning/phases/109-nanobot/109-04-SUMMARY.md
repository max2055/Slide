---
phase: 109-nanobot
plan: 04
type: execute
wave: 4
tags: [frontend, direct-adapter, websocket, protocol-cleanup]
requires: [109-03]
provides: [
  "frontend DirectAdapter WS client",
  "dual-mode gateway support",
  "chat-only protocol schema cleanup"
]
affects: [frontend/src/openclaw/ui/, frontend/src/openclaw/protocol/]

tech-stack:
  added: [DirectGatewayClient (native WS client)]
  changed: [app-gateway.ts (dual-mode)]
  removed: [ChatEvent AJV validators, chat-only protocol schema exports]

key-files:
  created:
    - frontend/src/openclaw/ui/direct-gateway.ts (DirectGatewayClient class)
    - frontend/src/openclaw/ui/direct-gateway.test.ts (10 contract tests)
  modified:
    - frontend/src/openclaw/ui/gateway.ts (deprecation notice)
    - frontend/src/openclaw/ui/app-gateway.ts (dual-mode DirectAdapter integration)
    - frontend/src/openclaw/protocol/index.ts (removed chat-only validators/exports)
    - frontend/src/openclaw/protocol/schema.ts (removed broken logs-chat re-export)
    - frontend/src/openclaw/protocol/schema/protocol-schemas.ts (removed chat-only imports)
    - frontend/src/openclaw/protocol/schema/types.ts (removed chat-only type exports)

decisions:
  - "DirectGatewayClient.onEvent receives AdapterChatEvent (not ChatEventPayload) to avoid coupling client to chat controller state; mapping happens in app-gateway.ts"
  - "DirectAdapter mode detection via window.__SLIDE_USE_DIRECT_ADAPTER flag; future auto-probe deferred to Phase 112"
  - "Protocol barrel at protocol/ has pre-existing module resolution issues (missing files); chat-only removal is additive cleanup toward Phase 112 full removal"

metrics:
  duration_minutes: 20
  completed_at: 2026-05-25T23:10:00Z
---

# Phase 109 Plan 04: DirectAdapter WS Frontend Integration

**One-liner:** Created DirectGatewayClient (minimal WS client for DirectAdapter native chat.send + ChatEvent protocol), added dual-mode support to app-gateway.ts, and removed chat-only Gateway protocol schema references from protocol/ barrel.

## Tasks

### Task 1: DirectAdapter WS client and dual-mode app-gateway.ts (TDD)

**RED** `test(109-04):` (39b1d26) -- Added 10 contract tests for DirectGatewayClient: construction, API shape, sendChat/requestHistory, state transitions, AdapterChatEvent types.

**GREEN** `feat(109-04):` (652263e) -- Created `direct-gateway.ts` with:
- `DirectGatewayClient` class -- thin WS wrapper for DirectAdapter protocol
- `AdapterChatEvent` discriminated union (6 types: text_delta, tool_start, tool_result, tool_error, complete, error)
- Exponential backoff reconnection (1s .. 30s, max 10 attempts)
- No auth handshake, no heartbeat, no request/response frames
- Added deprecation notice to `gateway.ts` GatewayBrowserClient
- Added dual-mode support to `app-gateway.ts`:
  - `DirectGatewayClient` import alongside existing `GatewayBrowserClient`
  - `initDirectAdapterClient()` -- detection (window.__SLIDE_USE_DIRECT_ADAPTER) and setup
  - `mapAdapterChatEventToPayload()` -- AdapterChatEvent to ChatEventPayload converter
  - `handleDirectAdapterEvent()` -- routes text_delta/complete/error through handleChatEvent, tool_* through handleAgentEvent

**REFACTOR** `fix(109-04):` (96a42b7) -- Fixed tool event AgentEventPayload construction (proper fields instead of unsafe type cast).

### Task 2: Remove chat-only Gateway protocol schema files

`refactor(109-04):` (8a920ce) -- Removed from `protocol/` barrel:
- ChatEventSchema, ChatHistoryParamsSchema, ChatSendParamsSchema, ChatAbortParamsSchema, ChatInjectParams -- imports and ProtocolSchemas entries removed from protocol-schemas.ts
- ChatAbortParams, ChatInjectParams, ChatEvent type exports removed from types.ts
- ValidateChatEvent, validateChatSendParams, validateChatHistoryParams, validateChatAbortParams, validateChatInjectParams AJV validators removed from index.ts
- Corresponding schema re-exports and type re-exports removed from index.ts
- Removed broken `export * from "./schema/logs-chat.js"` from schema.ts
- LogsTail schemas preserved (not chat-only)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] AdapterChatEvent type definition**

- **Found during:** Task 1
- **Issue:** DirectGatewayClient.onEvent typed as ChatEventPayload (from controllers/chat.ts) but DirectAdapter WS sends AdapterChatEvent (from adapter/types.ts) which has different fields -- no runId/sessionKey
- **Fix:** Defined `AdapterChatEvent` union locally in direct-gateway.ts instead of importing ChatEventPayload. onEvent callback now receives AdapterChatEvent; mapping to ChatEventPayload happens in app-gateway.ts
- **Files created:** frontend/src/openclaw/ui/direct-gateway.ts (AdapterChatEvent types)
- **Commit:** 652263e7c67

**2. [Rule 1 - Bug] Unsafe AgentEventPayload cast for tool events**

- **Found during:** Task 1
- **Issue:** `event as unknown as AgentEventPayload` would produce runtime type mismatch (different fields)
- **Fix:** Constructed proper AgentEventPayload with runId, seq, stream, ts, sessionKey, data
- **Files modified:** frontend/src/openclaw/ui/app-gateway.ts
- **Commit:** 96a42b76800

## Known Stubs

None. All created/modified code is functional, though the full DirectAdapter -> chat controller wiring requires the DirectAdapter to be running for end-to-end testing. The DirectGatewayClient is designed for drop-in use once detection is active.

## Threat Surface Scan

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new_ws_endpoint | frontend/src/openclaw/ui/direct-gateway.ts | New WebSocket connection to DirectAdapter port (28789) — same-host only by default, matching existing GatewayBrowserClient security posture |

## Verification Results

```bash
# Tests: 10 passed
npx vitest run src/openclaw/ui/direct-gateway.test.ts -> 10/10 ✓

# No stray chat schema imports
grep -r "from.*protocol/schema/Chat" frontend/src/ -> Clean

# DirectGatewayClient imported in app-gateway.ts
grep -c "DirectGatewayClient" frontend/src/openclaw/ui/app-gateway.ts -> 5

# All chat-only references removed from protocol/index.ts
grep -c "ChatEvent\|ChatAbort\|ChatInject\|ChatHistory\|ChatSend" frontend/src/openclaw/protocol/index.ts -> 0
```

## Self-Check

- [x] All files created verified with `[ -f ]`
- [x] All commits verified in `git log`
- [x] Tests pass (10/10)
- [x] No chat-only schema imports remain
- [x] No new tsc errors from our changes (pre-existing barrel errors unchanged)

## Self-Check: PASSED
