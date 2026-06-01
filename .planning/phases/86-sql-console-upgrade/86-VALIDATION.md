---
phase: 86
slug: sql-console-upgrade
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-10
---

# Phase 86 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest + Playwright (E2E smoke) |
| **Config file** | `frontend/vitest.config.ts` — Wave 0 creates |
| **Quick run command** | `cd frontend && npx vitest run --reporter=verbose` |
| **Full suite command** | `cd frontend && npx vitest run && npx playwright test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd frontend && npx vitest run`
- **After every plan wave:** Run `cd frontend && npx vitest run && npx playwright test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | 1 | SQLC-01 | — | N/A | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| TBD | TBD | 1 | SQLC-02 | — | N/A | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| TBD | TBD | 1 | SQLC-03 | — | N/A | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| TBD | TBD | 1 | SQLC-04 | — | N/A | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| TBD | TBD | 1 | SQLC-05 | — | N/A | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| TBD | TBD | 2 | SQLC-06 | — | N/A | unit + integration | `npx vitest run` | ❌ W0 | ⬜ pending |
| TBD | TBD | 2 | SQLC-07 | — | N/A | unit | `npx vitest run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `frontend/vitest.config.ts` — Vitest config for LitElement
- [ ] `frontend/src/openclaw/ui/views/__tests__/sql-console.test.ts` — stubs for all 7 requirements
- [ ] `frontend/package.json` — add `vitest` and `@open-wc/testing` devDependencies

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| CodeMirror autocomplete suggestions visible | SQLC-01 | DOM-inserted autocomplete popup not easily testable | Type table name prefix, verify suggestion list appears |
| EXPLAIN tree expand/collapse interaction | SQLC-07 | Recursive tree component — visual verification | Click EXPLAIN, expand/collapse nodes in tree view |
| Tab persistence across page reload | SQLC-05 | localStorage interaction across reload boundary | Open 3 tabs, reload page, verify tabs restored |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
