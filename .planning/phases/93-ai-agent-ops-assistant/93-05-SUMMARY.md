---
phase: 93-ai-agent-ops-assistant
plan: 05
subsystem: api
tags: [data, metrics, slow-queries, agent-tools]

requires:
  - phase: 93-03
    provides: initialized metrics infrastructure
provides:
  - Real slow query retrieval in executeSqlOptimization instead of stub
  - Two-mode tool: list slow queries (no sql param) or analyze specific SQL
affects: []

tech-stack:
  added: []
  patterns:
    - "Agent tool returns real metricsDatabaseService data instead of stub messages"

key-files:
  created: []
  modified:
    - apps/db-ops-api/src/agent-service.ts

key-decisions:
  - "No-sql mode lists slow queries per instance; single-instance auto-selects, multi-instance prompts LLM to choose"
  - "SQL text truncated to 200 chars in list mode to limit info disclosure (threat model T-93-11)"
  - "Limit capped at 50 to prevent excessive data retrieval"

patterns-established: []

requirements-completed: [AI-02]

duration: 5min
completed: 2026-05-15
---

# Phase 93 Plan 05: Slow Query Retrieval for Agent Summary

**Replace db_sql_optimization tool stub with real slow query retrieval from metricsDatabaseService.getSlowQueries, enabling Chat AI to answer questions about recent slow queries**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-15T13:11:00Z
- **Completed:** 2026-05-15T13:16:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- executeSqlOptimization no longer returns stub "SQL优化功能开发中" -- now calls metricsDatabaseService.getSlowQueries
- Tool supports two modes: list slow queries (no sql param) and analyze specific SQL (with sql param)
- Single-instance auto-selects; multi-instance prompts LLM to choose
- SQL text truncated to 200 chars in list mode for info disclosure mitigation (T-93-11)
- Limit param capped at 50 to prevent excessive data retrieval

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement slow query retrieval in agent-service.ts** - `f67f02f68de` (feat)

**Plan metadata:** (committed below)

## Files Created/Modified
- `apps/db-ops-api/src/agent-service.ts` - Four targeted changes: import, tool definition, topsql prompt, executeSqlOptimization implementation

## Decisions Made
- No-sql mode lists slow queries per instance; single-instance auto-selects, multi-instance prompts LLM to choose
- SQL text truncated to 200 chars in list mode to limit info disclosure (threat model T-93-11)
- Limit capped at 50 to prevent excessive data retrieval

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## Threat Flags

None - threat model T-93-11 and T-93-12 were followed as specified (SQL truncation, integer parsing for instance_id/limit).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- SC2 gap closed: Chat AI can now retrieve and explain recent slow queries
- Ready for Plan 06 (agent greeting wiring) to close D-04 gap
- Other stubs (health check, performance analysis, fault diagnosis, capacity analysis) remain for future plans

---

*Phase: 93-ai-agent-ops-assistant*
*Completed: 2026-05-15*
