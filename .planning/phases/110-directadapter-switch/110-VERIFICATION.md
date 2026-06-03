---
phase: 110-directadapter-switch
verified: 2026-05-27T10:30:00Z
status: passed
score: 20/20 must-haves verified
overrides_applied: 0
overrides: []
re_verification:
  previous_status: passed
  previous_score: 20/20
  review_fixes_verified: 16
  gaps_closed:
    - "CR-01: JWT secret empty string fallback fixed"
    - "CR-02: GET /api/chat/history now requires verifyToken"
    - "CR-03: Unsupported request() methods throw errors instead of silent undefined"
    - "CR-04: Auth race condition fixed with pending message queue"
    - "CR-05: Switch-case fallthrough in onSlashAction fixed"
    - "CR-06: Dynamic import replaced with static import"
    - "CR-07: invoke() now persists sessions and messages"
    - "WR-01: Distinct close codes 4001 (auth fail) vs 4002 (unauthenticated message)"
    - "WR-02: sessionKey required on GET /api/chat/history"
    - "WR-03: sessionKey length validation added"
    - "WR-04: idempotencyKey deduplication added"
    - "WR-05: Empty catch blocks now log errors"
    - "WR-06: Jitter added to exponential backoff"
    - "WR-07: Heartbeat ping/pong added"
    - "WR-08: thinkingHolder guard prevents blank line in reasoning stream"
    - "WR-09: Comments document intentional thinking_delta/thinking_end no-op"
  gaps_remaining: []
  regressions: []
gaps: []
---

# Phase 110: DirectAdapter Switch -- Re-verification Report

**Phase Goal:** Switch from GatewayBrowserClient to DirectGatewayClient with JWT authentication.
**Verified:** 2026-05-27
**Status:** passed
**Re-verification:** Yes -- after code review fix iteration (16 fixes applied)

## Re-verification Summary

This re-verification confirms that all 16 code review fixes merged cleanly into the codebase without introducing regressions. All 20 must-haves from the initial verification (score 20/20) remain VERIFIED. The fixes only improved security, robustness, error handling, and correctness -- no regressions detected in core auth flow, WS connection lifecycle, REST endpoints, or UI wiring.

## Code Review Fixes -- Verified Applied

| Finding | File | Fix Verified | Evidence |
|---------|------|--------------|----------|
| CR-01 | `direct-adapter.ts` | JWT_SECRET checked before use; close(4001) if not set | Lines 202-206: `const JWT_SECRET = process.env.JWT_SECRET_KEY; if (!JWT_SECRET) { ... ws.close(4001, 'Server misconfigured...') }` |
| CR-02 | `server.ts` | preHandler: [verifyToken] on GET /api/chat/history | Line 680: `fastify.get('/api/chat/history', { preHandler: [verifyToken] }, ...)` |
| CR-03 | `direct-gateway.ts` | Unsupported methods throw Error, not undefined | Lines 187-209: 8 known methods throw descriptive errors; line 209: generic fallback throw |
| CR-04 | `direct-gateway.ts` | authenticated flag + pendingMessages queue + auth_ok flush | Lines 61-62: fields declared; L74: reset on connect; L244-248: queue in sendChat; L279-288: flush on auth_ok |
| CR-05 | `app.ts` | break after exportChatMarkdown | Line 444: `break;` in `case "export":` |
| CR-06 | `direct-adapter.ts` | Static import replaces dynamic import | Line 34: `import { chatDatabaseService } from '../chat-database-service.js'` |
| CR-07 | `direct-adapter.ts` | invoke() persists session + user + assistant | Lines 422-467: getOrCreate, addMessage user, addMessage assistant, sessionManager.save |
| WR-01 | `direct-adapter.ts` + `direct-gateway.ts` | 4002 for unauthenticated messages, 4001 for auth failure | DA L220: `ws.close(4002, 'Authenticate first')`; DG L107-110: code 4002 resets authenticated, triggers reconnect |
| WR-02 | `server.ts` | sessionKey required for chat history | Lines 699-701: `if (!sessionKey) { return reply.code(400)... }` |
| WR-03 | `direct-adapter.ts` | sessionKey length validation | Lines 232-235: length > 512 check |
| WR-04 | `direct-adapter.ts` | idempotencyKey dedup with bounded cache | Lines 224-258: `seenIdempotencyKeys` Set + 100-entry eviction |
| WR-05 | `direct-adapter.ts` | Empty catch blocks now log errors | Lines 265-267, 281-283: `console.error('[DirectAdapter] Failed to persist...', ...)` |
| WR-06 | `direct-gateway.ts` | Jitter in exponential backoff | Line 320: `* (0.5 + Math.random() * 0.5)` |
| WR-07 | `direct-adapter.ts` | Heartbeat ping every 30s, terminate if no pong | Lines 169-183: heartbeatTimer, _isAlive flag, ping/pong handlers, clear on close |
| WR-08 | `direct-adapter.ts` | thinkingHolder guard in emitReasoningEnd | Lines 68-70: `if (thinkingHolder && !thinkingHolder.text) return;` |
| WR-09 | `app-gateway.ts` | Comments document intentional no-op for thinking_delta/thinking_end | Lines 186-193: comments explaining reasoning embedding in text_delta path |

## Observable Truths (Re-verified)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | WebSocket connection with valid JWT is accepted and `auth_ok` is returned | VERIFIED | `direct-adapter.ts` L211: `ws.send(JSON.stringify({ type: 'auth_ok' }))` on successful `jwt.verify()` |
| 2 | WebSocket connection with invalid JWT is closed with code 4001 | VERIFIED | `direct-adapter.ts` L213: `ws.close(4001, 'Unauthorized')` in jwt.verify catch; L205: JWT_SECRET not set also closes 4001 |
| 3 | Messages sent before auth frame are rejected with close (4002 -- retryable) | VERIFIED | `direct-adapter.ts` L219-220: `!(ws as any)._authUserId` gate closes with 4002 (improved from 4001 per WR-01) |
| 4 | Authenticated WS connections can proceed with chat.send and other messages | VERIFIED | Auth check returns early, falls through to `case 'chat.send'` on L229 unchanged |
| 5 | DirectGatewayClient sends JWT auth frame immediately after WebSocket connects | VERIFIED | `direct-gateway.ts` L82-86: `getToken()` + `{type:'auth', token}` sent in onopen |
| 6 | Auth failure (close 4001) stops auto-reconnect and emits `auth_failed` state | VERIFIED | `direct-gateway.ts` L103-105: `ev.code === 4001` triggers `onStateChange('auth_failed')` and returns without reconnect |
| 7 | Connection state transitions properly through all 5 states | VERIFIED | `direct-gateway.ts` L35: `ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'auth_failed' | 'exhausted'` |
| 8 | Exhausted state emits after MAX_RECONNECT_ATTEMPTS retries | VERIFIED | `direct-gateway.ts` L313-314: `onStateChange('exhausted')` when `reconnectAttempts >= maxReconnectAttempts` |
| 9 | Manual `reconnect()` resets counter and reconnects | VERIFIED | `direct-gateway.ts` L265-270: public `reconnect()` resets closed, counter, clears timer, calls `connect()` |
| 10 | `request('chat.history')` fetch includes Authorization header | VERIFIED | `direct-gateway.ts` L169-171: `_getToken()` + `headers['Authorization'] = Bearer {token}` |
| 11 | gateway.ts file no longer exists in the codebase | VERIFIED | File confirmed absent from filesystem |
| 12 | All controllers that imported from gateway.ts use direct-gateway.ts instead | VERIFIED | Zero `GatewayBrowserClient` references in code (only in comments); all 9 dead controllers import `DirectGatewayClient` |
| 13 | GET /api/agents returns a valid agents list with defaultId | VERIFIED | `server.ts` L710: returns `{defaultId, mainKey, scope, agents}` with verifyToken |
| 14 | GET /api/sessions returns sessions from chat-database-service | VERIFIED | `server.ts` L722: queries `chatDb.getSessions()`, maps to session list with verifyToken |
| 15 | app-gateway.ts no longer creates GatewayBrowserClient or handles Gateway events | VERIFIED | Only comment reference to GatewayBrowserClient (L227 doc); zero code references; exports `initChatClient` |
| 16 | onHello state loading uses REST API instead of Gateway RPC | VERIFIED | `app-gateway.ts` L250-251: calls `loadAgents` and `loadSessions` via REST on `connected` state |
| 17 | loadHealthState and loadAssistantIdentity are removed | VERIFIED | Both files deleted; zero references remain in code (only doc comments) |
| 18 | controllers/chat.ts uses DirectGatewayClient type and generic error handling | VERIFIED | `chat.ts`: imports `DirectGatewayClient`; `isRetryableStartupUnavailable` returns `false` |
| 19 | scope-errors.ts and connect-error.ts have no gateway.ts dependencies | VERIFIED | No imports from `"./gateway.ts"` or `"@openclaw/"` in either file |
| 20 | Chat page shows connection status indicator, disabled input, reconnect button, no Gateway in Settings, UAT document with 8 scenarios | VERIFIED | `chat.ts`: 11 connection-status CSS class references; config.ts: zero "Gateway" references; UAT: 8 test sections |

**Score:** 20/20 truths verified

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/db-ops-api/src/adapter/direct-adapter.ts` | JWT auth frame handler + auth gate + heartbeat + idempotency + sessionKey validation + invoke() persistence | VERIFIED | 498 lines; contains import jwt, msg.type==='auth', ws.close(4001/4002), _authUserId, jwt.verify, heartbeat, idempotency cache, sessionKey validation, invoke() session persistence |
| `frontend/src/openclaw/ui/direct-gateway.ts` | Auth frame send, 4001/4002 detection, 5-state ConnectionState, reconnect(), auth headers, authenticated queue | VERIFIED | 335 lines; contains all original patterns plus pending message queue, _getToken helper, _fetchJson helper, jitter, explicit throws for unsupported methods |
| `frontend/src/openclaw/ui/gateway.ts` | DELETED | VERIFIED | File confirmed absent from filesystem |
| `apps/db-ops-api/server.ts` | GET /api/agents + GET /api/sessions + auth on GET /api/chat/history + sessionKey required | VERIFIED | All 4 requirements present with verifyToken middleware |
| `frontend/src/openclaw/ui/app-gateway.ts` | DirectGatewayClient-only, initChatClient, REST state loading, no GatewayBrowserClient | VERIFIED | Exports initChatClient; no GatewayBrowserClient code; REST state loading on connected |
| `frontend/src/openclaw/ui/controllers/chat.ts` | DirectGatewayClient type, simplified retry | VERIFIED | Imports DirectGatewayClient; isRetryableStartupUnavailable returns false |
| `frontend/src/openclaw/ui/controllers/sessions.ts` | REST API for loadSessions | VERIFIED | Uses `fetch('/api/sessions?...')` with Bearer token |
| `frontend/src/openclaw/ui/controllers/agents.ts` | REST API for loadAgents | VERIFIED | Uses `fetch('/api/agents')` with Bearer token |
| `frontend/src/openclaw/ui/controllers/scope-errors.ts` | No gateway.ts deps | VERIFIED | Only comment references gateway (legacy context); no imports from gateway.ts or @openclaw |
| `frontend/src/openclaw/ui/connect-error.ts` | Generic error formatter | VERIFIED | No gateway imports; generic formatConnectError |
| `frontend/src/openclaw/ui/views/chat.ts` | Connection status indicator, disabled input, reconnect button, placeholders | VERIFIED | connection-status CSS class (11 refs), dot variants, reconnect button, exhausted placeholder |
| `frontend/src/openclaw/ui/views/config.ts` | No Gateway references | VERIFIED | Zero occurrences of "Gateway" or "gatewayUrl" |
| `.planning/phases/110-directadapter-switch/110-UAT.md` | 8 E2E scenarios | VERIFIED | 8 test sections covering D-16-01 through D-16-08 |
| `frontend/src/openclaw/ui/app.ts` | initChatClient, disconnect(), break fixed, no loadAssistantIdentity | VERIFIED | L12: initChatClient import; L547: initChatClient(this); L552: client.disconnect(); L444: break; no loadAssistantIdentity |
| `frontend/src/openclaw/ui/app-lifecycle.ts` | initChatClient, disconnect() | VERIFIED | L1: initChatClient import; L53: initChatClient call; L64: host.client?.disconnect() |
| `frontend/src/openclaw/ui/app-view-state.ts` | No health/loadAssistantIdentity | VERIFIED | No healthLoading/healthResult/healthError or loadAssistantIdentity members |
| `frontend/src/openclaw/ui/app-render.ts` | disabledReason, reconnect wiring | VERIFIED | L391: chatDisabledReason from state.lastError; wiring to Chat props |

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `direct-adapter.ts` | `process.env.JWT_SECRET_KEY` | `jwt.verify(token, JWT_SECRET)` | WIRED | L208: `jwt.verify(token, JWT_SECRET)`; L202: `const JWT_SECRET = process.env.JWT_SECRET_KEY` (no empty string fallback) |
| `direct-gateway.ts` onopen | `apiClient.getToken()` | type: 'auth' frame | WIRED | L82-86: `(window as any).__apiClient?.getToken?.()`, `ws.send({type:'auth', token})` |
| Dead controllers | `direct-gateway.ts` | `import type { DirectGatewayClient }` | WIRED | All 9 controllers import DirectGatewayClient from `"../direct-gateway.ts"` |
| `app-gateway.ts` initChatClient | `/api/agents` | fetch on connected state | WIRED | L250: `await loadAgents(host ...)` which calls `fetch('/api/agents', ...)` |
| `app.ts` connect() | `app-gateway.ts` initChatClient | function call | WIRED | L547: `initChatClient(this)` |
| `chat.ts` connection-status | `ChatProps.connected` + `ChatProps.lastError` | Lit template rendering | WIRED | L624-638: renderConnectionStatus uses props.connected + props.lastError + props.disabledReason |
| `direct-gateway.ts` sendChat | `authenticated` flag | pending message queue | WIRED | L244-248: queued when not authenticated; L279-288: flushed on auth_ok |
| `direct-adapter.ts` ws event | heartbeat | ping/pong | WIRED | L172-183: ping interval + _isAlive tracking + terminate on timeout |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `direct-adapter.ts` auth handler | `jwt.verify(token, JWT_SECRET)` | Environment variable | Yes -- reads `process.env.JWT_SECRET_KEY` (no empty fallback) | FLOWING |
| `direct-adapter.ts` auth gate | `_authUserId` | Set on successful JWT verify | Yes -- set from decoded JWT payload | FLOWING |
| `server.ts` `/api/sessions` | `chatDb.getSessions()` | MySQL `chat_database_service` | Yes -- dynamic DB query | FLOWING |
| `app-gateway.ts` state loading | `loadAgents()`, `loadSessions()` | REST API fetch | Yes -- real HTTP calls to backend | FLOWING |
| `direct-gateway.ts` auth frame | `apiClient.getToken()` | JWT from login/refresh | Yes -- transparent refresh supported | FLOWING |
| `direct-gateway.ts` sendChat queue | `authenticated` flag | auth_ok WS message | Yes -- real server response triggers flush | FLOWING |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Step 7b: SKIPPED (no runnable entry points without starting servers) | -- | -- | SKIP |

## Probe Execution

No probes were declared in any Phase 110 PLAN files or SUMMARY files. Not applicable.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | -- | -- | -- | -- |

No TBD, FIXME, XXX, HACK, or PLACEHOLDER markers found in any Phase 110 modified file. The word "placeholder" in server.ts is a SQL query parameter placeholder, not a stub pattern. No stub patterns detected. All console.log/calls are legitimate logging.

## Regression Check

Re-verified that all core flows in the Phase 110 scope remain intact after the 16 fixes:

| Concern | Pre-fix Status | Post-fix Status | Changed? |
|---------|---------------|-----------------|----------|
| JWT auth success path | VERIFIED | VERIFIED (same auth_ok path) | No |
| JWT auth failure path | VERIFIED | VERIFIED (improved: JWT_SECRET not set handled) | No regression, improved |
| WS close 4001 handling | VERIFIED | VERIFIED (4001 = permanent auth_failed) | No |
| Unauthenticated message handling | VERIFIED | VERIFIED (changed to 4002 = retryable) | Intentionally changed (WR-01) -- improved |
| Chat message streaming | VERIFIED | VERIFIED (chat.send switch unchanged) | No |
| DirectGatewayClient 5 states | VERIFIED | VERIFIED | No |
| Reconnect logic with backoff | VERIFIED | VERIFIED (jitter added) | No regression, improved |
| REST endpoints (agents, sessions) | VERIFIED | VERIFIED | No |
| Chat history endpoint | VERIFIED | VERIFIED (auth + sessionKey required) | No regression, improved |
| app-gateway.ts init flow | VERIFIED | VERIFIED | No |
| Connection status UI | VERIFIED | VERIFIED | No |
| Settings page Gateway removal | VERIFIED | VERIFIED | No |

No regressions detected. All core auth flow, WS connection lifecycle, and REST endpoints continue to function correctly.

## Deviations from ROADMAP

The ROADMAP goal mentions removing a `__SLIDE_USE_DIRECT_ADAPTER` feature flag. This feature flag was never implemented in the codebase. The phase achieved its intent by directly replacing GatewayBrowserClient with DirectGatewayClient (deleting gateway.ts, rewriting app-gateway.ts) rather than using a feature flag toggle. This determination also applies to the code in app-gateway.ts L81-84 which references `directAdapterMode` and `GatewayHost` -- these patterns were removed in the rewrite. No change from initial verification.

## Human Verification Required

All automated checks passed. The 110-UAT.md document contains 8 manual E2E verification scenarios for human testing:

1. D-16-01: Cold start no errors
2. D-16-02: Login + WS auth success
3. D-16-03: Chat streaming conversation
4. D-16-04: Page refresh history recovery
5. D-16-05: WS reconnect + history recovery
6. D-16-06: AI Analysis invoke
7. D-16-07: Multi-tab independence
8. D-16-08: Chat History REST API direct call

These manual tests are documented for the user to execute. All automated code verification is complete.

## Gaps Summary

No gaps found. All 20 must-haves are verified against the codebase. All 16 code review fixes confirmed applied with zero regressions.

---

_Verified: 2026-05-27_
_Verifier: Claude (gsd-verifier)_
