---
phase: 112
slug: frontend-cleanup-cron
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-27
---

# Phase 112 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (backend + frontend) |
| **Config file** | none — Wave 0 installs if needed |
| **Quick run command** | `cd apps/db-ops-api && npx vitest run` |
| **Full suite command** | `cd apps/db-ops-api && npx vitest run && cd ../../frontend && npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/db-ops-api && npx vitest run`
- **After every plan wave:** Run full suite (backend + frontend)
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 112-01-01 | 01 | 1 | SC-03 | T-112-01 | SQL migration creates 3 tables + seed data + permission codes | unit | `cd apps/db-ops-api && npx vitest run` | ❌ W0 | ⬜ pending |
| 112-01-02 | 01 | 1 | SC-03 | T-112-02 | CronManager reads DB, schedules enabled jobs, skips disabled | integration | manual — verify server log | N/A | ⬜ pending |
| 112-01-03 | 01 | 1 | SC-03, SC-04 | T-112-03 | REST API enforces cron:manage for write, cron:view for read | unit | `cd apps/db-ops-api && npx vitest run` | ❌ W0 | ⬜ pending |
| 112-02-01 | 02 | 2 | SC-01, SC-02 | — | openclaw/ renamed to app/, all imports pass build | build | `cd frontend && npm run build` | N/A | ⬜ pending |
| 112-02-02 | 02 | 2 | SC-01 | — | protocol/ deleted, app-gateway.ts deleted, dead views deleted | build | `cd frontend && npm run build` | N/A | ⬜ pending |
| 112-02-03 | 02 | 2 | SC-01 | — | i18n files cleaned, navigation updated, unused imports removed | build | `cd frontend && npm run build` | N/A | ⬜ pending |
| 112-03-01 | 03 | 3 | SC-05 | T-112-04 | Cron jobs settings page renders table with toggle/trigger/logs | visual | manual — browser verification | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/db-ops-api/tests/cron-jobs.test.ts` — stubs for cron CRUD API
- [ ] `apps/db-ops-api/tests/cron-manager.test.ts` — stubs for CronManager
- [ ] Existing infrastructure covers frontend build verification

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| CronManager starts and schedules jobs on server boot | SC-03 | Requires live DB + running server | Start server, check log for "CronManager: X jobs scheduled" |
| Frontend cron-jobs page renders with 13 seeded jobs | SC-05 | Visual verification | Open browser at /cron-jobs, verify table with 13 rows |
| Manual trigger runs job and shows result | SC-05 | Requires live cron handler | Click "Trigger Now", verify job executes and log updates |
| Cron expression edit with preview | SC-04 | Visual + interactive | Double-click expression, edit, verify next 5 times update |
| Toggle enable/disable persists across page reload | SC-04 | Requires live DB persistence | Toggle switch, reload page, verify state preserved |
| WebSocket path uses DirectAdapter only | SC-02 | Requires grep verification | `grep -r "gateway" frontend/src/app/` should return no matches |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
