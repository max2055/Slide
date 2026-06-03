---
phase: 87
slug: approval-enhancement
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-11
---

# Phase 87 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | apps/db-ops-api/vitest.config.ts |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run --coverage` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run --coverage`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | APPR-01 | TBD | N/A | unit | `npx vitest run` | ⬜ W0 | ⬜ pending |
| TBD | TBD | TBD | APPR-02 | TBD | N/A | unit | `npx vitest run` | ⬜ W0 | ⬜ pending |
| TBD | TBD | TBD | APPR-03 | TBD | N/A | unit | `npx vitest run` | ⬜ W0 | ⬜ pending |
| TBD | TBD | TBD | APPR-04 | TBD | N/A | unit | `npx vitest run` | ⬜ W0 | ⬜ pending |
| TBD | TBD | TBD | APPR-05 | TBD | N/A | unit | `npx vitest run` | ⬜ W0 | ⬜ pending |
| TBD | TBD | TBD | APPR-06 | TBD | N/A | unit | `npx vitest run` | ⬜ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/db-ops-api/tests/` — approval service test stubs
- [ ] `apps/db-ops-api/tests/` — notification service test stubs

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| CodeMirror SQL syntax highlighting | APPR-01 | Visual rendering | Open detail page, verify SQL is color-highlighted |
| Timeline CSS layout | APPR-02 | Visual layout | Open detail page, verify vertical timeline renders correctly |
| Batch checkbox UI | APPR-03 | Visual interaction | Check batch select, toggle, action bar show/hide |
| Auto-execute checkbox UI | APPR-04 | Visual interaction | Verify default checked, toggle behavior |
| Notification channel delivery | APPR-06 | External service | Verify DingTalk/WeCom/Feishu/Webhook message received |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
