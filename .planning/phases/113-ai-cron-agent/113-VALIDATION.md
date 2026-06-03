---
phase: 113
slug: ai-cron-agent
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-27
---

# Phase 113 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `apps/db-ops-api/package.json` (scripts) |
| **Quick run command** | `npm test -- -t "cron"` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test` in `apps/db-ops-api/`
- **After every plan wave:** Full suite must be green
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

> Populated after planning; filled incrementally during execution.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | ⬜ W0 | ⬜ pending |

---

## Wave 0 Requirements

- [ ] `apps/db-ops-api/tests/cron-executor.test.ts` — unit tests for CronExecutor class (AgentRunner integration, timeout handling, hook event collection)
- [ ] `apps/db-ops-api/tests/cron-migration.test.ts` — schema migration verification (task_description column, seed data integrity)
- [ ] `apps/db-ops-api/tests/cron-api.test.ts` — CRUD API route tests for task builder (create/update/delete/trigger)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| NL task execution quality | Agent produces actionable results | Subjective — requires DBA review | Run a cron task manually, review log output for actionability |
| 13 seed NL descriptions correctness | Seed data matches original handlers | Requires domain knowledge comparison | For each handler, compare NL description output vs original handler output |
| UI task builder UX | Form validation, field interactions | Visual/interaction testing | Create/edit/delete tasks via UI, verify form behavior |

---

*Phase: 113-ai-cron-agent*
*Validation strategy created: 2026-05-27*
