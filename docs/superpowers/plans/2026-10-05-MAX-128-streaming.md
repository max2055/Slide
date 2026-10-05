# MAX-128 Streaming Rendering Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules. No child agents; parent MAX-124 owns merge.

**Goal:** Incremental safe Markdown, real runtime feedback and uninterrupted reading, with browser measurements.

**Architecture:** Keep Lit, markdown-it, DOMPurify and the existing Parts reducer. Cache stable top-level Markdown blocks, reparse the trailing two blocks and invalidate reference-dependent blocks when definitions change. Runtime boundaries produce phase events; the view only presents actual state.

**Tech Stack:** TypeScript, Lit, markdown-it, DOMPurify, Vitest, Playwright Chromium.

## Contract

Base: c0af889557cb47205b620d43a47c781148fca5ed (S3 merged and accepted). Scope/exclusions and acceptance are MAX-128 v1/v2, unchanged. Hard budget not set; active actual token/cost telemetry unavailable. Preserve provider, approval, cancellation, settlement and completion transaction behavior. No paid provider or production operations.

## Tasks

1. `frontend/src/app/ui/chat/streaming-markdown.ts` and `markdown.ts`: cache stable parsed blocks and sanitized HTML; retain two trailing top-level blocks so setext/table/list/fence continuations remain reparsable. Reference definitions invalidate affected stable blocks. Use a Lit directive with per-part lifetime and stable block keys; final rendering reuses the same DOM. Add semantic/security/rollback/identity tests against the full parser.
2. `grouped-render.ts`: apply the directive to live and completed body/reasoning; preserve stable message/part keys. Avoid whole-body animation. Tool results remain bounded and rendered only on expansion.
3. `message-projection.ts`, `runtime/model-step.ts`, API adapter: add waiting-model phase at request entry, generating at actual provider output, tool phase at real tool lifecycle, approval from real pending approval evidence. Preserve saving before durable terminal and retry reset. Add focused phase boundary tests.
4. `direct-gateway.ts`, `app.ts`, `app-render.ts`, `views/chat.ts`, `app-chat.ts`: reactive actual phase and cancellation-request state; reset/terminal remain immediate with timer-backed text batching. Distinguish connection recovery, approval and model waiting; hide reasoning unless policy/user setting permits it.
5. `app-scroll.ts`: upward reading suspends follow even near bottom; explicit latest action resumes it; no recovery force scroll. Verify browser selection, expansion and reading position at completion/recovery, background reset/terminal, cancellation and narrow screen.
6. `frontend/e2e/streaming-render.spec.ts`: fixed 20k/40k/100k multilingual Markdown/SQL/fence/table/list/reference fixtures, 100 tools; capture incremental parse/application P95, receipt-to-paint P95, long tasks, browser/hardware/raw samples and trace. Compare old full-render baseline under the same environment; do not subtract server/client clocks.
7. Focused checks during development: Vitest matching changed modules and new browser spec. At module boundary run frontend/API/Core tests and typechecks. Final candidate runs repository gate once; classify any failures and repair only acceptance blockers. Deliver matrix and raw evidence in `docs/slide/runtime-v2/MAX-128-rendering.md`, one linked PR and one final issue comment. Check existing CI wakeup before pushes and current head checks before exit; pending CI is handed off via its continuous rule.
