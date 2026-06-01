---
phase: 102
slug: ui
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-21
---

# Phase 102 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (via `frontend/package.json`: `"test": "vitest run"`) |
| **Config file** | none detected — uses Vite config or Vitest defaults |
| **Quick run command** | `cd frontend && npx vitest run --reporter verbose 2>/dev/null | tail -30` |
| **Full suite command** | `cd frontend && npm test 2>/dev/null | tail -30` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd frontend && npx vitest run --reporter verbose 2>/dev/null | tail -15`
- **After every plan wave:** Run `cd frontend && npm test 2>/dev/null | tail -15`
- **Before `/gsd:verify-work`:** Full suite must be green + manual verification of 6 views + login page
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 102-01-01 | 01 | 1 | UI-01 | — | N/A | scripted | `grep -c 'export' frontend/src/icons.ts` >= 4 | ❌ W0 | ⬜ pending |
| 102-01-02 | 01 | 1 | UI-01 | — | N/A | scripted | `ls frontend/src/openclaw/ui/icons.ts frontend/src/styles/icons.ts` both missing | ❌ W0 | ⬜ pending |
| 102-02-01 | 02 | 1 | UI-03 | — | N/A | scripted | `grep -rn 'icons\.' frontend/src/` returns empty for camelCase | ❌ W0 | ⬜ pending |
| 102-02-02 | 02 | 1 | UI-03 | — | N/A | scripted | `grep -rn 'from.*openclaw/ui/icons\|from.*styles/icons' frontend/src/` returns empty | ❌ W0 | ⬜ pending |
| 102-03-01 | 03 | 2 | UI-04 | — | N/A | scripted | `grep -rn 'ov-card' frontend/src/` returns empty | ❌ W0 | ⬜ pending |
| 102-04-01 | 04 | 2 | UI-05 | — | N/A | scripted | `grep -rn '[\u{1F50D}\u{1F4CA}\u{1F4E6}\u{26A0}]' frontend/src/openclaw/ui/views/` only status emoji remain | ❌ W0 | ⬜ pending |
| 102-05-01 | 05 | 2 | UI-02 | — | N/A | manual | All 6 views + login page render without console errors | ❌ W0 | ⬜ pending |
| 102-05-02 | 05 | 2 | UI-04 | — | N/A | scripted | `grep 'customElements.define.*stat-card' frontend/src/components/stat-card.ts` match found | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Verification test for `ui-01`: Check that `frontend/src/icons.ts` exists and exports the 4 expected symbols
- [ ] Verification for `ui-03`: Script to grep for remaining `icons.` dot-access patterns (camelCase remnants)
- [ ] Verification for `ui-04`: Script to grep for remaining `ov-card` class references
- [ ] Verification for `ui-05`: Script to grep for structural emoji in views

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| All previously missing icons render | UI-02 | Icon rendering depends on browser DOM and CSS variables — automated assertion requires headless browser | Start frontend, verify login page, dashboard, alerts, reports, schema-management, instances-db all render without console errors |
| Build succeeds after all changes | UI-01..05 | Vite build catches import resolution errors that individual tests may miss | `cd frontend && npx vite build 2>&1 | tail -5` — no errors |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
