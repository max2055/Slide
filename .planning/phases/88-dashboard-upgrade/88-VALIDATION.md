---
phase: 88
slug: dashboard-upgrade
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-11
---

# Phase 88 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (backend) + Playwright (E2E) |
| **Config file** | `apps/db-ops-api/vitest.config.ts` |
| **Quick run command** | `cd apps/db-ops-api && npx vitest run --reporter=verbose` |
| **Full suite command** | `cd apps/db-ops-api && npx vitest run && cd frontend && npx playwright test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/db-ops-api && npx vitest run --reporter=verbose`
- **After every plan wave:** Run full suite
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 88-01-01 | 01 | 1 | DASH-01 | — | N/A | unit | `cd apps/db-ops-api && npx vitest run` | ❌ W0 | ⬜ pending |
| 88-01-02 | 01 | 1 | DASH-02 | — | N/A | unit | `cd apps/db-ops-api && npx vitest run` | ❌ W0 | ⬜ pending |
| 88-02-01 | 02 | 1 | DASH-03 | — | N/A | unit | `cd apps/db-ops-api && npx vitest run` | ❌ W0 | ⬜ pending |
| 88-02-02 | 02 | 1 | DASH-04 | — | N/A | unit | `cd apps/db-ops-api && npx vitest run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/db-ops-api/tests/dashboard.test.ts` — stubs for new dashboard API endpoints
- [ ] Existing test infrastructure covers all phase requirements

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| ECharts render correctness | DASH-01, DASH-02 | Visual — charts require human eye verification | Open dashboard, verify pie chart shows DB types, line chart shows trend |
| Responsive layout | DASH-04 | Visual — breakpoints need human verification | Resize browser to 1200px/768px/480px breakpoints |
| Card click navigation | DASH-01, DASH-03 | Navigation — requires DOM interaction verification | Click pie slice → verify filter on instances-db; click health card → verify filter |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
