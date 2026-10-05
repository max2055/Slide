# MAX-126 Message Parts Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules; use executing-plans when useful. Track task dependencies and acceptance evidence. Delegate only when useful and authorized.

**Goal:** Live, history and recovery use one ordered projection; reset retracts unconfirmed output atomically and never regresses durable tool facts.

**Architecture:** Reuse MessagePart status/durable and S1 tool contracts. A browser-safe pure reducer owns display state; Adapter attaches additive operations to existing frames, frontend derives its existing render inputs from that state. Existing canonical facts, intent/settlement, anchor and completion transactions retain persistence authority. Storage IDs stay compatible; a persisted document may retain its original streaming message identity explicitly.

**Tech Stack:** TypeScript, Vitest, existing Lit/WS/MySQL boundaries.

Base: `2096fe320528537d16d193d86c70784819cd016a` (S1 PR #129 merged, eight checks SUCCESS). Scope v1/v2 unchanged. No new transport, page redesign, token writes, paid models or production operations. No hard budget; run telemetry unavailable; no subagents. Stop after focused/module checks, final local gate, one linked PR and durable CI wakeup handoff to MAX-124.

### 1. Shared projection and tests

- Create `packages/agent-core/src/message-projection.ts` and `src/__tests__/message-projection.test.ts`.
- Test start/append/replace/end, invalid and duplicate events, thinking before text, no reasoning, interleaved text/tool/text, settled versus persisted, empty and duplicate resets, terminal late frames, snapshot suffix equivalence and fact hydration.
- Run `pnpm --filter agent-core exec vitest run src/__tests__/message-projection.test.ts`; capture missing-export RED before implementation and passing GREEN after.
- Add generation and display-only tool input/lifecycle fields to `src/message-parts.ts`; preserve completed=>durable validation and legacy rollback.
- Add only a pure `./message-projection` export. Never import the Node-dependent core barrel in the browser.

### 2. Adapter/core normalization and persistence

- Extend `src/types.ts`, `src/runtime/model-step.ts`, `src/runtime/turn-loop.ts` with stable source message identity and optional tool-input callback. Provider input fragments display only when a real provider ID is known; no partial JSON execution.
- Add `apps/db-ops-api/src/adapter/message-projection.ts`; enrich existing ChatEvent frames with reducer operations. Preserve legacy cumulative delta and explicit S1 part identity.
- Existing checkpoint callback stores acknowledged projection alongside the established anchor; restore from that checkpoint plus canonical facts. On persistence failure retain old anchor and emit accurate failure.
- `adapter/message-parts.ts` and `agent-run-service.ts` preserve source part IDs/generation when acknowledging parts; terminal completion promotion remains inside the existing transaction.
- Add Adapter table-driven integration regressions; run affected message, checkpoint, stream and completion tests, then typecheck.

### 3. Frontend projection and history

- Create `frontend/src/app/ui/chat/message-projection.ts` to call the shared reducer and derive existing text/thinking/tool render inputs. Native additive operations have one consumer; legacy frames normalize into the same reducer where identity exists, unidentified old history remains readable.
- Update `direct-gateway.ts`, `controllers/chat.ts`, and `chat/message-normalizer.ts` to hydrate and project ordered parts; retain navigation request-version guards, DOMPurify and current rendering components.
- Tests cover native/legacy behavior, empty reset, committed tools, delayed terminal, history switch and live/fact/snapshot equivalence. Run focused frontend checks then typecheck/build.

### 4. Delivery

- Run affected module tests and one final workspace test/typecheck/contracts/build gate; record actual skips/environment limitations.
- Publish `docs/slide/runtime-v2/MAX-126-message-projection.md` with five-item acceptance matrix, commands/environment, source identity compatibility and rollback.
- Before push verify existing continuous CI condition `01a10a15-a5ab-79c5-a948-2e29601c924d` is enabled, unpaused and unexpired.
- Push current branch, create only one MAX-126 PR, verify Multica actual linkage and current head checks. Fix completed relevant failures in this run; pending checks use the existing persistent wakeup. Set in_review and deliver one final issue comment; parent alone merges.
