---
phase: 100
slug: 安全紧急修复
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-20
---

# Phase 100 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | apps/db-ops-api/vitest.config.ts |
| **Quick run command** | `cd apps/db-ops-api && npx vitest run tests/monitor-collector.test.ts --reporter=verbose` |
| **Full suite command** | `cd apps/db-ops-api && npx vitest run --reporter=verbose` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/db-ops-api && npx vitest run tests/monitor-collector.test.ts --reporter=verbose`
- **After every plan wave:** Run `cd apps/db-ops-api && npx vitest run --reporter=verbose`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 100-01-01 | 01 | 1 | SEC-01 | T-100-01 | GET routes return 401 without JWT | manual | `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/alerts` → 401 | N/A | ⬜ pending |
| 100-01-02 | 01 | 1 | SEC-02 | — | eyeOff icon visible on login page | manual | Open login page, verify password toggle icon renders | N/A | ⬜ pending |
| 100-01-03 | 01 | 1 | SEC-03 | — | checkAlerts() removed, tests pass | unit | `cd apps/db-ops-api && npx vitest run tests/monitor-collector.test.ts` | ✅ | ⬜ pending |
| 100-01-04 | 01 | 1 | SEC-04 | — | Health report shows actual score ≠ 100 | manual | Generate health report, verify score is computed | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/monitor-collector.test.ts` — remove unused `alertDatabaseService` mock after checkAlerts removal

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Auth middleware blocks unauthenticated requests | SEC-01 | Integration test requires running server with JWT | `curl` each of 4 routes without token → expect 401; with valid token → expect 200 |
| eyeOff icon renders on login page | SEC-02 | Visual rendering requires browser | Open login page, click password visibility toggle, verify icon appears |
| Health report shows computed score | SEC-04 | Integration test requires live DB connection | Generate health report, verify `health_score` is not always 100 |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
