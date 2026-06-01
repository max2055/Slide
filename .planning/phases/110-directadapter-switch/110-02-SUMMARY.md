---
phase: 110
plan: 02
phase_name: directadapter-switch
plan_name: auth-frame-and-connection-lifecycle
type: execute
wave: 1
wait_for_phase: null
subsystem: frontend
tags:
  - direct-adapter
  - websocket
  - jwt-auth
  - connection-lifecycle
requires:
  - 110-01 (DirectGatewayClient skeleton)
provides:
  - Auth frame on WS connect
  - 4001 close code detection
  - 5-state ConnectionState
  - Exhausted state on retry limit
  - reconnect() public method
  - Auth headers in request() shim
affects:
  - frontend/src/openclaw/ui/direct-gateway.ts
tech-stack:
  added:
    - None (native TS/WS)
  patterns:
    - JWT token fetched at connect time via apiClient.getToken()
    - 4001 numeric close code detection
    - Exhausted state signal via onStateChange
key-files:
  created: []
  modified:
    - frontend/src/openclaw/ui/direct-gateway.ts (201 lines)
decisions:
  - Token fetched at connect time (not constructor) to support transparent refresh — per RESEARCH.md Pitfall 2
  - 4001 close code compared as number (ev.code === 4001) without depending on ev.reason — per RESEARCH.md Pitfall 3
  - MAX_RECONNECT_ATTEMPTS exported for testability
metrics:
  duration: ~15 min
  completed: "2026-05-26"
---

# Phase 110 Plan 02: Auth Frame and Connection Lifecycle Summary

**One-liner:** Enhanced DirectGatewayClient with JWT auth frame on WS connect, 4001 close code detection, 5-state ConnectionState, exhausted retry state with manual reconnect(), and auth headers in REST API shim.

## Task Results

### Task 1: Auth frame sending and 4001 close code detection

- Expanded `ConnectionState` type from 3 states to 5: `connecting | connected | disconnected | auth_failed | exhausted`
- Added JWT auth frame send in `onopen` handler: fetches token via `apiClient.getToken()` at connect time and sends `{type:'auth', token}` as first WS message
- Added 4001 close code detection in `onclose` handler: stops reconnect when `ev.code === 4001`, emits `'auth_failed'` state
- **Commit:** `352c533c3ce`

### Task 2: Exhausted state, reconnect(), auth headers, export MAX_RECONNECT_ATTEMPTS

- Changed `scheduleReconnect()` exhausted guard: previously silent return when `reconnectAttempts >= maxReconnectAttempts` now emits `onStateChange('exhausted')`
- Added `reconnect()` public method: resets `closed` flag, retry counter, clears reconnect timer, then calls `connect()`
- Updated `request('chat.history')` auth header: replaced `localStorage.getItem('token')` with `apiClient.getToken()` for transparent token refresh support
- Exported `MAX_RECONNECT_ATTEMPTS` constant for test access
- **Commit:** `178bdd26081`

## Deviations from Plan

**None.** Plan executed exactly as written.

## Success Criteria Verification

- [x] DirectGatewayClient sends `{type:'auth', token}` in onopen handler
- [x] WS close(4001) triggers 'auth_failed' state with no reconnect
- [x] Reconnect retries emit 'exhausted' after max attempts
- [x] `client.reconnect()` resets counter and reconnects
- [x] `request('chat.history')` fetch includes `Authorization: Bearer <token>` header

## Auth Gates

None encountered.

## Known Stubs

None identified.

## Threat Flags

None — all changes are on the browser side (internal trust boundary per threat model).

## Self-Check: PASSED

| Item | Status |
|------|--------|
| Commit 1: `352c533c3ce` | Verified |
| Commit 2: `178bdd26081` | Verified |
| File: `frontend/src/openclaw/ui/direct-gateway.ts` | Found (201 lines) |
