# Runtime qualification implementation plan

> **Execution:** Follow this plan within existing authorization and repository rules; track dependencies and evidence. No delegation.

**Goal:** Implement T6 / MAX-92 qualification and record honest A1–A8 evidence.

**Architecture:** Reuse AgentRunner, DirectAdapter, real MySQL and existing Playwright managed environment. Add a bounded, body-free runtime event bridge to existing platform logs; durable completion remains AgentRunService's transaction. Qualification results distinguish controlled fixtures from deployed-provider and rollout observations.

**Tech Stack:** TypeScript, Vitest, Playwright, shell, MySQL.

## Contract

Approved source: `docs/slide/runtime-v2-source/2026-09-28-agent-runtime-improvement.md`, T6 and A1–A8. Base main and checkout HEAD: bb95113435b9910ad90ec119288a064b18bd47eb; previous main 07b3e6ce458b0b4576d356a97d78ab17df3ddd66 now includes T1–T5 (#95–#99). No unrelated UI, business tools or infrastructure changes. No hard budget; actual agent token/cost telemetry unavailable; child agents 0, depth 0, concurrency 1. Stop rollout on consistency/security violations; missing provider/rollout evidence blocks production acceptance, not independent implementation.

## Steps

1. Add `tests/qualification/agent-runtime.ts` and `scripts/qualification/run-agent-runtime.sh`: deterministic replay/evaluation/performance; real MySQL WS history and same-message replay; controlled 1800-second progress with >40 steps, cancellation and bounded resources; environment-only provider tests with explicit missing evidence.
2. Add typed bounded runtime events and a platform-log bridge. Test recovery/compact/response-ready correlation, hostile input exclusion, observer failure isolation and durable commit ordering. Preserve public compatibility.
3. Add `frontend/e2e/agent-runtime.spec.ts` using the managed fixture provider and real persisted runs. Exercise rejected candidates, continuation and reconnect without duplicate final answers. Keep cancellation regression.
4. Map A1–A8 commands in qualification coverage and wire deterministic/MySQL/browser CI without removing existing gates.
5. Write `docs/slide/agent-runtime-v2.md`: policy migration, evidence commands, provider manifest, observe 200 turns then enforce 100 sessions/24h then long-chat, thresholds and safe rollback. Never claim synthetic repetitions are deployment observations.
6. Run focused tests during development, affected module tests, then one final full gate per issue. Run real integrations where resources permit. Record exact SHA and failures by cause. PR must remain unmerged if mandatory acceptance is missing; persist an external-condition wakeup when blocked.
