---
phase: 111
plan: 02
subsystem: openclaw-ui
depends_on: []
requirements: [MIG-06]
key-files:
  created: []
  modified:
    - frontend/src/openclaw/ui/controllers/sessions.ts
    - frontend/src/openclaw/ui/controllers/agents.ts
    - frontend/src/openclaw/ui/controllers/chat.ts
    - frontend/src/openclaw/ui/views/sessions.ts
decisions: []
metrics:
  duration: "~5 min"
  completed: "2026-05-26"
---

# Phase 111 Plan 02: Trim controllers + read-only sessions view

**One-liner:** Trim sessions, agents, chat controllers to REST-only exports; convert sessions list to read-only table with no edit/delete/checkpoint UI.

## Tasks

| # | Name | Type | Commit | Files |
|---|------|------|--------|-------|
| 1 | Trim sessions.ts and chat.ts controllers | auto | `5738a9d4174` | sessions.ts, chat.ts |
| 2 | Trim agents.ts controller | auto | `be684020a46` | agents.ts |
| 3 | Update sessions view to read-only | auto | `9248e84e67b` | sessions.ts |

### Task 1: Trim sessions.ts and chat.ts controllers

**sessions.ts:** Kept only `SessionsState` type (without checkpoint/session state fields) and `loadSessions` export. Removed `patchSession`, `deleteSessionsAndRefresh`, `toggleSessionCompactionCheckpoints`, `branchSessionFromCheckpoint`, `restoreSessionFromCheckpoint`, `subscribeSessions`, plus all internal helpers (checkpointSummarySignature, invalidateCheckpointCacheForKey, fetchSessionCompactionCheckpoints, withSessionsLoading, runCompactionMutation). Cleaned unused type imports (SessionCompactionCheckpoint, SessionsCompaction*, scope-errors).

**chat.ts:** Removed only the `abortChatRun` export (lines 372-387). All other functions preserved: sendChatMessage, loadChatHistory, sendDetachedChatMessage, handleChatEvent.

### Task 2: Trim agents.ts controller

Kept only `AgentsState` (without tools/session/model state fields), `AgentsConfigSaveState`, `loadAgents`, and `saveAgentsConfig`. Removed all tools functions: `loadToolsCatalog`, `loadToolsEffective`, `resetToolsEffectiveState`, `buildToolsEffectiveRequestKey`, `refreshVisibleToolsEffectiveForCurrentSession`, plus internal helpers (hasSelectedAgentMismatch, resolveToolsErrorMessage, resolveEffectiveToolsModelKey). Cleaned unused imports: normalizeChatModelOverrideValue, resolvePreferredServerChatModelValue, resolveAgentIdFromSessionKey, all unused type imports (ChatModelOverride, ModelCatalogEntry, SessionsListResult, ToolsCatalogResult, ToolsEffectiveResult), and scope-errors.

### Task 3: Update sessions view to read-only

Removed from SessionsProps: all checkbox/selection props (selectedKeys, onToggleSelect, onSelectPage, onDeselectPage, onDeselectAll), all edit/delete props (onPatch, onDeleteSelected), all checkpoint props (expandedCheckpointKey, checkpointItemsByKey, checkpointLoadingKey, checkpointBusyKey, checkpointErrorByKey, onToggleCheckpointDetails, onBranchFromCheckpoint, onRestoreCheckpoint).

Removed interactive UI: bulk bar with delete button, checkbox column header and per-row checkbox, inline label input, inline thinking/fast/verbose/reasoning select dropdowns, show/hide checkpoints toggle button, expanded checkpoint details section with branch/restore buttons.

Removed unused constants (THINK_LEVELS, BINARY_THINK_LEVELS, VERBOSE_LEVELS, FAST_LEVELS, REASONING_LEVELS) and helper functions (normalizeProviderId, isBinaryThinkingProvider, resolveThinkLevelOptions, withCurrentOption, withCurrentLabeledOption, resolveThinkLevelDisplay, resolveThinkLevelPatchValue, formatCheckpointReason, formatCheckpointDelta).

Kept: filterRows, sortRows, paginateRows, sortHeader, PAGE_SIZES. Column layout reduced to Key (sortable), Kind (sortable), Updated (sortable), Tokens (sortable), Compaction (text-only).

## Deviations from Plan

None -- plan executed exactly as written.

### Deviation: SessionsState checkpoint fields removed

The plan specified keeping SessionsState but removing `SessionCompactionCheckpoint` from imports. Since SessionsState referenced this type in its `sessionsCheckpointItemsByKey` field, those checkpoint-related state fields were also removed -- they are dead state without the functions that populated them. This is consistent with the pattern applied to AgentsState (tools/session fields removed with their consuming functions).

## Known Stubs

None identified.

## Threat Flags

None -- no new security-relevant surface introduced.

## Self-Check

PASSED. All must_have artifact checks pass:
- sessions.ts: `patchSession`, `deleteSessionsAndRefresh`, `compaction` absent; `loadSessions` present
- agents.ts: all tools functions absent; `loadAgents`, `saveAgentsConfig` present
- chat.ts: `abortChatRun` absent; `sendChatMessage`, `loadChatHistory`, `sendDetachedChatMessage`, `handleChatEvent` present
- sessions view: all deleted props/constants/checkpoint UI absent; `renderSessions` present
