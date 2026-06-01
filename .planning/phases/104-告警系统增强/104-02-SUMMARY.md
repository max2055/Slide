---
phase: 104-告警系统增强
plan: 02
subsystem: api
tags: [alert, event-aggregation, mysql, sliding-window]
requires: []
provides:
  - Sliding 10-minute window event aggregation in aggregate()
  - Existing event absorption for related alerts within time threshold
  - No FLOOR bucket boundary split-incidents
affects: [future alert system phases]
tech-stack:
  added: []
  patterns:
    - Application-code time-difference grouping (JS Date arithmetic) instead of SQL FLOOR bucket
    - Two-phase dispatch: absorb into existing event or create new event
key-files:
  modified:
    - apps/db-ops-api/src/event-aggregator.ts
key-decisions:
  - "Used groupIsConnected flag determined at group start to fix plan's sliding-window logic bug"
  - "Application-code grouping avoids SQL time-bucket edge cases entirely"
patterns-established:
  - "Sliding window state tracking: first-alert proximity to existing event determines the whole group's disposition"
requirements-completed: [ALERT-04]
duration: 12min
completed: 2026-05-21
---

# Phase 104: Alert System Enhancement Plan 02 Summary

**Replace FLOOR bucket boundary aggregation with application-code sliding 10-minute window grouping in event-aggregator.ts**

## Performance

- **Duration:** 12 min
- **Started:** 2026-05-21T14:00:00Z (approx)
- **Completed:** 2026-05-21T14:12:00Z (approx)
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Replaced `FLOOR(UNIX_TIMESTAMP/300)*300` bucket boundary with a sliding 10-minute window in application code
- Phase 1: Fetch candidate existing open/investigating events that may absorb new alerts (same instance_id + alert_type + metric_name)
- Phase 2: Fetch unaggregated alerts sorted by (instance_id, alert_type, metric_name, created_at)
- Phase 3: Group consecutive alerts by time-difference <= 10 minutes using application-code state machine
- Phase 4: Two-path dispatch -- absorb alerts into existing event (insert members + log + RCA) or create new event

## Task Commits

Each task was committed atomically:

1. **Task 1: Replace FLOOR bucket with application-code sliding window** - `ed98f3e1602` (fix)

## Files Created/Modified

- `apps/db-ops-api/src/event-aggregator.ts` - Complete rewrite of aggregate() method; added Phase 1-4 logic with 10-minute sliding window, existing event absorption, and corrected groupIsConnected state tracking

## Decisions Made

- **Used groupIsConnected flag determined at group start rather than unconditionally set on every sliding-window match.** The plan's provided code unconditionally set `usedExistingEvent = true` inside the `if (within window)` branch, which would incorrectly link a disconnected group (whose first alert was >10 min from the existing event) to that existing event once a second alert arrived within 10 min of the first. Fixed by computing `groupIsConnected` only when each group starts (first alert), based on its proximity to the candidate event.

- **Used Map.forEach() instead of Map.entries() for-of** to avoid TypeScript `--downlevelIteration` requirement, which is not configured in the project tsconfig.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed groupIsConnected state contamination in sliding-window grouping**
- **Found during:** Task 1 (code review of plan's Step D logic)
- **Issue:** The plan's corrected code unconditionally set `usedExistingEvent = true` inside the `if` branch for every alert within 10 min of the previous. If a group started disconnected from the candidate event (first alert >10 min from existing event's last alert), a subsequent alert within 10 min of the first would incorrectly set `usedExistingEvent = true`, causing the disconnected group to be linked to the existing event.
  - Example: Existing event last alert at T0=10:00. Alerts A1 at 10:14 (>10 min, disconnected), A2 at 10:16 (within 10 min of A1). The plan's code would incorrectly link both to the existing event.
- **Fix:** Changed to track `groupIsConnected` at group start time only. The flag is computed once when the first alert of a group is encountered, based on whether that alert is within 10 min of the candidate event's last alert. Subsequent alerts within the same group do not mutate the flag. After a gap breaks the group, a new group starts with `groupIsConnected = false`.
- **Files modified:** `apps/db-ops-api/src/event-aggregator.ts`
- **Verification:** Group state machine logic reviewed and traced manually; TypeScript compiles cleanly.
- **Committed in:** `ed98f3e1602` (Task 1 commit)

**2. [Rule 3 - Blocking] Replaced Map.entries() for-of with forEach for TS compatibility**
- **Found during:** Task 1 (TypeScript compilation check)
- **Issue:** `Map.entries()` iteration via `for...of` requires `--downlevelIteration` tsconfig flag, which is not enabled in the project. Compilation error at line 102.
- **Fix:** Replaced `for (const [key, alertList] of alertGroups.entries())` with `alertGroups.forEach((alertList, key) => { ... })`.
- **Files modified:** `apps/db-ops-api/src/event-aggregator.ts`
- **Verification:** TypeScript compiles with no new errors.
- **Committed in:** `ed98f3e1602` (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both auto-fixes necessary for correctness. The groupIsConnected fix prevents a logic bug that would incorrectly link new events to old ones. The forEach replacement enables clean compilation. No scope creep.

## Issues Encountered

- Plan's provided application-code grouping had a state contamination bug where `usedExistingEvent` flag was not gated to group-start time. Fixed by computing `groupIsConnected` at group initialization only.
- TypeScript `--downlevelIteration` not configured: Map iteration required forEach pattern instead of `for...of` on `.entries()`.

## Threat Scan

No new security-relevant surface introduced. Existing parameterized queries preserved (T-104-04 mitigate). Existing audit log insert preserved (T-104-05 mitigate). No new endpoints, auth paths, or file access patterns.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Event aggregation now uses correct sliding window logic
- Ready for Plan 03: remaining alert system tasks (threshold editing, alert deduplication admin)

---
*Phase: 104-告警系统增强*
*Completed: 2026-05-21*
