---
phase: 110-directadapter-switch
plan: 05
subsystem: frontend
tags: [chat-view, connection-status, settings-cleanup, uat-document]
requires:
  - 110-04 (app-gateway.ts initChatClient + ConnectionState wiring)
  - 110-02 (DirectGatewayClient ConnectionState + reconnect())
provides:
  - WS connection status indicator in Chat view
  - Clean Settings page (no Gateway URL/Status references)
  - UAT document with 8 manual E2E verification scenarios
affects:
  - 110-VERIFICATION.md (UAT tests reference)
tech-stack:
  added: []
  patterns:
    - "Connection status indicator via in-template Lit helper function"
    - "`onRefresh` dual behavior: reconnect() when exhausted, loadChatHistory() when connected"
    - "`disabledReason` derived from `state.lastError` instead of hardcoded translation key"
key-files:
  created:
    - .planning/phases/110-directadapter-switch/110-UAT.md
  modified:
    - frontend/src/openclaw/ui/views/chat.ts
    - frontend/src/openclaw/ui/app-render.ts
    - frontend/src/openclaw/ui/views/config.ts
  deleted: []
decisions:
  - disabledReason set to state.lastError (null when connected/disconnected-reconnecting, error text when exhausted/auth_failed)
  - Reconnect button uses onRefresh prop (falls through to onReconnect if provided)
  - gatewayUrl prop removed from ConfigProps interface and all call sites
metrics:
  duration: ~15 min
  completed: "2026-05-26"
---

# Phase 110 Plan 05: Chat Connection Status & Settings Cleanup Summary

**Added WS connection status indicator (green/gray/magenta dot + text + reconnect button) to Chat view, updated disconnected placeholder text, removed Gateway URL/Status rows from Settings page, and created UAT document covering 8 E2E verification scenarios.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-05-26T19:00:00Z (approx)
- **Completed:** 2026-05-26T19:15:00Z (approx)
- **Tasks:** 3
- **Files modified:** 3 (1 created, 3 modified)

## Accomplishments

### Task 1: Add WS connection status indicator to Chat view

- Added `lastError` and `onReconnect` props to `ChatProps` interface
- Added `renderConnectionStatus(props)` helper function with green/connected, gray/connecting, magenta/disconnected dots
- Status text: "已连接" / "正在连接..." / "重新连接中..." / "连接失败" / "认证失败，请重新登录"
- Reconnect button rendered only on exhausted state, clicking calls `client.reconnect()`
- CSS styles added inline in chat template: connection-status container, dot variants with glow, reconnect button with hover effects
- Placeholder text changes: "重新连接中..." (disconnected) / "连接失败，请检查网络" (exhausted)
- In `app-render.ts`: `disabledReason` now derived from `state.lastError` instead of hardcoded `t("chat.disconnected")`; `onRefresh` handler calls `state.client.reconnect()` when exhausted; `lastError` prop passed to Chat

### Task 2: Clean up Settings page

- Removed `gatewayUrl` prop from `ConfigProps` interface
- Removed Gateway URL row (`settings-info-row`) from Connection section
- Removed Status row (connected/offline indicator with `settings-status-dot`) from Connection section
- Removed `gateway` SVG icon from `sidebarIcons` map
- Removed `{ key: "gateway", label: "Gateway" }` nav entry from `SECTION_CATEGORIES`
- Removed `gatewayUrl: state.settings.gatewayUrl` from `commonConfigProps` in `app-render.ts`
- Assistant name row preserved in Connection section

### Task 3: Create UAT document with 8 manual verification scenarios

- Created `.planning/phases/110-directadapter-switch/110-UAT.md`
- 8 tests covering: D-16-01 (cold start), D-16-02 (login+auth), D-16-03 (chat stream), D-16-04 (history reload), D-16-05 (WS reconnect), D-16-06 (AI analysis), D-16-07 (multi-tab), D-16-08 (REST API)
- Sign-off table with all 8 rows, date/sign line

## Task Commits

Each task was committed atomically:

| Task | Description | Commit Hash |
|------|-------------|-------------|
| 1 | Add WS connection status indicator to Chat view | `9501a4ca653` |
| 2 | Clean up Settings page — remove Gateway URL, Status, icon, nav entry | `720be8b2ec5` |
| 3 | Create UAT document with 8 E2E verification scenarios | `7f2276d0ee5` |

## Files Modified

| File | Change |
|------|--------|
| `frontend/src/openclaw/ui/views/chat.ts` | +renderConnectionStatus, +lastError/onReconnect props, updated placeholder, CSS |
| `frontend/src/openclaw/ui/app-render.ts` | disabledReason from lastError, onRefresh reconnect, lastError prop, removed gatewayUrl |
| `frontend/src/openclaw/ui/views/config.ts` | Removed gatewayUrl prop, Gateway/Status rows, gateway icon, gateway nav |
| `.planning/phases/110-directadapter-switch/110-UAT.md` | CREATED — 8 test scenarios |

## Deviations from Plan

None — plan executed exactly as written.

## Decisions Made

- **disabledReason derived from state.lastError:** Instead of hardcoded `t("chat.disconnected")`, `disabledReason` is set to `state.lastError` which is `null` when connected/disconnected-reconnecting or the error text when exhausted/auth_failed. This enables placeholder differentiation between reconnecting and exhausted states.
- **Reconnect button uses onRefresh prop:** The connection status indicator's "重新连接" button calls `props.onRefresh`. In app-render.ts, `onRefresh` checks `state.lastError` to decide whether to call `client.reconnect()` (exhausted) or `loadChatHistory()` (normal refresh).

## Threat Flags

None — UI-only changes, no new trust boundaries.

## Known Stubs

None identified.

## Next Phase Readiness

- 110-UAT.md ready for manual E2E verification
- Plan 05 completes the frontend DirectAdapter switch UI changes
- Remaining: full end-to-end verification across all 110 plans

## Self-Check: PASSED

| Item | Status |
|------|--------|
| Commit 1: `9501a4ca653` | Verified |
| Commit 2: `720be8b2ec5` | Verified |
| Commit 3: `7f2276d0ee5` | Verified |
| `chat.ts` has `connection-status` CSS class | 11 occurrences |
| `chat.ts` has "重新连接中..." placeholder | 1 occurrence |
| `chat.ts` has "连接失败，请检查网络" placeholder | 1 occurrence |
| `chat.ts` has `connection-status__reconnect` button | 3 occurrences |
| `config.ts` has 0 "Gateway" references | Verified |
| `config.ts` has 0 "gatewayUrl" references | Verified |
| `110-UAT.md` has 8 test sections | Verified |
| `110-UAT.md` sign-off table has 8 test rows | Verified |
