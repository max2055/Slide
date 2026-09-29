# MAX-90 Context Governance Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules. No delegation.

**Goal:** Enforce bounded provider projections without losing raw history or resetting recovery accounting.

**Architecture:** Implement approved runtime-v2 §2.6. ContextManager owns atomic tool groups and conservative estimation; AutoCompact validates and persists source-bound summaries before use; RapidRefill tracks cumulative attempts and consecutive refill. TurnLoop keeps original messages and uses projections only at provider boundaries.

**Tech Stack:** TypeScript, existing provider abstraction and ModelStep, Vitest.

## Scope and evidence

Base and latest main: 371d2c28b677cf29ab029e72d5f0683222793cfd. Since original 07b3e6c, T1/T2/T3 introduce runtime extraction, completion supervisor, recovery/settlement. Reuse these interfaces. No T5 policy rollout or T6 production qualification. Hard budget unset; actual token/cost telemetry unavailable; zero subagents. Stop on approval/external blockers, never bypass merge gates.

1. Add runtime-context.test.ts and runtime-compact.test.ts: Chinese, huge schemas/results, images, broken pairs, immutability, schema/persistence/cancellation/source failure, refill and resume counters. Run focused files and record initial failure.
2. Move legacy context helpers into context-manager.ts. Normalize contiguous atomic tool batches, account UTF-8 bytes conservatively plus framing and images; optional provider tokenizer remains authoritative. Reserve output + safety and schemas. Reject impossible protected context. Never dispatch fallback after governance errors.
3. Add rapid-refill.ts: first compact zero streak, fewer than three completed batches increments, third refill fails, normal intervals reset only streak; attempts bounded by four and shared recovery budget.
4. Add auto-compact.ts: same model, tools empty, bounded streaming request (wall/idle), six required summary fields. Bind schema v1 to source range/hash; verify source before and after awaited durable checkpoint callback. Only then publish projection. Pins remain independently rebuilt from authoritative state. No persistence callback means no summary commit.
5. Integrate TurnLoop, checkpoint validation and optional context configuration/types. Count every summary request/reservation/usage, enforce final budget after continuation/reminders/hooks, support one reactive compact for provider overflow per model step, retain source history and completed tool results without reexecution.
6. Run focused context/checkpoint suite, agent-core test/typecheck, then final repository gates once. Fix only relevant regressions. Commit, PR with MAX-90 title, collect CI, verify association and required review/checks before merge. Deliver evidence and limitations.
