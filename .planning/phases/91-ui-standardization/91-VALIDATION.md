---
phase: 91
slug: ui-standardization
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-19
---

# Phase 91 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (jsdom environment) |
| **Config file** | `frontend/vitest.config.ts` |
| **Quick run command** | `cd frontend && npx vitest run src/openclaw/ui/views/__tests__/navigation-cleanup.test.ts` |
| **Full suite command** | `cd frontend && npx vitest run src/openclaw/ui/views/__tests__/navigation-cleanup.test.ts src/openclaw/ui/views/__tests__/design-tokens.test.ts` |
| **Estimated runtime** | ~1 second |

---

## Sampling Rate

- **After every task commit:** Run `cd frontend && npx vitest run src/openclaw/ui/views/__tests__/navigation-cleanup.test.ts src/openclaw/ui/views/__tests__/design-tokens.test.ts`
- **After every plan wave:** Full suite must be green
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 1 second

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 91-01-01 | 01 | 1 | UI-02 | T-91-01 | N/A (source-only changes) | unit | `npx vitest run src/openclaw/ui/views/__tests__/navigation-cleanup.test.ts` | ✅ | ✅ green (32/32) |
| 91-01-02 | 01 | 1 | UI-02 | T-91-01 | N/A | unit | same as above | ✅ | ✅ green |
| 91-01-03 | 01 | 1 | UI-02 | T-91-02 | N/A | unit | same as above | ✅ | ✅ green (files kept intentionally) |
| 91-02-01 | 02 | 2 | UI-01 | T-91-03 | N/A (CSS-only) | unit | `npx vitest run src/openclaw/ui/views/__tests__/design-tokens.test.ts` | ✅ | ✅ green (24/24) |
| 91-02-02 | 02 | 2 | UI-01 | T-91-03 | N/A (CSS-only) | unit | same as above | ✅ | ✅ green (12/13 pages) |
| 91-02-03 | 02 | 2 | UI-01 | T-91-03 | N/A (CSS-only) | unit | same as above | ✅ | ✅ green (approval + sql-console) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `frontend/src/openclaw/ui/views/__tests__/navigation-cleanup.test.ts` — 32 tests for UI-02 (tab removal, dead code, iconForTab)
- [x] `frontend/src/openclaw/ui/views/__tests__/design-tokens.test.ts` — 36 tests for UI-01 (token definitions, theme independence, page migration)
- [x] Vitest + jsdom already configured in frontend/vitest.config.ts

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Dark/light theme switching visual correctness | UI-01 | Visual-only (CSS variable values do not change per theme — verified automated; visual rendering requires browser) | Visit http://localhost:5173, toggle theme, verify no visual glitches on dashboard/approval/sql-console |
| Navigation sidebar renders 12 group tabs | UI-02 | Requires running frontend + visual inspection | Start frontend, verify sidebar shows slide/chat/openclaw/settings groups with correct tabs |
| Removed tabs (config, system) show no 404 on direct URL | UI-02 | Requires running frontend + browser navigation | Navigate to /config and /system — should not render |

---

## Known Issues

| Issue | Severity | Description |
|-------|----------|-------------|
| users-management.ts token reversion | WARNING | Design token migration (commit `0eb70cdde2c`) was unintentionally reverted by commit `6c24f7f38ab` during merge conflict resolution. File has ~20 hardcoded pixel values that should use `var(--text-*)` / `var(--space-*)`. |
| Dead render block in app-render.ts:1608 | INFO | `state.tab === "config" \|\| state.tab === "appearance" \|\| state.tab === "system"` is unreachable — none of these values are in the Tab type union. Harmless but should be cleaned up. |
| Dead render block in app-render.ts:932 | INFO | `state.tab === "config"` guard is unreachable — "config" not in Tab type. Always evaluates true (hides nothing). Harmless. |
| "appearance" in TAB_GROUPS but not in Tab type | INFO | `"appearance"` appears in TAB_GROUPS settings group but is NOT in the Tab type union. The group entry is inert. Pre-existing inconsistency. |

## Scope Change Note

Phase 91 Plan 01 originally specified removal of 6 tabs (sessions, usage, skills, config, appearance, system). Commit `3d6f4483c5e` ("fix(91): restore sessions/usage/skills/appearance tabs") intentionally restored 4 tabs after user feedback. Only `config` and `system` were permanently removed. The PLAN and SUMMARY were not updated to reflect this scope reduction. Tests are written against the **actual 2-tab removal scope**.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: all 6 tasks have automated verification
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 1s
- [ ] `nyquist_compliant: true` — NOT compliant (1 escalated issue: users-management.ts token reversion)

**Approval:** pending (users-management.ts token reversion needs fix, then re-run)
