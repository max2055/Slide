---
phase: 128-ai-server-analysis
plan: 01
subsystem: api
tags: agent-tools, server-management, ssh-metrics, health-analysis

requires:
  - phase: 125-ssh-metrics
    provides: server_metrics table, server-collector, server-metric-provider
provides:
  - 4 Agent tools for querying server data in conversations
  - Tool registration pattern for server-related tools
affects: agent-db-alert, ai-feature-polish

tech-stack:
  added: none
  patterns: AnyAgentTool tool definition with database queries via server_metrics KV table

key-files:
  created:
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/server-tools.ts
  modified:
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/index.ts

key-decisions:
  - "get_server_alerts returns system-wide alerts since alerts table uses instance_id, not server_id — current schema has no direct relationship between servers and alerts"

patterns-established:
  - "Server tools use direct SQL queries to server_metrics KV table for latest metrics and history"

requirements-completed:
  - AI-01
  - AI-02
  - AI-03
  - AI-04

duration: 9min
completed: 2026-07-07
status: complete
---

# Phase 128: AI Server Analysis — Plan 01 Summary

**Agent tools for server data: list_server_instances, get_server_metrics, get_server_alerts, analyze_server_health — registered in toolCatalog and exported from slide-self-mgmt index**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-07T16:42:00Z
- **Completed:** 2026-07-07T16:51:00Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Created `server-tools.ts` with 4 AnyAgentTool definitions for AI Agent server data queries
- Tool `list_server_instances`: Lists all managed servers with latest CPU/memory/disk metrics summary using batch-optimized SQL queries against `server_metrics` KV table
- Tool `get_server_metrics`: Returns latest metrics and historical time series with range filters (1h, 6h, 24h, 7d, 30d) and optional metric name filter
- Tool `get_server_alerts`: Queries system alerts with server context information, supports activeOnly and limit parameters
- Tool `analyze_server_health`: Generates structured health diagnosis with per-metric analysis (CPU, memory, disk), overall health status, and actionable recommendations
- Updated `index.ts` to export all 4 tools and include them in the `slideSelfMgmtTools` registration array
- Each tool registers into the global `toolCatalog` via module-side effect (`toolCatalog.register()`), following the existing pattern used by all other tools in the module

## Task Commits

1. **Task 1: Create server-tools.ts with Agent tools** - `81d0acd` (feat)

## Files Created/Modified

- `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server-tools.ts` - Created with 4 Agent tools (list_server_instances, get_server_metrics, get_server_alerts, analyze_server_health)
- `apps/db-ops-api/src/tools/generated/slide-self-mgmt/index.ts` - Updated with exports, imports, and slideSelfMgmtTools array entries for all 4 tools

## Decisions Made

- **get_server_alerts implementation**: The alerts table uses `instance_id` (database instance FK), not `server_id`. Since there is no direct relationship between servers and alerts in the current schema, the tool returns system-wide alerts with server context metadata. This provides useful data for agents while documenting the schema limitation.
- **Health analysis thresholds**: CPU/memory thresholds at 70% (warning) / 85% (critical), disk at 80% (warning) / 90% (critical) — standard server monitoring thresholds.
- **Parameter naming**: Used camelCase (`serverId`, `metricName`, `activeOnly`) following JSON Schema conventions, matching existing tools.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The plan references `apps/db-ops-api/src/tool-registry.ts` in `files_modified`, but this file does not exist in the codebase. The actual registration uses module-side `toolCatalog.register()` calls in each tool file, triggered by `import` in `get-agent-engine.ts`. Implementation follows the existing pattern correctly.

## Next Phase Readiness

- All 4 Agent tools are created and registered
- Tools are ready for agent conversations about server status
- Alert integration with server_id requires schema changes if deeper alert-server correlation is needed

---
*Phase: 128-ai-server-analysis*
*Completed: 2026-07-07*

## Self-Check: PASSED

- [x] server-tools.ts exists with all 4 tools
- [x] All 4 tool names present in server-tools.ts
- [x] 4 toolCatalog.register() calls
- [x] index.ts exports all 4 tools
- [x] index.ts includes all 4 tools in slideSelfMgmtTools array
- [x] SUMMARY.md created
- [x] Task commit `81d0acd` verified
