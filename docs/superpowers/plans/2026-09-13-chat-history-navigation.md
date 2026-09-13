# Chat History Navigation Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules; track acceptance evidence. No delegation needed.

**Goal:** Add turn-based tick navigation, hover previews and accurate jumps across the complete current conversation.

**Architecture:** A Shadow DOM navigator alongside the existing light DOM transcript observes scroll and anchors. The view builds cached turn summaries and renders bounded history segments. Cursor pagination extends the existing actor-scoped REST history path without changing legacy callers.

**Tech Stack:** Lit 3, TypeScript, Fastify, MySQL, Vitest, Playwright.

### 1. Complete history data
- Add optional paged reads to `apps/db-ops-api/src/chat-database-service.ts` and `chat-routes.ts`, ordered by monotonic database ID, exclusive older-than cursor, actor predicate in each query, bounded page size.
- Forward pagination in `frontend/src/app/ui/direct-gateway.ts`; in `controllers/chat.ts`, retrieve pages newest-to-oldest and concatenate chronologically, reject repeated/non-decreasing cursors and stale session results.
- Test invalid cursor, unauthorized session, page ordering, >200 messages and session changes during load.

### 2. Navigation UI
- Add `frontend/src/app/ui/chat/history-navigation.ts` for cached turn summaries; ignore tool/reasoning text and preserve one node per user message.
- Add `frontend/src/app/ui/components/chat-history-nav.ts` for scrollable equal ticks, distance-based expansion, bounded app-card preview, keyboard interaction, current-position tracking, jump highlighting and observer cleanup.
- Integrate in `frontend/src/app/ui/views/chat.ts`: stable anchors, bounded history segments, previous/next and latest actions, reset on session switch. Add layout styles in `frontend/src/app/styles/chat/layout.css`.
- Ensure scheduled auto-scroll respects explicit navigation in `frontend/src/app/ui/app-scroll.ts`.

### 3. Verification and delivery
- Focused Vitest: history helpers/controller/gateway, route and persistence actor tests.
- Browser fixture renders the actual chat view and theme, covering default/expanded tick geometry, preview, unloaded render segment, newest output, session switching, narrow/dark layouts and keyboard navigation.
- Run frontend tests/typecheck/build, backend tests/typecheck and lint once at final integration; classify unrelated baseline failures without widening scope.
- Commit only branch changes, push `codex/chat-history-navigation`, create PR against main with actual checks and limitations.

## Delivery evidence

- Base: `origin/main` at `1d011e3`; isolated branch `codex/chat-history-navigation`.
- Complete frontend suite: 68 files / 393 tests passed. Complete backend suite: 238 files / 1,996 tests passed.
- Frontend and backend TypeScript checks passed; production frontend build and CSP check passed; generated API contracts check passed; lint has no errors (existing repository warnings remain).
- Chromium acceptance covers 260 turns, equal/default and progressive/hover geometry, preview without transcript scrolling, old-segment rendering/highlight, streaming isolation, active-position tracking, session-switch races, empty sessions, narrow dark mode, keyboard operation, newly sent questions, and production app-shell callback wiring.
- Browser fixtures use the actual view and application shell with synthetic messages and transport lifecycle disabled. Live database/LLM integration was not exercised; pagination is covered through injected REST routes, actor-scoped persistence queries, gateway and controller tests.
- Browser reproduction: start `pnpm --filter slide-frontend exec vite --host 127.0.0.1 --port 5187 --strictPort`, then `PLAYWRIGHT_BASE_URL=http://127.0.0.1:5187 pnpm --filter slide-frontend exec playwright test e2e/chat-history-navigation.spec.ts --workers=1`.
- Implementation choice: retrieve history in sequential 200-message pages before displaying its complete index; render roughly 200 messages at a time, extended to a complete turn. Very large sessions therefore require more initial fetches; a single unusually large turn can exceed the render target.
- Integration fixes directly required by acceptance: clear historical selection when the existing send/scroll reset runs; include unanswered newest messages at segment boundaries; connect shell scroll callbacks and make the latest-message indicator reactive.
- Scope remains the approved conversation navigator. Stop condition: commit and open the PR with check results; do not merge or deploy.
- Hard resource budget: not set. Raw/cached input, output tokens and measured cost: unavailable. Subagents: 0; maximum agent depth: 0; execution concurrency: one agent.
