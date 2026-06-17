---
phase: 120-ui
plan: 06
subsystem: chat
tags:
  - god-component-split
  - component-rename
requires: [04, 05]
provides:
  - chat-message-list
  - chat-compose-area
  - chat-tool-result-card
affects: [chat.ts, app-render.ts]
tech-stack:
  added:
    - chat-message-list.ts (LitElement, Light DOM)
    - chat-compose-area.ts (LitElement, Light DOM)
    - chat-tool-result-card.ts (LitElement, Light DOM)
  patterns:
    - Subcomponent with Lit properties + callbacks
    - Parent orchestrator wires WebSocket/session/data
key-files:
  created:
    - frontend/src/app/ui/components/chat-message-list.ts
    - frontend/src/app/ui/components/chat-compose-area.ts
    - frontend/src/app/ui/components/chat-tool-result-card.ts
  modified:
    - frontend/src/app/ui/views/chat.ts
    - frontend/src/app/ui/app-render.ts
    - frontend/src/app/ui/views/metric-registry.ts
    - frontend/src/app/ui/views/metric-templates.ts
    - frontend/src/app/ui/views/approval-dashboard.ts
    - frontend/src/app/ui/views/cron-jobs-settings.ts
    - frontend/src/app/ui/views/event-management.ts
  deleted:
    - frontend/src/app/ui/components/status-badge.ts
metrics:
  chat.ts_lines: "458 (from 2069)"
  chat-message-list_lines: 165
  chat-compose-area_lines: 154
  chat-tool-result-card_lines: 38
  tsc_errors: 0
  commits: 3
---

# Phase 120 Plan 06: Split chat.ts + Badge Rename Summary

Split the 2069-line chat.ts god component into 3 focused subcomponents and completed the status-badge to app-badge rename across 5 views. chat.ts reduced 78% from 2069 to 458 lines as a pure orchestrator handling WebSocket/session/data coordination.

## Key Results

- **chat.ts**: 458 lines (from 2069) — orchestrator only, delegates rendering to subcomponents
- **chat-message-list.ts**: 165 lines — message thread with loading, welcome, streaming, message groups, search
- **chat-compose-area.ts**: 154 lines — textarea with send/stop, slash menu, attachment handling, input history, queue display
- **chat-tool-result-card.ts**: 38 lines — tool result card wrapper using app-card and app-badge
- **app-render.ts**: import status-badge.ts changed to app-badge.ts + 3 new chat subcomponent imports
- **5 views** updated: metric-registry, metric-templates, approval-dashboard, cron-jobs-settings, event-management
- **status-badge.ts**: deleted (zero remaining imports)

## Deviations from Plan

None — plan executed exactly as written. Line counts are well within limits (chat-compose-area at 154 lines, plan limit 200).

## Tasks Completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Extract chat-message-list + chat-compose-area | bd64237 | chat-message-list.ts, chat-compose-area.ts, chat.ts |
| 2 | Extract chat-tool-result-card + update app-render | f5181df | chat-tool-result-card.ts, app-render.ts |
| 3 | Replace `<status-badge>` with `<app-badge>` in views + delete status-badge.ts | 41d2d90 | 5 views updated, status-badge.ts deleted |

## Verification

- [x] chat.ts <= 700 lines (458)
- [x] chat-message-list.ts exists, <=300 lines (165)
- [x] chat-compose-area.ts exists, <=200 lines (154)
- [x] chat-tool-result-card.ts exists, <=150 lines (38)
- [x] chat.ts exports renderChat() unchanged
- [x] app-render.ts imports app-badge.ts, not status-badge.ts
- [x] No `<status-badge>` tag usage remains
- [x] status-badge.ts file deleted
- [x] tsc passes (0 errors)

## Self-Check: PASSED
