---
phase: "109-nanobot"
plan: "01"
subsystem: "agent-core"
tags: ["session", "timeout", "nanobot-port", "persistence", "jsonl"]
requires: []
provides:
  - Session + SessionManager classes
  - SessionEntry + SessionMetadata types
  - Timeout layering in AgentRunner
affects: ["packages/agent-core"]
tech-stack:
  added: ["@types/node for NodeNext module resolution"]
  patterns: ["nanobot Session dataclass/manager port", "nanobot timeout layering"]
key-files:
  created:
    - packages/agent-core/src/session.ts
    - packages/agent-core/src/__tests__/session.test.ts
    - packages/agent-core/src/__tests__/runner-timeout.test.ts
  modified:
    - packages/agent-core/src/types.ts
    - packages/agent-core/src/index.ts
    - packages/agent-core/src/runner.ts
    - packages/agent-core/tsconfig.json
decisions:
  - "Workspace path constructor for SessionManager instead of hardcoded ~/.slide/sessions/ - allows tests to use temp dirs"
  - "LRU cache capped at 100 sessions (matching nanobot in-memory cache pattern)"
  - "Char-based token estimation (~4 chars/token) matching nanobot's estimate_message_tokens granularity"
  - "Timeout uses Promise.race with rejection carrying LLMResponse directly, not thrown exceptions"
duration: "~12 min"
completed: "2026-05-25T22:38:00Z"
---

# Phase 109 Plan 01: Session Management + Timeout Layering

**One-liner:** Port nanobot Session/JSONL persistence to TypeScript and add env-var-configurable timeout layering to AgentRunner that returns structured `errorKind="timeout"` for non-streaming calls.

## Tasks

### Task 1: Port nanobot Session + SessionManager to TypeScript (TDD)

- **Type extensions:** Added `SessionEntry` interface (message-like with timestamp/metadata/tool fields) and `SessionMetadata` interface (flexible metadata with `_last_summary` and `runtime_checkpoint`), both exported from `@slide/agent-core`.
- **Session class** (`session.ts`, 555 lines): `addMessage()`, `getHistory()` with message-count + token-budget slicing, user-turn alignment, orphan tool-result dropping, `clear()`, `retainRecentLegalSuffix()`, `enforceFileCap()`. Token estimation uses simple char-based ~4 chars/token.
- **SessionManager class** (`session.ts`): LRU cache (cap 100), `safeKey()` SHA-256 hash for filesystem-safe filenames, `getOrCreate()`, `_load()`, `_sessionPayload()`, `save()` with tmp+rename atomic write, `flushAll()`, `invalidate()`, `deleteSession()`, `listSessions()`. Sessions stored as JSONL files at `{workspace}/.slide/sessions/`. Corrupt file repair via `_repair()`.
- **Tests** (`session.test.ts`, 240 lines, 19 tests): addMessage timestamps, getHistory limits, user-turn alignment, orphan tool-result dropping, clear/reset, last_consolidated skipping, retainRecentLegalSuffix, enforceFileCap, getOrCreate identity, save/load round-trip, flushAll, invalidate, listSessions, deleteSession, safeKey.

### Task 2: Add timeout layering to AgentRunner (TDD)

- **Type extensions:** Added `timeoutS` and `streamIdleTimeoutS` to `LLMCallOptions`.
- **Runner modification** (`runner.ts`, `requestModel()`): Reads `spec.llmTimeoutS` or `NANOBOT_LLM_TIMEOUT_S` env var (default 300s). Only applies wall-clock timeout for **non-streaming** calls (streaming gets provider-level idle timeout from `NANOBOT_STREAM_IDLE_TIMEOUT_S`). On timeout, returns `LLMResponse` with `finishReason="error"`, `errorKind="timeout"`, content message with elapsed seconds. Passes `streamIdleTimeoutS` through to provider options.
- **Tests** (`runner-timeout.test.ts`, 241 lines, 5 tests): Hanging provider with 100ms timeout returns `error_kind="timeout"`, streaming call with short timeout does NOT timeout (wall-clock skipped), env var fallback, non-exception error, fast provider unaffected.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Missing source files in worktree after git reset**

- **Found during:** Task 1 startup
- **Issue:** Base commit `9d7581b6f9b` did not contain agent-core source files (`types.ts`, `runner.ts`, `tool-registry.ts`, `index.ts`, `tsconfig.json`). These existed only in the main repo working directory.
- **Fix:** Copied files from main repo (`/Users/max/Coding/39-Slide/packages/agent-core/`) into worktree before implementing.
- **Files modified:** N/A (copy operation)
- **Commit:** N/A (files committed with GREEN phase)

**2. [Rule 3 - Blocking] Missing vitest config resolution**

- **Found during:** Task 1 RED phase test execution
- **Issue:** Root `vitest.config.ts` imports shared config (`test/vitest/vitest.shared.config.ts`) which was missing, causing config resolution failure.
- **Fix:** Created local `vitest.config.ts` in `packages/agent-core/` with minimal inline config.
- **Files modified:** `packages/agent-core/vitest.config.ts`
- **Commit:** `811e97f3e5e`

**3. [Rule 3 - Blocking] Missing `@types/node` in tsconfig**

- **Found during:** Task 2 verification (`npx tsc --noEmit`)
- **Issue:** Tests use `process.env`, `node:fs`, `node:crypto` imports not recognized without `@types/node`.
- **Fix:** Added `"types": ["node"]` to `tsconfig.json` compilerOptions.
- **Files modified:** `packages/agent-core/tsconfig.json`
- **Commit:** `d1afb4cb2ac`

**4. [Rule 1 - Bug] Implicit any and unused imports in session.ts**

- **Found during:** TypeScript strict mode compilation
- **Issue:** Filter callback parameter `l` had implicit `any` type; `pathToFileURL` and `ToolCall` imports unused.
- **Fix:** Added explicit type annotation, removed unused imports.
- **Files modified:** `packages/agent-core/src/session.ts`
- **Commit:** `d1afb4cb2ac`

## Verification

```bash
cd packages/agent-core

# TypeScript compilation
npx tsc --noEmit --project tsconfig.json
# Exit code: 0 — clean

# All tests
npx vitest run --config vitest.config.ts
# Test Files: 2 passed
# Tests: 24 passed
```

## Threat Surface Scan

| Flag | File | Description |
|------|------|-------------|
| threat_flag: env_var_read | packages/agent-core/src/runner.ts:396-402 | `NANOBOT_LLM_TIMEOUT_S` and `NANOBOT_STREAM_IDLE_TIMEOUT_S` read from `process.env` at runtime. No write path. |
| threat_flag: filesystem_write | packages/agent-core/src/session.ts | Session JSONL files written via atomic tmp+rename at `{workspace}/.slide/sessions/`. No user-facing write path at this layer. |

Both surfaces are covered by the plan's threat model (T-109-01, T-109-02).

## Self-Check: PASSED

- [x] `packages/agent-core/src/session.ts` exists (555 lines, min 250)
- [x] `packages/agent-core/src/types.ts` contains `SessionEntry`
- [x] `packages/agent-core/src/runner.ts` contains `NANOBOT_LLM_TIMEOUT_S`
- [x] `packages/agent-core/src/__tests__/session.test.ts` exists (240 lines, min 20)
- [x] `packages/agent-core/src/__tests__/runner-timeout.test.ts` exists (241 lines)
- [x] `npx tsc --noEmit --project tsconfig.json` passes
- [x] `npx vitest run` passes (24 tests)
- [x] Types exported: `Session`, `SessionManager`, `SessionEntry`, `SessionMetadata`
