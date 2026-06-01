---
phase: 93-ai-agent-ops-assistant
plan: 03
plan_type: execute
subsystem: agent-service
tags: [agent, ops-tools, intent-classification, system-prompt]
requires: [93-01, 93-02]
provides: [list_active_alerts, get_instance_summary, classifyIntent, AGENT_GREETING, OPS_SYSTEM_PROMPTS]
affects: [agent-service.ts, tool-registration]
key_files:
  created:
    - apps/db-ops-api/src/tools/ops/list_active_alerts.ts (90 lines)
    - apps/db-ops-api/src/tools/ops/get_instance_summary.ts (94 lines)
  modified:
    - apps/db-ops-api/src/agent-service.ts (662 -> 750 lines)
decisions:
  - "D-04: Greeting via exported string, not pre-loaded data fetch"
  - "D-05: Tool failures reported directly in message content, no graceful degradation"
  - "D-08: RBAC deferred, tools query as server service account"
  - "D-09: Thin intent classification layer before existing chat flow"
metrics:
  duration: ~10 min
  completed_date: 2026-05-15
  commits: 3
---

# Phase 93 Plan 03: Ops-Aware Context Tools and Intent Classification Summary

**One-liner:** Added two on-demand ops query tools (list_active_alerts, get_instance_summary) registered in toolCatalog, plus an LLM-based intent classification layer in agent-service.ts that routes user messages to specialized ops system prompts with dynamic tool descriptions.

## What Was Built

### Task 1: list_active_alerts tool
- New file at `tools/ops/list_active_alerts.ts`
- Queries `alertDatabaseService.getAlerts()` with optional severity, since (ISO date), and limit filters
- Returns summary data: `{ total, alerts: [{ id, level, title, instance_id, instance_name, created_at, status }] }`
- Registered in toolCatalog with group `db_ops`
- RBAC deferred per D-08

### Task 2: get_instance_summary tool
- New file at `tools/ops/get_instance_summary.ts`
- Queries single instance by instance_id or all instances
- Returns instance health summary with health_score, health_status from database_instances table
- Registered in toolCatalog with group `db_ops`
- RBAC deferred per D-08

### Task 3: agent-service.ts enhancements
- Added `ChatIntent` type: `'alert_rca' | 'topsql' | 'ops_general' | 'general'`
- Added `OPS_SYSTEM_PROMPTS` map with 4 Chinese-language system prompts, each specialized for a different ops intent
- Added `classifyIntent()` function: lightweight LLM call to classify user messages; safe fallback to `'general'` on error or unrecognized response (T-93-06 mitigation)
- Added `AGENT_GREETING` string and `getAgentGreeting()` function listing agent capabilities
- Modified `analyzeMessageWithLLM` to classify intent at start, then dynamically construct system prompts with:
  - Intent-specific ops focus text
  - Tool descriptions from `toolCatalog.getAll()` filtered by group `db_ops`
  - Standard base tool descriptions
- Confirmed D-05: tool failures are already reported directly via `工具执行失败：{error}`

## Deviations from Plan

**None** - The plan was executed exactly as specified. No architectural changes, no bugs found, and no blocking issues encountered.

## Design Decisions Applied

| Decision | Implementation |
|----------|---------------|
| D-01 | No pre-loaded context - tools are on-demand only |
| D-03 | Lightweight queries - no heavy metrics table scans |
| D-04 | Greeting is exported string, not data fetch |
| D-05 | Tool failures reported to user directly (confirmed existing behavior) |
| D-08 | RBAC deferred via TODO comments in both tool files |
| D-09 | Thin intent classification layer before existing chat flow |

## Threat Surface

Per plan threat model:
- T-93-06 (Spoofing - intent classifier): Mitigated. `classifyIntent()` defaults to `'general'` on any unrecognized LLM response or error. The general prompt provides all ops tools - no data leakage risk.
- T-93-07 (Info Disclosure - ops tools): Accepted. Tools query as server service account, matching existing db_* tool behavior. RBAC deferred.
- T-93-08 (Tampering - system prompts): Accepted. All prompts are hardcoded constants in source code.

## Self-Check: PASSED

All 3 created/modified files confirmed present with expected content. All 3 commits verified in git history. All must_haves confirmed (code patterns, min lines, key links).

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 96e823bf716 | feat(93-03): create list_active_alerts tool for querying active alerts |
| 2 | 18f7d53c940 | feat(93-03): create get_instance_summary tool for instance health summary |
| 3 | c344b442b65 | feat(93-03): enhance agent-service with intent classification and ops prompts |
