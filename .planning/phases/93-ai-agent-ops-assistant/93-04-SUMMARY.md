---
phase: 93-ai-agent-ops-assistant
plan: 04
subsystem: frontend
tags:
  - back-links
  - chat
  - navigation
  - heartbeat-token
  - notification
  - config-guards
requires:
  - chat.ts rendering infrastructure
provides:
  - Back-link navigation in chat analysis results
  - Heartbeat token stripping from chat stream
affects:
  - frontend/src/openclaw/ui/views/chat.ts
tech-stack:
  added:
    - slide-navigate CustomEvent pattern (reused from alerts.ts)
  patterns:
    - Post-render link injection via helper function
    - Whitespace-only heartbeat detection regex
key-files:
  created: []
  modified:
    - frontend/src/openclaw/ui/views/chat.ts
decisions:
  - "renderBackLinks placed as module-level function for clarity"
  - "CSS added inline via <style> block scoped to .card.chat"
  - "Heartbeat filtering uses regex matching zero-width Unicode spaces"
  - "Back-link buttons dispatch pre-constructed tab names (instance-detail, alerts) per threat model T-93-09"
metrics:
  duration: ~5 min
  completed: "2026-05-15"
---

# Phase 93 Plan 04: Back-link Navigation + Heartbeat Token Stripping + Loose Ends Summary

Add clickable back-links in chat analysis results that navigate to instance-detail or alerts pages via `slide-navigate` CustomEvent. Strip heartbeat tokens from chat stream rendering. Verify notification service disabled state and auto-analysis config guards.

## Tasks Executed

### Task 1: Add back-link rendering in chat.ts for analysis results
- Added `renderBackLinks(group: MessageGroup)` helper function that scans assistant message content for instance IDs (`实例[#:：]?\s*(\d+)`) and alert IDs (`告警[#:：]?\s*(\d+)`)
- Renders clickable `.chat-link-btn` buttons that dispatch `slide-navigate` CustomEvent on click:
  - Instance ID → `{ tab: "instance-detail", id }`
  - Alert ID → `{ tab: "alerts" }`
- Integrated into the repeat rendering loop in `renderChat()` by wrapping `renderMessageGroup()` with `renderBackLinks()` output
- Added scoped CSS via inline `<style>` block: `.chat-link-row` (flex container) and `.chat-link-btn` (accent text, no background, pointer cursor)

### Task 2: Strip heartbeat tokens + verify notification + config guards

**Item A — Heartbeat Token Stripping:**
- Added `isHeartbeatAckText(text)` helper that returns `true` for whitespace-only strings (including zero-width Unicode spaces: U+200B-U+200D, U+FEFF, U+2060, U+00A0)
- Integrated into the stream rendering path: if `isHeartbeatAckText(item.text)` returns `true`, the stream item renders as `nothing` (skipped)

**Item B — Notification Service Disabled State (verification only):**
- Confirmed: `notificationService.start()` is commented out at `server.ts:3056`
- No other `.start()` calls on `notificationService` found — all other references are `.send()`, `.buildMessage()`, `.buildApprovalMessage()`, or `.sendWithRetry()`
- Status: VERIFIED — notification service start disabled as intended

**Item C — Auto-Analysis Config Guards (verification only):**
- server.ts TopSQL analysis cron: reads `aiAnalysisConfigService.getConfig()` at line 1898
- server.ts alert RCA cron: reads config at line 3127, checks `enabled` at line 3128, checks `severityLevels`/`instanceWhitelist`/`timeWindow` at lines 3134-3142
- server.ts fault diagnosis cron: reads config at line 3070, checks `enabled` at line 3071
- event-aggregator.ts: reads config at line 103, checks `enabled` at line 104
- Status: VERIFIED — all three cron paths plus event aggregator check config guards

## Commit

```
fd55c5c18c5 feat(93-04): add back-link navigation and heartbeat token stripping in chat
```

## Deviations from Plan

None — plan executed exactly as written.

## Verification Results

| Check | Status |
|-------|--------|
| `grep -c 'slide-navigate' chat.ts >= 2` | PASS (3) |
| `grep -c 'chat-link-btn' chat.ts >= 1` | PASS (3) |
| `grep -c 'isHeartbeatAckText' chat.ts >= 1` | PASS (2) |
| TypeScript compilation — no new errors | PASS |
| Notification service disabled | VERIFIED |
| Config guards active (3 cron + aggregator) | VERIFIED |

## Threat Flags

None — security mitigations per threat model T-93-09 (CustomEvent uses pre-constructed tab names only) and T-93-10 (heartbeat tokens filtered by whitespace-only regex) are both implemented.

## Self-Check: PASSED

All three grep checks pass. No TS errors from chat.ts changes. Verification-only tasks confirmed.
