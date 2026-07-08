---
phase: 122
slug: cron-script-agent-mode
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-26
---

# Phase 122 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (project standard) |
| **Config file** | `apps/db-ops-api/src/__tests__/` |
| **Quick run command** | `cd apps/db-ops-api && npx vitest run src/__tests__/script-service.test.ts` (new) |
| **Full suite command** | `cd apps/db-ops-api && npx vitest run` |

## Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SCRIPT-01 | Migration creates cron_scripts table + 6 seed scripts | integration | `cd apps/db-ops-api && npx tsx -e "require('./src/script-service').testSeed()"` | No — Wave 0 |
| SCRIPT-02 | cron_jobs table has task_type/script_id/target_instance_id | unit | `cd apps/db-ops-api && npx vitest run src/__tests__/cron-executor.test.ts` (extend) | No — Wave 0 |
| SCRIPT-03 | Script mode execution path returns structured_result | unit | `npx vitest run src/__tests__/cron-manager.test.ts` (new test) | No — Wave 0 |
| SCRIPT-04 | /api/cron/scripts CRUD endpoints | integration | `npx vitest run src/__tests__/cron-scripts-api.test.ts` | No — Wave 0 |
| SCRIPT-05 | Frontend mode selector renders + switches UI | E2E/smoke | Manual browser verification OR `npx vitest run frontend/src/app/ui/views/__tests__/cron-jobs-settings.test.ts` | No — Wave 0 |
| SCRIPT-06 | Existing 6 tasks have task_type='script' after migration | integration | SQL query verification in migration tests | No — Wave 0 |

## Sampling Rate

- **Per task commit:** `cd apps/db-ops-api && npx vitest run --reporter=verbose` (changed files only)
- **Per wave merge:** `cd apps/db-ops-api && npx vitest run`
- **Phase gate:** Full test suite green before `/gsd:verify-work`
