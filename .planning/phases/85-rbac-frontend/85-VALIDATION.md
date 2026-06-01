---
phase: 85
slug: rbac-frontend
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-10
---

# Phase 85 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Playwright 1.59 |
| **Config file** | `frontend/playwright.config.ts` |
| **Quick run command** | `cd frontend && npx playwright test --grep "rbac"` |
| **Full suite command** | `cd frontend && npx playwright test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** None (visual UI tests not suited for per-commit)
- **After every plan wave:** Manual smoke test via browser
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** Phase gate (manual verification of all 4 sub-tabs)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 85-01-01 | 01 | 1 | RBAC-09 | — | Navigation tab + i18n registered | manual | browser: navigate to /rbac | — | ⬜ pending |
| 85-01-02 | 01 | 1 | RBAC-09 | — | 4 sub-tabs with CRUD working | smoke | `npx playwright test --grep "rbac-roles-crud"` | ❌ W0 | ⬜ pending |
| 85-01-03 | 01 | 1 | RBAC-09 | — | Split-pane user-role + instance modal | smoke | `npx playwright test --grep "rbac-user-roles\|rbac-instance-perms"` | ❌ W0 | ⬜ pending |
| 85-02-01 | 02 | 1 | RBAC-09 | — | Admin check fixed, getUserRole replaced | manual | check users page loads for admin user | — | ⬜ pending |
| 85-02-02 | 02 | 1 | RBAC-09 | T-85-EoP-01 | Multi-role badges + instance perm modal | smoke | `npx playwright test --grep "rbac-users-badges"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `frontend/tests/rbac.spec.ts` — smoke test for roles CRUD
- [ ] `frontend/tests/rbac.spec.ts` — smoke test for permissions CRUD
- [ ] `frontend/tests/rbac.spec.ts` — smoke test for user-role binding
- [ ] `frontend/tests/rbac.spec.ts` — smoke test for instance permissions
- [ ] `frontend/tests/rbac.spec.ts` — smoke test for users page multi-role badges

*Existing Playwright smoke tests at `frontend/smoke/` — follow existing patterns.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Navigation tab appears | RBAC-09 | Visual check | Open sidebar settings, verify "rbac" tab visible |
| 4 sub-tabs switch correctly | RBAC-09 | Visual check | Click each sub-tab, verify correct content |
| Permission checkbox grouping | RBAC-09 | Visual check | Open edit permissions modal, verify grouped by resource |
| Destructive confirmations | RBAC-09 | Requires interaction | Delete role/permission, verify confirm dialog |
| Badge click navigation | RBAC-09 | Multi-step flow | Click role badge on users page, verify RBAC page opens with user selected |

---

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V4 Access Control | No | Backend `requirePermission('admin:*')` enforces RBAC |
| V5 Input Validation | Partial | Permission code format validated on frontend for UX |

### Known Threat Patterns
| Pattern | STRIDE | Mitigation |
|---------|--------|------------|
| Frontend-only access control | Elevation of Privilege | All RBAC endpoints require `admin:*` on backend; frontend show/hide is cosmetic |
| XSS in role/permission names | Tampering | Lit auto-escapes text content; dompurify available in package.json |

---

## Validation Sign-Off

- [ ] All tasks have automated or manual verification
- [ ] Sampling continuity maintained
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
