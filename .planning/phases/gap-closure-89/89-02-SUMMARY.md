---
phase: 89-gap-closure
plan: 02
type: execute
subsystem: ai-analysis
tags:
  - timeout
  - fault-diagnosis
  - gap-closure
requires: []
provides: [checkAndFailStuckAnalyses timeout mechanism]
affects: [ai-analysis-database-service]
tech-stack:
  added: []
  patterns:
    - "async method: checkAndFailStuckAnalyses → pool.query → failAnalysis per record"
key-files:
  created: []
  modified:
    - apps/db-ops-api/src/ai-analysis-database-service.ts
key-decisions:
  - D-01: "checkAndFailStuckAnalyses uses pool.query() (not execute) for SELECT with no parameterized input, per plan spec"
  - D-02: "Existing dispatchOrReuse().catch() handler in fault-diagnosis-service.ts remains unchanged — covers dispatch errors, this method covers the remaining gap (Agent hangs after dispatch succeeds)"
requirements-completed: []
duration: "~1 min"
completed: "2026-05-13T01:41:58Z"
---

# Phase 89 Plan 02: Diagnosis Timeout Auto-Fail Summary

Add `checkAndFailStuckAnalyses()` method to auto-fail AI analyses stuck in 'running' status for more than 10 minutes, preventing indefinite frontend polling.

## Key Changes

**Modified files:**
- `apps/db-ops-api/src/ai-analysis-database-service.ts` (+32 lines)

### ai-analysis-database-service.ts

Added `checkAndFailStuckAnalyses()` method after `failAnalysis()` (line 211):

```typescript
async checkAndFailStuckAnalyses(): Promise<{ failed_count: number }>
```

**Behavior:**
1. Queries `ai_analysis` for records where `status = 'running'` AND `started_at` is NOT NULL AND `started_at < NOW() - INTERVAL 10 MINUTE`
2. Uses `pool.query()` for the SELECT query
3. For each stuck record, calls `this.failAnalysis()` with timeout message '诊断超时：Agent 在 10 分钟内未完成'
4. Returns `{ failed_count: number }` with the count of records that were failed
5. Safe to call repeatedly (idempotent) — already-failed records won't match the query
6. Handles null pool, empty results, and query errors gracefully (returns `{ failed_count: 0 }`)

**Key links validated:**
- `checkAndFailStuckAnalyses()` → `ai_analysis` table: `UPDATE status='failed' WHERE status='running' AND started_at < NOW() - INTERVAL 10 MINUTE` (via failAnalysis calls)
- `faultDiagnosisService.diagnoseInstance()` → `dispatchOrReuse().catch()` handler: existing `.catch` on line 90 of `fault-diagnosis-service.ts` already calls `failAnalysis()` on dispatch errors (no changes needed)

## Gap Analysis

This plan closes the remaining gap in the diagnosis timeout story:

| Scenario | Handler | Status |
|----------|---------|--------|
| `dispatchOrReuse()` fails (chat.send error) | `.catch()` handler in `fault-diagnosis-service.ts` line ~90 | Already handled |
| `dispatchOrReuse()` succeeds but Agent hangs | `checkAndFailStuckAnalyses()` (new) | Added in this plan |

## Verification Results

1. grep checkAndFailStuckAnalyses: found at line 212 (PASS)
2. Method queries status='running' AND started_at < NOW() - INTERVAL 10 MINUTE: confirmed in query at line 220 (PASS)
3. Method calls failAnalysis for each stuck record with timeout message: confirmed at line 229 (PASS)

## Deviations from Plan

None - plan executed exactly as written.

## Auth Gates

None encountered.

## Known Stubs

None - the method is self-contained with no external dependencies on unimplemented features.

## Threat Flags

None - the new method runs bounded queries against indexed columns (status, started_at) per threat model acceptance (T-89-02).

## Self-Check: PASSED

- Created file check: `apps/db-ops-api/src/ai-analysis-database-service.ts` exists (no new files)
- Modified file check: `apps/db-ops-api/src/ai-analysis-database-service.ts` verified containing new method
- Commit check: `feat(89-gap-closure-02): add checkAndFailStuckAnalyses() timeout method` exists in git log
