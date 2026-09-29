# Bounded runtime implementation plan

> **Execution:** Follow this plan within existing authorization and repository rules; use executing-plans when useful. Track task dependencies and acceptance evidence. Delegate only when useful and authorized.

**Goal:** MAX-91 / T5: enable explicitly opted-in long chat while retaining finite cumulative budgets and safe settlement.
**Architecture:** Resolve immutable entry policy once, enforce budgets in the shared runtime ledger, retain actual operation promises at API ownership boundaries.
**Tech Stack:** TypeScript, Fastify, Vitest fake timers, pnpm.

## Frozen contract v1
- Base main `2785e97457fd86eaac3cb4b353fcf8d0273f8923`; changes since original `07b3e6ce` are T1–T4 (#95–98), including approved CI dependency fixes. Predecessor linked PRs #96–98 merged with 8 passing checks each; #95 uses the explicit exception.
- Scope: §2.7 policy, core budget/tool deadlines, chat/invoke/subagent/cron adapters, regression tests and migration docs. Exclude T6 deployment/provider/soak/rollout and unrelated refactors.
- Budget: no hard budget; token/cost telemetry unavailable. No delegated agents.
- Stop only for unmet external gates; no enabling LONG_CHAT in deployment in this change.

## 1. Entry policy
Add `apps/db-ops-api/src/adapter/runtime-policy.ts` and tests. Cover legacy defaults; strict LONG_CHAT flag; chat-specific timeout > old timeout > entry default; explicit iterations; invalid/empty/zero/negative config; immutable per-run snapshot. Chat defaults 200/500/600/1M; invoke 120s/8, child 120s/25, cron job deadline/40. Explicit child allowance is bounded by parent remaining allocation.

## 2. Core enforcement
Add runtime budget contracts and helpers, consume provider reservations before every ordinary/summary dispatch, check tool batch before execution. Preserve unknown reservations and count cached tokens only within input. Persist progress and deadlines with optional backward-compatible checkpoint fields. Model/tool/run timeouts must return typed reasons. Observe original operation promises; never checkpoint unconfirmed tools as completed.

## 3. API integration
Replace entry constants with parsed policy in direct-adapter, subagent-manager, cron-executor. Preserve session/actor/cron ownership until original operations settle, including late noncooperative tools. Cancellation prevents further tool starts. Existing approval flow returns a pending decision without awaiting human interaction; do not add a human-wait timer.

## 4. Evidence
Focused commands from MAX-91: core runtime-budget/runtime-settlement; API agent-runtime-limits/runtime-policy/runtime-lifecycle/subagent-manager/cron-security. Fake timer 130 seconds / 45 steps success; independent explicit deadline, idle, wall-clock despite heartbeat, tool timeout, no progress, steps/tools/attempts/tokens/recovery; unknown usage and checkpoint restore; late settlement exclusion. Run affected modules then final repository gates once. Fix related failures and collect 8 CI checks for current PR head before merge.

## 5. Delivery
Document migration in `.env.example` and guard audit, commit focused changes, open MAX-91 PR, verify platform link, collect CI, merge only after gates, attach evidence and update issue.
