---
phase: 93-ai-agent-ops-assistant
plan: 02
subsystem: ui
tags: chat, streaming, session-management, upstream-port
requires:
  - phase: 90-upstream-merge
    provides: OpenClaw upstream reference files (openclaw-reference/)
provides:
  - reconcileChatRunLifecycle centralized lifecycle helper
  - Dual run-id matching in handleChatEvent (sessionKey OR activeRunId)
  - Local "/new" dispatch via onSlashAction (no Gateway round-trip)
  - Deferred session message reload during active chat runs
affects: chat-ui, session-management
tech-stack:
  added: []
  patterns:
    - Centralized chat run lifecycle management via reconcileChatRunLifecycle
    - Dual matching (sessionKey || activeRunId) for Gateway events
    - Deferred loading pattern for session messages during active runs
key-files:
  created:
    - frontend/src/openclaw/ui/chat/run-lifecycle.ts
  modified:
    - frontend/src/openclaw/ui/controllers/chat.ts
    - frontend/src/openclaw/ui/app-chat.ts
    - frontend/src/openclaw/ui/app-gateway.ts
key-decisions:
  - "Port only the four regression-fixing changes from upstream, not cosmetic differences"
  - "Keep existing Slide handleChatEvent extractText logic (no heartbeat detection ported - cosmetic only)"
  - "Do not port sendChatMessage/abortChatRun cleanup - different patterns would risk existing functionality"
  - "Do not port onHello reconcileChatRunLifecycle - Slide onHello already clears orphaned run state"
patterns-established:
  - "reconcileChatRunLifecycle as single entry point for terminal chat state cleanup"
  - "activeRunIdBeforeEvent captured before handleChatEvent for correct run-scoping"
  - "pendingSessionMessageReloadSessionKey defers history reload during active streaming"
requirements-completed: [AI-02]
duration: 15min
completed: 2026-05-15
---

# Phase 93 Plan 02: Upstream Chat State Management Port Summary

**Port four upstream OpenClaw chat state management fixes to eliminate loading animation stalls, new-session flash, and session message race conditions**

## Performance

- **Duration:** 15 min
- **Started:** 2026-05-15T18:47:00Z
- **Completed:** 2026-05-15T18:47:00Z (actual start from planning context)
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Created `chat/run-lifecycle.ts` with `reconcileChatRunLifecycle` centralized helper (221 lines) -- ported from upstream with all type exports, helpers, and session row reconciliation
- Ported `handleChatEvent` in controllers/chat.ts with dual run-id matching -- events match by `sessionKey` OR `activeRunId`, supporting Gateway-created sessions during a chat run (fixes loading animation stall)
- Terminal events (final/aborted/error) now call `reconcileChatRunLifecycle` instead of inline state cleanup, ensuring consistent `chatRunStatus` updates, session row reconciliation, and indicator clearing
- Ported `shouldQueueLocalSlashCommand` and `dispatchSlashCommand` case "new" -- "/new" dispatches via `onSlashAction("new-session")` locally, eliminating Gateway round-trip delay and blank flash
- Ported `activeRunIdBeforeEvent` capture in `handleChatGatewayEvent` -- ensures terminal events from different active runs are properly scoped and skipped
- Ported `handleSessionMessageGatewayEvent` with deferred reload -- `pendingSessionMessageReloadSessionKey` stores session key when a run is active, resolves after terminal event (prevents racing with streaming state)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create chat/run-lifecycle.ts with reconcileChatRunLifecycle** - `95d898b0f16` (feat)
2. **Task 2: Port handleChatEvent with dual run-id matching** - `b9926e4904e` (feat)
3. **Task 3: Port app-chat.ts and app-gateway.ts** - `bbc690a36ec` (feat)

## Files Created/Modified

- `frontend/src/openclaw/ui/chat/run-lifecycle.ts` - **NEW** Centralized reconcileChatRunLifecycle helper with type exports, timer management, session row reconciliation, and tool stream reset
- `frontend/src/openclaw/ui/controllers/chat.ts` - Dual run-id matching (sessionKey || activeRunId) in handleChatEvent, reconcileTerminalRun replaces inline cleanup
- `frontend/src/openclaw/ui/app-chat.ts` - shouldQueueLocalSlashCommand excludes "new"; case "new" dispatches via onSlashAction("new-session") locally
- `frontend/src/openclaw/ui/app-gateway.ts` - activeRunIdBeforeEvent capture, isEventForDifferentActiveRun check, deferred session message reload with pendingSessionMessageReloadSessionKey

## Decisions Made

- Ported only the four regression-causing fixes (dual matching, reconcileChatRunLifecycle, /new local handling, activeRunIdBeforeEvent + deferred reload)
- Deferred cosmetic improvements: heartbeat display, submit guard, stream text sanitization -- not causing visible regressions
- Existing Slide handleChatEvent extractText logic kept as-is (heartbeat detection not ported -- cosmetic only)
- sendChatMessage, abortChatRun, loadChatHistory not modified -- different patterns, risk of breaking existing functionality
- onHello reconcileChatRunLifecycle integration not ported -- Slide onHello already clears orphaned run state adequately

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - all three tasks completed without issues.

## Threat Flags

None - no new network endpoints, auth paths, or trust boundaries introduced. All changes are client-side UI state management covered by plan's existing threat model (T-93-04, T-93-05, both "accept" disposition).

## Next Phase Readiness

- Chat streaming now renders without interruption when Gateway creates a new session mid-run
- "/new" command switches chat session immediately without blank flash
- Terminal events properly clear chat run state and update session rows
- Session message events received during active run are deferred until run completes
- Ready for further AI agent ops assistant work in Phase 93

---
*Phase: 93-ai-agent-ops-assistant Plan 02*
*Completed: 2026-05-15*

## Self-Check: PASSED

- Created file `frontend/src/openclaw/ui/chat/run-lifecycle.ts` (221 lines) -- FOUND
- Created file `.planning/phases/93-ai-agent-ops-assistant/93-02-SUMMARY.md` -- FOUND
- Modified `frontend/src/openclaw/ui/controllers/chat.ts` -- FOUND
- Modified `frontend/src/openclaw/ui/app-chat.ts` -- FOUND
- Modified `frontend/src/openclaw/ui/app-gateway.ts` -- FOUND
- Task 1 commit `95d898b0f16` -- FOUND
- Task 2 commit `b9926e4904e` -- FOUND
- Task 3 commit `bbc690a36ec` -- FOUND
- Summary commit `e7f944151a3` -- FOUND
