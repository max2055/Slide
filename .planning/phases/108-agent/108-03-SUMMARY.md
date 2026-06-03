---
phase: 108-agent
plan: 03
type: execute
wave: 3
subsystem: adapter
tags:
  - IAgentEngine
  - feature-flag
  - adapter-selection
  - dual-run
  - zero-openclaw
requires:
  - 108-01
  - 108-02
provides:
  - getAgentEngine() feature flag adapter selection (chat/analysis)
  - chat-handler.ts platform chat handler via IAgentEngine.chat()
  - ai-agent-bridge.ts updated to use IAgentEngine.invoke()
  - server.ts startup via getAgentEngine().start() (no direct OpenClaw imports)
  - dual-run comparison test for adapter tool/capability/error parity
  - zero OpenClaw source imports verified in platform code (src/ excluding adapter/)
affects:
  - apps/db-ops-api/src/adapter/get-agent-engine.ts (MODIFY — feature flag logic)
  - apps/db-ops-api/src/chat-handler.ts (NEW — platform chat RPC handler)
  - apps/db-ops-api/src/ai-agent-bridge.ts (REWRITE — use agent.invoke())
  - apps/db-ops-api/server.ts (MODIFY — startup via engine.start())
  - apps/db-ops-api/src/adapter/__tests__/dual-run.test.ts (NEW — dual-run comparison)
tech-stack:
  added: []
  patterns:
    - Feature-flag gated adapter selection (ENABLE_AGENT_ADAPTER_CHAT / _ANALYSIS)
    - Capability-based adapter selection via getAgentEngine(capability)
    - Eager WS transport start via IAgentEngine.start()
    - Dual-run comparison test harness (AdapterParityTestHarness)
key-files:
  modified:
    - apps/db-ops-api/src/adapter/get-agent-engine.ts (53 -> 172 lines)
    - apps/db-ops-api/server.ts (imports + startup sequence)
    - apps/db-ops-api/src/ai-agent-bridge.ts (sendGatewayChat -> agent.invoke())
    - apps/db-ops-api/src/chat-handler.ts (initial phase 108 version)
  created:
    - apps/db-ops-api/src/adapter/__tests__/dual-run.test.ts (431 lines, 10 tests)
decisions: []
metrics:
  duration: "3 sessions (continuation agent: Task 3)"
  adapter_tests_passing: 42
  dual_run_tests_passing: 10
  files_created: 1
  files_modified: 0 (dual-run test is new-only; tasks 1-2 modifications in prior sessions)
---

# Phase 108 Agent Plan 03: Platform Integration + Feature Flags + Dual-Run

**One-liner:** Platform code (server.ts, chat-handler.ts, ai-agent-bridge.ts) fully decoupled from OpenClaw via IAgentEngine interface, with feature flag adapter selection and dual-run comparison verification.

## Key Results

### Task 1: Feature Flag Adapter Selection (commit 0699068 — prior session)

`getAgentEngine()` factory updated to accept optional `capability` parameter (`'chat' | 'analysis'`). Two feature flags control adapter selection:
- `ENABLE_AGENT_ADAPTER_CHAT` (default: `'true'` -> DirectAdapter)
- `ENABLE_AGENT_ADAPTER_ANALYSIS` (default: `'true'` -> DirectAdapter)

Two singletons are cached (one DirectAdapter, one OpenClawAdapter) so both can coexist in dual-run scenarios. `getAdapterType()` helper returns `'direct' | 'openclaw'` for a given capability.

### Task 2: Platform Code Rewrite (commit de2d5e8e — prior session)

- **server.ts**: imports `getAgentEngine`/`getAdapterType` from adapter path instead of `startGatewayServer`/`getOpenClawRuntime`. Startup sequence calls `getAgentEngine('chat').start()` which eagerly starts the WS transport. OpenClaw-specific config sync is conditionally invoked only when `getAdapterType('chat') === 'openclaw'`.
- **chat-handler.ts**: Created as platform-level chat RPC handler using `getAgentEngine('chat').chat()` with streaming event forwarding to WS client.
- **ai-agent-bridge.ts**: Uses `getAgentEngine('analysis').invoke()` instead of `sendGatewayChat`, removing direct OpenClaw import.

### Task 3: Dual-Run Comparison Test + Zero OpenClaw Import Check (commit 7eb2e631)

Created `dual-run.test.ts` (431 lines, 10 tests) with:

1. **Tool Registration Parity** (3 tests):
   - DirectAdapter and OpenClawAdapter list identical platform tool schemas via `AdapterParityTestHarness.assertToolParity()`
   - Both return empty tool list when no tools registered
   - Tool schemas have correct required fields (name, description, parameters)

2. **Capabilities Parity** (3 tests):
   - DirectAdapter returns valid AgentCapabilities (4 fields, correct types)
   - OpenClawAdapter returns valid AgentCapabilities (4 fields, correct types)
   - Shape is consistent with IAgentEngine interface (TypeScript compile-time check)

3. **Error Shape Parity** (4 tests):
   - DirectAdapter throws Error instances on LLM failure (chat and invoke)
   - OpenClawAdapter throws Error instances on dispatch failure (chat and invoke)
   - Both emit error events via onEvent callback
   - Both re-throw Error instances (not strings/objects)

**Zero OpenClaw Import Verification:**
- `grep` for OpenClaw keywords in platform code (excluding `adapter/`): zero source imports found
- `grep` for direct OpenClaw source imports (`auto-reply`, `gateway/server`, `dispatchInbound`, `reply-dispatcher`): zero results outside `adapter/`
- Platform code's only agent imports: `getAgentEngine`/`getAdapterType` from `adapter/get-agent-engine.ts`

## Verification Results

| Check | Result |
|-------|--------|
| `npx vitest run src/adapter/` (42 tests) | PASSED (42/42) |
| `npx vitest run src/adapter/__tests__/dual-run.test.ts` (10 tests) | PASSED (10/10) |
| Zero OpenClaw imports in platform code (`src/` excluding `adapter/`) | PASSED |
| Zero `dispatchInboundMessage` imports in platform code | PASSED |
| `getAgentEngine()` / `getAdapterType()` are the only adapter imports | PASSED |

## Zero OpenClaw Import Verification

- [x] server.ts — no import of startGatewayServer, getOpenClawRuntime, or any gateway/ path
- [x] src/chat-handler.ts — no import of OpenClaw source
- [x] src/ai-agent-bridge.ts — no import of sendGatewayChat or OpenClaw source
- [x] All other src/*.ts files — no import from OpenClaw source
- [x] adapter/openclaw/ — OpenClaw imports confined here (expected)
- [x] src/agent-service.ts getAgentGreeting — kept per D-31 (expected exception)

## Deviations from Plan

None. Plan executed exactly as written.

## Known Stubs

- `openclaw-adapter.ts` line 175: `listTools()` returns empty array if `start()` has not been called. By design — tools loaded lazily in `start()`.
- `openclaw-adapter.ts` line 115: `invoke()` returns `{ content: null }` for fire-and-forget tasks via `sendGatewayChat`. Intrinsic to OpenClaw fire-and-forget pattern.

## Threat Surface Scan

No new security-relevant surface introduced beyond plan's threat model. Feature flags (`ENABLE_AGENT_ADAPTER_CHAT`, `ENABLE_AGENT_ADAPTER_ANALYSIS`) match T-108-10 disposition (accepted — read at process start, no runtime toggle). Dual-run test matches T-108-13 disposition (mock adapters, no real LLM calls).

## Success Criteria

| Criterion | Status |
|-----------|--------|
| server.ts no longer directly imports OpenClaw | PASS |
| server.ts calls getAgentEngine().start() for WS transport | PASS |
| ai-agent-bridge.ts uses agent.invoke() instead of sendGatewayChat | PASS |
| chat-handler.ts uses getAgentEngine().chat() for streaming | PASS |
| Feature flags ENABLE_AGENT_ADAPTER_CHAT and ENABLE_AGENT_ADAPTER_ANALYSIS control adapter selection | PASS |
| Adapter switch does not affect in-flight sessions (flag read at session creation) | PASS |
| Dual-run comparison test passes — DirectAdapter and OpenClawAdapter tool parity | PASS |
| Zero OpenClaw imports in platform code (src/ excluding adapter/) | PASS |
| All adapter tests pass (42/42) | PASS |

## Self-Check: PASSED

- [x] `apps/db-ops-api/src/adapter/__tests__/dual-run.test.ts` exists (431 lines, 10 tests)
- [x] All 10 dual-run tests pass
- [x] All 42 adapter tests pass (no regressions)
- [x] Zero OpenClaw source imports confirmed in platform code
- [x] Commit exists: 7eb2e631471
- [x] Tasks 1-2 commits confirmed: 0699068, de2d5e8e
