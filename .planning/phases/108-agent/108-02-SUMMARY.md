---
phase: 108-agent
plan: 02
type: execute
subsystem: adapter
tags:
  - adapter
  - OpenClawAdapter
  - IAgentEngine
  - file-migration
  - gateway-removal
requires:
  - 108-01
provides:
  - OpenClawAdapter implementation (IAgentEngine)
  - adapter/openclaw/ directory (all OpenClaw files isolated)
  - gateway/ directory removal
  - config-sync.ts relocation to adapter/openclaw/llm/
affects:
  - server.ts (import paths)
  - ai-agent-bridge.ts (import paths)
tech-stack:
  added: []
  patterns:
    - OpenClawAdapter wraps dispatchInboundMessage behind IAgentEngine
    - All OpenClaw files in adapter/openclaw/
    - Platform code no longer has direct gateway/ imports
key-files:
  created:
    - adapter/openclaw/openclaw-adapter.ts
    - adapter/__tests__/openclaw-adapter.test.ts
    - adapter/openclaw/llm/config-sync.ts
  modified:
    - adapter/openclaw/openclaw-runtime.ts (moved + import depth update)
    - adapter/openclaw/server.ts (moved + import path update)
    - adapter/openclaw/chat-methods.ts (moved + import depth update)
    - adapter/openclaw/streaming.ts (moved, no import changes)
    - adapter/openclaw/openclaw-bridge.ts (moved, no import changes)
    - adapter/openclaw/config-service.ts (moved, no import changes)
    - adapter/openclaw/protocol.ts (moved, no import changes)
    - adapter/openclaw/error-codes.ts (moved, no import changes)
    - server.ts (import paths updated to adapter/openclaw/)
    - ai-agent-bridge.ts (import path updated to adapter/openclaw/)
  deleted:
    - gateway/ directory (entire directory: 10 files)
    - llm/config-sync.ts (moved to adapter/openclaw/llm/)
    - openclaw-integration.ts (dead code per D-31)
decisions: []
metrics:
  duration: "10 minutes"
  tasks: 3
  files_created: 3
  files_modified: 10
  files_deleted: 12
completed: 2026-05-25T20:16:00+08:00
---

# Phase 108 Agent Plan 02: OpenClawAdapter Implementation + File Migration Summary

OpenClawAdapter implementation wrapping `dispatchInboundMessage` behind the `IAgentEngine` interface, plus complete migration of all OpenClaw-related files from `src/gateway/` (10 files) and `src/llm/config-sync.ts` into `adapter/openclaw/`. The `gateway/` directory has been deleted entirely.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected import path depth for migrated files**
- **Found during:** Task 1
- **Issue:** The original `openclaw-runtime.ts` and `chat-methods.ts` used `../../../src/` (3 levels up from `gateway/`) to import from OpenClaw source, which resolves to `apps/src/auto-reply/` — a nonexistent path. This was a pre-existing bug silently masked by TypeScript module resolution. Additionally, the initial migration used `../../../../src/` from the new `adapter/openclaw/` location, but the correct depth requires `../../../../../src/` (5 levels up to project root).
- **Fix:** Verified path depth with a Python script. Used `../../../../../src/` for all OpenClaw source imports from `adapter/openclaw/` location.
- **Files modified:** `openclaw-runtime.ts`, `openclaw-adapter.ts`, `chat-methods.ts` (all at `adapter/openclaw/`)
- **Commit:** `8a191603fbb`

**2. [Rule 1 - Bug] Fixed test file import paths and dispatchInboundMessage reference**
- **Found during:** Task 1 verification
- **Issue:** Test file `openclaw-adapter.test.ts` referenced `dispatchInboundMessage` without import and used wrong mock paths (`./gateway-client.js` instead of `../openclaw/gateway-client.js`)
- **Fix:** Used correct relative paths for vi.mock from `__tests__/` location, added proper `vi.importMock()` calls to avoid rootDir compilation errors
- **Files modified:** `openclaw-adapter.test.ts`
- **Commit:** `8a191603fbb`

**3. [Rule 3 - Blocking] Deleted dead code `openclaw-integration.ts`**
- **Found during:** Task 3
- **Issue:** `src/openclaw-integration.ts` imported from `./gateway/` which was deleted. File was confirmed dead code (D-31 — no imports from any other file).
- **Fix:** Deleted the file.
- **Files modified:** `openclaw-integration.ts` (deleted)
- **Commit:** `1dba25ebac5`

## Stub Tracking

- `openclaw-adapter.ts` line 175: `listTools()` returns empty array if `start()` has not been called. This is by design — OpenClaw tools are loaded lazily in `start()`, before which no tools are registered. This stub is resolved once `start()` completes.
- `openclaw-adapter.ts` line 115: `invoke()` returns `{ content: null }` for fire-and-forget tasks via `sendGatewayChat`. This is intrinsic to the OpenClaw fire-and-forget pattern — the Gateway processes the task asynchronously and does not return content.

## Completed Tasks

### Task 1: OpenClawAdapter (with start()) — `2947a17e66b`

- Created `adapter/openclaw/openclaw-adapter.ts` implementing `IAgentEngine`:
  - `.start()` lazily calls `getOpenClawRuntime()` + `startGatewayServer(28789)` (idempotent)
  - `.chat()` creates `MsgContext`, `ReplyDispatcher` with `ChatEvent`-mapped callbacks, calls `dispatchInboundMessage`
  - `.invoke()` calls `sendGatewayChat` (fire-and-forget)
  - `.listTools()` returns OpenClaw tool definitions
  - `.capabilities()` returns `{ streaming: true, toolCalling: true, maxContextTokens: 200000, supportsCustomSystemPrompt: false }`
- Migrated `openclaw-runtime.ts` (import depth: `../../../../src/` → `../../../../../src/`)
- Migrated `gateway-client.ts` (no import changes)
- Created `adapter/__tests__/openclaw-adapter.test.ts` (10 tests, all passing)
- Deleted originals: `gateway/openclaw-runtime.ts`, `gateway/gateway-client.ts`, `gateway/openclaw-integration.test.ts`

### Task 2: Migrate remaining gateway/*.ts → adapter/openclaw/ — `8a191603fbb`

Migrated 7 files with the following import path changes:
- `server.ts`: `'../auth-database-service'` → `'../../auth-database-service'`
- `chat-methods.ts`: `'../chat-database-service'` → `'../../chat-database-service'`, `../../../../src/` → `../../../../../src/`
- `streaming.ts`, `openclaw-bridge.ts`, `config-service.ts`, `protocol.ts`, `error-codes.ts`: no import changes needed
- Deleted `gateway/` directory entirely

### Task 3: Migrate config-sync.ts + update external imports — `1dba25ebac5`

- Migrated `llm/config-sync.ts` to `adapter/openclaw/llm/config-sync.ts` (import: `'../llm-database-service'` → `'../../../llm-database-service'`)
- Updated `server.ts` import paths: `gateway/openclaw-runtime` → `adapter/openclaw/openclaw-runtime`, `gateway/config-service` → `adapter/openclaw/config-service`, `llm/config-sync` → `adapter/openclaw/llm/config-sync`
- Updated `ai-agent-bridge.ts` import: `gateway/gateway-client` → `adapter/openclaw/gateway-client`

## Verification Results

| Check | Result |
|-------|--------|
| `gateway/` directory deleted | PASSED |
| `adapter/openclaw/` has 10 files + `llm/config-sync.ts` | PASSED (11 files) |
| `src/llm/config-sync.ts` deleted | PASSED |
| Zero `from.*../gateway/` imports | PASSED |
| TypeScript compilation (non-TS5101) | PASSED |
| OpenClawAdapter tests (10 tests) | PASSED (10/10) |

## File Migration Verification

- [x] All 10 files from `gateway/` directory moved to `adapter/openclaw/`
- [x] Each file's import paths verified for correct depth at new location (5 levels up to project root for OpenClaw source)
- [x] `gateway/` directory deleted
- [x] `adapter/openclaw/` contains: `chat-methods.ts`, `config-service.ts`, `error-codes.ts`, `gateway-client.ts`, `openclaw-adapter.ts`, `openclaw-bridge.ts`, `openclaw-runtime.ts`, `protocol.ts`, `server.ts`, `streaming.ts`, `llm/config-sync.ts`
- [x] `adapter/__tests__/openclaw-adapter.test.ts` exists (replaces `openclaw-integration.test.ts`, 10 tests passing)

## Success Criteria

1. [x] OpenClawAdapter implements `IAgentEngine` interface (with `.start()`)
2. [x] `adapter/openclaw/` directory contains all OpenClaw-related files (11 files)
3. [x] `gateway/` directory deleted
4. [x] `config-sync.ts` migrated from `src/llm/` to `adapter/openclaw/llm/`
5. [x] All import paths updated for new depth
6. [x] TypeScript compilation passes (TS5101 deprecation pre-existing)
7. [x] OpenClawAdapter tests pass (10/10)

## Self-Check: PASSED

- [x] `adapter/openclaw/openclaw-adapter.ts` created and implements `IAgentEngine`
- [x] `adapter/openclaw/openclaw-runtime.ts` exists with `../../../../../src/` import paths
- [x] `adapter/openclaw/gateway-client.ts` exists
- [x] `gateway/openclaw-runtime.ts` no longer exists
- [x] `gateway/gateway-client.ts` no longer exists
- [x] `adapter/__tests__/openclaw-adapter.test.ts` has 10 test cases
- [x] `gateway/` directory deleted
- [x] `src/llm/config-sync.ts` no longer exists
- [x] `adapter/openclaw/llm/config-sync.ts` exists with `../../../llm-database-service` import
- [x] All 3 commits exist in git log
