---
phase: 110-directadapter-switch
reviewed: 2026-05-26T16:00:00Z
depth: standard
files_reviewed: 33
files_reviewed_list:
  - apps/db-ops-api/server.ts
  - apps/db-ops-api/src/adapter/direct-adapter.ts
  - apps/db-ops-api/src/adapter/get-agent-engine.ts
  - apps/db-ops-api/src/adapter/types.ts
  - apps/db-ops-api/src/chat-database-service.ts
  - frontend/src/openclaw/ui/app-gateway.ts
  - frontend/src/openclaw/ui/direct-gateway.ts
  - frontend/src/openclaw/ui/views/chat.ts
  - frontend/src/openclaw/ui/controllers/chat.ts
  - frontend/src/openclaw/ui/controllers/sessions.ts
  - frontend/src/openclaw/ui/controllers/agents.ts
  - frontend/src/openclaw/ui/controllers/usage.ts
  - frontend/src/openclaw/ui/controllers/cron.ts
  - frontend/src/openclaw/ui/controllers/config.ts
  - frontend/src/openclaw/ui/controllers/exec-approvals.ts
  - frontend/src/openclaw/ui/controllers/agent-identity.ts
  - frontend/src/openclaw/ui/controllers/agent-files.ts
  - frontend/src/openclaw/ui/controllers/agent-skills.ts
  - frontend/src/openclaw/ui/controllers/skills.ts
  - frontend/src/openclaw/ui/controllers/models.ts
  - frontend/src/openclaw/ui/controllers/scope-errors.ts
  - frontend/src/openclaw/ui/app-chat.ts
  - frontend/src/openclaw/ui/app.ts
  - frontend/src/openclaw/ui/chat/slash-commands.ts
  - frontend/src/openclaw/ui/chat/slash-command-executor.ts
  - frontend/src/openclaw/ui/connect-error.ts
  - frontend/src/openclaw/ui/app-lifecycle.ts
  - frontend/src/openclaw/ui/app-view-state.ts
  - frontend/src/openclaw/ui/app-render.helpers.ts
  - frontend/src/openclaw/ui/app-render.ts
  - packages/agent-core/src/runner.ts
  - packages/agent-core/src/session.ts
  - packages/agent-core/src/context.ts
findings:
  critical: 7
  warning: 9
  info: 5
  total: 21
status: issues_found
---

# Phase 110: Code Review Report -- DirectAdapter Switch

**Reviewed:** 2026-05-26T16:00:00Z
**Depth:** standard
**Files Reviewed:** 33
**Status:** issues_found

## Summary

This review covers the DirectAdapter switch migration, which replaces the OpenClaw GatewayBrowserClient with a DirectGatewayClient that connects directly to a WebSocket server embedded in the backend. The review focuses on three areas: (1) correctness of the migration (API contract alignment, import paths, type usage), (2) security (JWT handling, auth bypass vectors), and (3) code quality (dead code, error handling, compatibility shim completeness).

**Key finding:** The `DirectGatewayClient.request()` compatibility shim only handles 2 of approximately 30+ RPC methods used across the controller layer. While `chat.send` and `chat.history` are implemented, every other method called from 13 controllers (sessions, agents, cron, config, skills, usage, etc.) silently logs a warning and returns `undefined`. This means the vast majority of non-chat features are broken in DirectAdapter mode.

Additional critical findings include: a missing JWT_SECRET fallback that makes WS auth trivially bypassable, an unauthenticated chat history REST endpoint, a switch-case fallthrough that triggers incorrect side effects, and a race condition in WebSocket auth where messages can be sent before the auth frame is processed.

---

## Critical Issues

### CR-01: JWT secret falls back to empty string in DirectAdapter WS auth

**File:** `apps/db-ops-api/src/adapter/direct-adapter.ts:181`
**Issue:** The JWT verification uses `process.env.JWT_SECRET_KEY || ''` as the secret. If the `JWT_SECRET_KEY` environment variable is not set (e.g., in development or a misconfigured deployment), the secret is an empty string `''`, making `jwt.verify(token, '')` trivially bypassable. Any token signed with an empty string secret would pass verification.

Additionally, server.ts line 78 uses `randomBytes(32).toString('hex')` as fallback for the same env var. This creates a dangerous inconsistency: tokens signed by server.ts with the random fallback secret will fail verification in direct-adapter.ts because the two modules derive different fallback values.

**Fix:**
```typescript
// direct-adapter.ts line 181
const JWT_SECRET = process.env.JWT_SECRET_KEY;
if (!JWT_SECRET) {
  console.error('[DirectAdapter] JWT_SECRET_KEY not set, rejecting all auth');
  ws.close(4001, 'Server misconfigured: JWT_SECRET_KEY not set');
  return;
}
const decoded = jwt.verify(token, JWT_SECRET);
```

Or use a shared constant module for the JWT secret instead of duplicating the fallback logic.

---

### CR-02: GET /api/chat/history endpoint has no authentication

**File:** `apps/db-ops-api/server.ts:680`
**Issue:** The `GET /api/chat/history` endpoint on line 680 has no `preHandler: [verifyToken]` middleware. All other chat-related API endpoints (`POST /api/chat/send` at line 663, `GET /api/agents` at line 716, `GET /api/sessions` at line 728) include JWT verification. This means anyone can read all chat history without authentication, including all past conversations with their content.

**Fix:**
```typescript
fastify.get('/api/chat/history', { preHandler: [verifyToken] }, async (request, reply) => {
```

---

### CR-03: DirectGatewayClient.request() compatibility shim only supports 2 of 30+ RPC methods

**File:** `frontend/src/openclaw/ui/direct-gateway.ts:130-173`
**Issue:** The `request()` method only handles `chat.send` and `chat.history`. Every other method -- called from 13 controllers and 2 slash command modules -- silently logs a warning and returns `undefined`. This means the following features are broken:

| Controller/Module | Methods Called | Count |
|---|---|---|
| `controllers/agents.ts` | `tools.catalog`, `tools.effective` | 2 |
| `controllers/sessions.ts` | `sessions.compaction.list`, `sessions.patch`, `sessions.delete`, `sessions.compaction.branch`, `sessions.compaction.restore` | 5 |
| `controllers/usage.ts` | `sessions.usage`, `usage.cost`, `sessions.usage.timeseries`, `sessions.usage.logs` | 4 |
| `controllers/cron.ts` | `cron.status`, `models.list`, `cron.list`, `cron.update`, `cron.add`, `cron.run`, `cron.remove`, `cron.runs` | 8 |
| `controllers/config.ts` | `config.get`, `config.schema`, `config.set`, `config.apply`, `update.run`, `config.openFile` | 6 |
| `controllers/exec-approvals.ts` | `exec.approvals.get`, `exec.approvals.set` | 2 |
| `controllers/agent-identity.ts` | `agent.identity.get` | 1 |
| `controllers/agent-files.ts` | `agents.files.list`, `agents.files.get`, `agents.files.set` | 3 |
| `controllers/agent-skills.ts` | `skills.status` | 1 |
| `controllers/skills.ts` | `skills.status`, `skills.update`, `skills.install`, `skills.search`, `skills.detail` | 5 |
| `controllers/models.ts` | `models.list` | 1 |
| `app-chat.ts` | `sessions.reset` | 1 |
| `slash-commands.ts` | `commands.list` | 1 |
| `slash-command-executor.ts` | `sessions.list`, `sessions.patch`, `sessions.compact`, `agents.list`, `chat.abort`, `chat.send`, `sessions.steer`, `models.list` | 8 |

**Total unsupported methods: 30+**

Most of these will silently return `undefined`, causing features like session management, cron jobs, configuration, skills, usage tracking, agent file editing, subagent steering, command loading, and model listing to fail without error visibility.

**Fix:** Either implement each RPC method as a REST API call (like `chat.history` does), or add a startup validation that warns/throttles which features are unavailable. At minimum, add a compile-time or runtime check that throws instead of returning undefined so the user receives feedback instead of silent failures.

---

### CR-04: WebSocket auth race condition -- messages sent before auth_ok received

**File:** `frontend/src/openclaw/ui/direct-gateway.ts:75-84`
**Issue:** The JWT auth token is sent in the `onopen` handler, but the client does not wait for the `auth_ok` response from the server before calling `sendChat()`. If `sendChat()` is called immediately after `connect()` -- as happens during normal operation (app-gateway.ts line 280 calls `directClient.connect()` which triggers onopen -> auth, but the controller could send chat.send immediately) -- the message will arrive at the server before the `auth` frame is processed. The server will close the connection with code 4001 (line 191-193 in direct-adapter.ts: `if (!(ws as any)._authUserId)`).

This is especially likely during app startup where `initChatClient` is called and the first chat message could be queued almost immediately.

**Fix:** Track the auth state in DirectGatewayClient and queue messages until `auth_ok` is received:
```typescript
private authenticated = false;
private pendingMessages: Array<{ sessionKey: string; message: string }> = [];

// In onopen handler:
this.ws!.send(JSON.stringify({ type: 'auth', token }));

// In dispatchEvent, handle auth_ok:
if (type === 'auth_ok') {
  this.authenticated = true;
  // Flush pending
  for (const msg of this.pendingMessages) {
    this.sendChat(msg.sessionKey, msg.message);
  }
  this.pendingMessages = [];
  return;
}

// In sendChat:
if (!this.authenticated) {
  this.pendingMessages.push({ sessionKey, message });
  return;
}
```

---

### CR-05: Switch-case fallthrough in onSlashAction handler

**File:** `frontend/src/openclaw/ui/app.ts:442-444`
**Issue:** The `case "export":` on line 442 is missing a `break` statement, so after calling `exportChatMarkdown()` it falls through to `case "refresh-tools-effective":`. This causes an unintended refresh of tool effectiveness data every time the export action is triggered.

```typescript
case "export":
  exportChatMarkdown(this.chatMessages, this.assistantName);
  // Missing break! Falls through to next case.
case "refresh-tools-effective": {
  void refreshVisibleToolsEffectiveForCurrentSessionInternal(this);
  break;
}
```

**Fix:** Add a `break` after the export call:
```typescript
case "export":
  exportChatMarkdown(this.chatMessages, this.assistantName);
  break;
```

---

### CR-06: Dynamic import path `../chat-database-service.js` may resolve incorrectly at runtime

**File:** `apps/db-ops-api/src/adapter/direct-adapter.ts:213,224`
**Issue:** The `chat()` method uses dynamic `import('../chat-database-service.js')` at lines 213 and 224. This relative path is resolved from the file's location (`src/adapter/`), so the target would be `src/chat-database-service.js`. While this appears correct, the import is inside a hot code path (every `chat.send` message triggers it), creating unnecessary overhead. Worse, if the module system uses a different resolution strategy (e.g., when compiled to JS in a `dist/` directory), the relative path could break.

**Fix:** Import `chatDatabaseService` at the top of the module instead of dynamically:
```typescript
import { chatDatabaseService } from '../chat-database-service.js';
```

If circular dependency is a concern (unlikely since chat-database-service doesn't import adapter modules), document the reason for the dynamic import.

---

### CR-07: invoke() never persists sessions or messages

**File:** `apps/db-ops-api/src/adapter/direct-adapter.ts:368-404`
**Issue:** The `invoke()` method (used for fire-and-forget tasks like AI analysis, alerts) creates an `AgentRunner.run()` execution but never:
1. Creates or retrieves a session via `sessionManager.getOrCreate(sessionKey)`
2. Persists the user message
3. Persists the assistant response
4. Saves session state via `sessionManager.save(session)`

This means `invoke()` runs are invisible in chat history, cannot be resumed, and have no audit trail. If the system crashes during an `invoke()` run, the work is lost with no recovery mechanism.

**Fix:** Add session management similar to `chat()`:
```typescript
async invoke(sessionKey: string, message: string, systemPrompt?: string): Promise<InvokeResult> {
  const session = this.sessionManager.getOrCreate(sessionKey);
  session.addMessage('user', message);
  // ... run ...
  session.addMessage('assistant', result.finalContent ?? '');
  await this.sessionManager.save(session);
  return { content: result.finalContent, usage: result.usage };
}
```

---

## Warnings

### WR-01: Duplicate WebSocket close code 4001 for two different error scenarios

**File:** `apps/db-ops-api/src/adapter/direct-adapter.ts:185,192`
**Issue:** The WS server uses close code 4001 for both (a) JWT verification failure on `auth` frame, and (b) unauthenticated message sent before `auth` frame. The client (direct-gateway.ts line 99) treats code 4001 as `auth_failed` in both cases, which prevents reconnect. If a message race condition triggers scenario (b), the client permanently gives up instead of reconnecting.

**Fix:** Use distinct close codes:
```typescript
// Auth failure (invalid token)
ws.close(4001, 'Unauthorized');

// Unauthenticated message (race condition, retryable)
ws.close(4002, 'Authenticate first');
```

And update the client to only treat 4001 as permanent, with 4002 triggering reconnect.

---

### WR-02: Chat history endpoint returns all sessions data when no sessionKey provided

**File:** `apps/db-ops-api/server.ts:703-708`
**Issue:** When `GET /api/chat/history` is called without a `sessionKey` query parameter, it fetches messages from ALL sessions and concatenates them. This is an unbounded operation that could return thousands of messages, causing memory pressure and slow responses. While this endpoint should have auth per CR-02, even with auth the unbounded fetch is problematic.

**Fix:** Require `sessionKey` parameter and return 400 if missing, or add a hard limit on the total messages returned when aggregating across sessions.

---

### WR-03: No input validation on sessionKey in WS handler

**File:** `apps/db-ops-api/src/adapter/direct-adapter.ts:198-202`
**Issue:** The `rawSessionKey` from the WS message is used directly without validation for length, character set, or injection attacks. It is passed directly to `sessionManager.getOrCreate(sessionKey)`, used in `chatDatabaseService.addMessage()`, and embedded in the `complete` event. While SQL injection is mitigated by parameterized queries in the DB layer, other injection vectors exist (e.g., extremely long keys causing resource exhaustion, special characters causing log injection or XSS in rendered history).

**Fix:** Validate sessionKey length and character set:
```typescript
const rawSessionKey = (msg.sessionKey as string) || `session_${Date.now()}`;
if (rawSessionKey.length > 512) {
  ws.send(JSON.stringify({ type: 'error', error: 'Session key too long' }));
  return;
}
```

---

### WR-04: No idempotencyKey handling on server -- duplicate messages possible

**File:** `apps/db-ops-api/src/adapter/direct-adapter.ts:196-243`
**Issue:** The frontend sends an `idempotencyKey` in chat.send requests (controllers/chat.ts line 225), but the WS handler in direct-adapter.ts ignores it. If the client re-sends the same message (e.g., due to WebSocket reconnect before receiving the error response for the first attempt), the message will be processed twice, creating duplicate conversation entries.

**Fix:** Track seen `idempotencyKey` values per session in a bounded cache and skip re-processing duplicates:
```typescript
// In WS connection handler
const seenIdempotencyKeys = new Set<string>();
const IDEMPOTENCY_CACHE_SIZE = 100;

// In chat.send handler
const idempotencyKey = msg.idempotencyKey as string | undefined;
if (idempotencyKey) {
  if (seenIdempotencyKeys.has(idempotencyKey)) {
    return; // Already processed, skip
  }
  seenIdempotencyKeys.add(idempotencyKey);
  if (seenIdempotencyKeys.size > IDEMPOTENCY_CACHE_SIZE) {
    const first = seenIdempotencyKeys.values().next().value;
    seenIdempotencyKeys.delete(first);
  }
}
```

---

### WR-05: Best-effort DB persistence swallows all errors

**File:** `apps/db-ops-api/src/adapter/direct-adapter.ts:215-216,232-233`
**Issue:** Both the user message persistence (line 215-216) and assistant message persistence (line 232-233) use empty `catch` blocks that silently swallow all errors. If the database is unavailable or the `addMessage` call throws, the error is lost entirely. This makes it impossible to detect and diagnose persistence failures.

**Fix:** Log the error at minimum:
```typescript
catch (dbErr) {
  console.error('[DirectAdapter] Failed to persist message:', dbErr instanceof Error ? dbErr.message : String(dbErr));
}
```

---

### WR-06: Exponential backoff has no jitter -- thundering herd on reconnect

**File:** `frontend/src/openclaw/ui/direct-gateway.ts:236-238`
**Issue:** The exponential backoff formula `INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts)` produces deterministic delays with no jitter. If multiple clients disconnect simultaneously (e.g., server restart), they will all reconnect at precisely the same times, creating a thundering herd.

**Fix:** Add jitter:
```typescript
const delay = Math.min(
  INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
  MAX_RECONNECT_DELAY_MS,
) * (0.5 + Math.random() * 0.5); // 50-100% of calculated delay
```

---

### WR-07: WebSocket has no heartbeat / ping-pong

**File:** `apps/db-ops-api/src/adapter/direct-adapter.ts` (entire WS handler), `frontend/src/openclaw/ui/direct-gateway.ts` (entire class)
**Issue:** Neither the server nor the client implements WebSocket ping/pong or any heartbeat mechanism. A silent disconnection (e.g., network partition, idle timeout by proxy) will not be detected until the next attempted `sendChat()` call. Long-lived idle connections will accumulate without detection.

**Fix:** Add a periodic ping from the server (e.g., every 30 seconds) and handle pong timeout on the client. The `ws` library supports `ws.ping()` natively.

---

### WR-08: `thinkingHolder` and `streamHolder` can get out of sync with mixed reasoning+content

**File:** `apps/db-ops-api/src/adapter/direct-adapter.ts:58-72`
**Issue:** When `emitReasoning` fires interleaved with `onStream` (possible with some LLM providers), `thinkingHolder.text` accumulates reasoning but `streamHolder.text` accumulates everything (reasoning + content). The `complete` event uses `thinkingHolder.text` for `thinkingContent`, which is correct. However, the DB persistence (line 229) embeds thinking as `<think>${thinking}</think>\n\n${event.finalContent}`. If the LLM already included thinking-tagged content in `finalContent`, this would double-embed the thinking.

Additionally, `emitReasoningEnd` (line 67-72) appends `\n\n` to streamHolder and emits a `text_delta` -- but this happens regardless of whether reasoning text was actually accumulated. This produces an unwanted blank line in the stream even when there is no reasoning content.

**Fix:** Guard `emitReasoningEnd`:
```typescript
emitReasoningEnd: async () => {
  if (!thinkingHolder.text) return; // No reasoning content, skip separator
  if (streamHolder) {
    streamHolder.text += '\n\n';
    onEvent({ type: 'text_delta', delta: streamHolder.text });
  }
},
```

---

### WR-09: DirectAdapter type `ChatEvent` in types.ts and frontend `AdapterChatEvent` in direct-gateway.ts have a subtle type mismatch

**File:** `apps/db-ops-api/src/adapter/types.ts:62-70` vs `frontend/src/openclaw/ui/direct-gateway.ts:24-33`
**Issue:** The backend's `ChatEvent` union in types.ts has 8 variants including `thinking_delta` and `thinking_end`. The frontend's `AdapterChatEvent` in direct-gateway.ts mirrors these. However, the `dispatchEvent` method in direct-gateway.ts (lines 211-225) explicitly handles `thinking_delta` and `thinking_end` types by forwarding them to onEvent. In app-gateway.ts (lines 186-191), these events are silently ignored (case body is empty `break`). This means the frontend receives `thinking_delta` / `thinking_end` events but discards them, while the `streamHolder` mechanism in direct-adapter.ts already embeds reasoning into `text_delta` events. The client-side events are unnecessary and create confusion about which path handles reasoning display.

**Fix:** Either remove `thinking_delta`/`thinking_end` from the Wire protocol (since reasoning is embedded in `text_delta` via streamHolder), or add `thinking_delta` dispatch in app-gateway.ts to route them to the frontend's thinking display mechanism.

---

## Info

### IN-01: `isRetryableStartupUnavailable` always returns false (dead code)

**File:** `frontend/src/openclaw/ui/controllers/chat.ts:78-81`
**Issue:** The function `isRetryableStartupUnavailable` unconditionally returns `false`. It was designed for the old Gateway RPC where certain startup states were retryable. In DirectAdapter mode, it is dead code. The retry loop in `loadChatHistory()` (lines 134-158) will never retry, so the loop always runs exactly once.

**Fix:** Remove the retry loop (lines 134-158) and keep only the try/catch, since the retry condition is never true:

Or, more conservatively, mark the function and retry loop for cleanup in a follow-up since removing the loop changes control flow.

---

### IN-02: No-op functions retained for backward compatibility

**Files:**
- `frontend/src/openclaw/ui/controllers/sessions.ts:128-132` -- `subscribeSessions()`
- `frontend/src/openclaw/ui/controllers/scope-errors.ts:1-9` -- `isMissingOperatorReadScopeError()`

These are documented as backward-compatibility stubs but are no longer called by any active code path. Consider removing them.

---

### IN-03: `requestHistory()` method in DirectGatewayClient is never called

**File:** `frontend/src/openclaw/ui/direct-gateway.ts:183-189`
**Issue:** The `requestHistory()` method sends a `chat.history` message over WebSocket, but the WS server handler for `chat.history` (direct-adapter.ts lines 245-248) returns an empty history `{ type: 'complete', history: [] }`. Meanwhile, the actual chat history is fetched via REST API in the `request()` compatibility shim (lines 138-168). The `requestHistory()` WS method is dead code and the WS `chat.history` handler is always empty.

**Fix:** Remove the WS `chat.history` case from both client and server, since history is served via REST.

---

### IN-04: `abortChatRun()` in controllers/chat.ts calls `chat.abort` which is unsupported

**File:** `frontend/src/openclaw/ui/controllers/chat.ts:372-387`
**Issue:** `abortChatRun()` calls `state.client.request("chat.abort", ...)` which is unsupported by `DirectGatewayClient.request()` and will log a warning and return `undefined`. The calling code checks `if (!state.client || !state.connected)` but does not handle the `undefined` return (since it awaits the result), so abort appears to succeed but has no effect on the server. The user sees the chat as stopped locally but the server continues processing.

**Fix:** Add a local-only abort fallback that at minimum disconnects the stream and marks the run as interrupted, even without server-side cancellation.

---

### IN-05: `chat.send` request sends `deliver: false` parameter that DirectAdapter ignores

**File:** `frontend/src/openclaw/ui/controllers/chat.ts:220-226`
**Issue:** The `requestChatSend()` function sends parameters `deliver: false` and `idempotencyKey: params.runId` in the chat.send request. The DirectAdapter WS handler (direct-adapter.ts lines 197-241) does not read or handle these parameters. The `deliver: false` flag controlled whether the gateway broadcast the message to other clients, which is irrelevant for direct adapter mode. The `idempotencyKey` is also ignored (see WR-04).

**Fix:** Remove the `deliver: false` parameter from the request payload since it has no meaning in DirectAdapter mode. Either implement `idempotencyKey` or remove it from the request to avoid confusion.

---

_Reviewed: 2026-05-26T16:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
