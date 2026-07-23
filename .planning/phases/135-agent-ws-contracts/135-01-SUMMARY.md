---
phase: 135-agent-ws-contracts
plan: 01
status: complete
commits: [63cbe4d, f74d8b4, 758241a, 8842c3e, dbc8188, 3b8f8ec, 47c7da3, f418c00, a441df4, f09514b, b09890c]
---

# Phase 135 Plan 01 Summary

## Delivered

- WS protocol v2 (`adapter/protocol-v2.ts`): versioned frame validation for run, message, session, attachment, and idempotency fields. Unknown frame types and missing required fields are rejected before reaching AgentRunner.
- Agent run terminal states are a discriminated union: `completed`, `partial`, `failed`, `cancelled`, `timed_out`. Promise resolve no longer equals success; `stopReason: 'error'` and tool errors produce `failed`/`partial` instead of `complete`.
- Cancellation is real: the `chat.abort` WS command validates the actor owns the session, propagates an AbortController signal through AgentRunner and tool execution, and emits a single `cancelled` terminal event per run. Model streaming and in-flight tool calls are interrupted.
- Idempotency keys are persisted per user/session with TTL; reconnecting with the same key replays the terminal event without re-executing the model or tools.
- Agent runner failure states (timeout, max iterations, provider error) are preserved as `failed`/`timed_out` terminal states with checkpoint data for retry.

## Verification

- `analysis/analysis-envelope.test.ts`: all envelope validation tests pass
- `adapter/protocol-v2.ts`: frame validation logic verified by type-level contract
- End-to-end cancellation: WS abort → AgentRunner receives signal → in-flight tool call interrupted → `cancelled` event emitted
- Idempotency: replayed key returns original terminal event, no duplicate LLM/tool execution

## Known Baseline

- Subagent cancellation propagation is deferred (child ActorContext contract not yet defined)
- Old DirectAdapter compatibility shim tests have 3 null-pool failures (Phase 131 baseline)
