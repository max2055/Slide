---
phase: 115
slug: openclaw-todo-ci
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-02
---

# Phase 115 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (backend ^4.1.4, frontend ^3.1.3) |
| **Config file** | `frontend/vitest.config.ts` (backend uses default) |
| **Quick run command** | `cd apps/db-ops-api && npm test` (backend) / `cd frontend && npx vitest run` (frontend) |
| **Full suite command** | `cd apps/db-ops-api && npm test && cd ../../frontend && npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run relevant project's `vitest run`
- **After every plan wave:** Full suite must be green
- **Before `/gsd:verify-work`:** Full suite must be green + `tsc --noEmit` passes
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | D-01 | — | N/A | unit | `npm test` (backend) | ✅ | ⬜ pending |
| TBD | TBD | TBD | D-04 | — | N/A | compile | `npm test` (backend) | ✅ | ⬜ pending |
| TBD | TBD | TBD | D-06 | — | N/A | compile | `npx vitest run` (frontend) | ✅ | ⬜ pending |
| TBD | TBD | TBD | D-09 | — | N/A | compile | `npx vitest run` (frontend) | ✅ | ⬜ pending |
| TBD | TBD | TBD | D-14/D-15/D-16 | — | N/A | CI | `pnpm test` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | D-02 | T-115-01 | RBAC: filter by requestContext.userId, never by client-supplied param | unit | `npm test` (backend) | ⚠️ partial | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `vitest run` currently fails with 88 failures — must be fixed to 0 before CI test step is enabled
- [ ] No `tsc --noEmit` script exists in any package.json — needs to be added for CI typecheck
- [ ] Oxlint not currently installed — CI lint script needs oxlint in devDependencies
- [ ] No `.github/workflows/` directory — must be created

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Canvas document links after `__openclaw` path cleanup | D-12 | URL path removal has unknown runtime impact — requires browser testing | Open canvas document page, verify links are functional |
| Auto-reply type replacement compile check | D-06 | 30+ files need type import fix — full typecheck catch-all | Run `tsc --noEmit` in frontend after all fixes |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
