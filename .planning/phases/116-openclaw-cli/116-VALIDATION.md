---
phase: 116
slug: openclaw-cli
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-02
---

# Phase 116 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (configured in `frontend/vitest.config.ts`) |
| **Config file** | `frontend/vitest.config.ts` |
| **Quick run command** | `cd frontend && npx vitest run --reporter=verbose 2>&1 \| tail -30` |
| **Full suite command** | `cd frontend && npx vitest run 2>&1 \| tail -50` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Quick grep of the specific pattern being changed
- **After every plan wave:** Full grep sweep for all remaining OpenClaw patterns
- **Before `/gsd:verify-work`:** Full vitest suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 116-01-01 | 01 | 1 | D-01, D-02 | N/A | N/A | file check | `test -f frontend/src/app/src/branding.ts` | ❌ W0 | ⬜ pending |
| 116-01-02 | 01 | 1 | D-03, D-04 | N/A | N/A | file check | `test ! -f frontend/src/app/src/infra/update-startup.ts` | ❌ W0 | ⬜ pending |
| 116-02-01 | 02 | 2 | D-05 | N/A | N/A | grep | `grep -rn 'OPENCLAW_' frontend/src/ --include="*.ts" \| grep -v node_modules \| wc -l` should be 0 | N/A | ⬜ pending |
| 116-02-02 | 02 | 2 | D-06 | N/A | N/A | grep | `grep -rn '__OPENCLAW_' frontend/src/ --include="*.ts" \| wc -l` should be 0 | N/A | ⬜ pending |
| 116-02-03 | 02 | 2 | D-11 | N/A | N/A | grep | `grep -rn 'Symbol\.for.*openclaw' frontend/src/ --include="*.ts" \| wc -l` should be 0 | N/A | ⬜ pending |
| 116-02-04 | 02 | 2 | D-07 | N/A | N/A | grep | `grep -rn '\.openclaw' frontend/src/ --include="*.ts" \| grep -v node_modules \| wc -l` should be 0 | N/A | ⬜ pending |
| 116-03-01 | 03 | 3 | D-08, D-09, D-10, D-14 | N/A | N/A | grep | `grep -rn '"OpenClaw\|OpenClaw ' frontend/src/app/src/ --include="*.ts" \| grep -v '^\s*//\|^\s*\*' \| wc -l` should be 0 | N/A | ⬜ pending |
| 116-04-01 | 04 | 4 | D-12, D-13, D-15 | N/A | N/A | grep | `grep -rn 'OpenClaw\|openclaw' apps/db-ops-api/sql/ frontend/src/ --include="*.css" \| wc -l` should be 0 | N/A | ⬜ pending |
| 116-04-02 | 04 | 4 | D-16, D-17 | N/A | N/A | vitest | `cd frontend && npx vitest run 2>&1 \| tail -50` | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `frontend/src/app/src/branding.ts` — new file (branding config)
- [ ] Verify `frontend/src/app/src/infra/update-startup.ts` deletion is safe (no runtime imports)

*Existing vitest infrastructure covers all phase test requirements. No new test framework needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| User-visible "OpenClaw" strings replaced with "Slide" | D-08, D-09, D-10 | grep verification for code strings; UI rendering needs human review | Build frontend, check chat/status/settings pages for "OpenClaw" residuals |
| External URLs (GitHub issues) handled properly | D-15 | Decision-dependent — remove dead links vs point to Slide repo | Review each URL change in diff for appropriateness |
| `CONFIG_DIR` import viability | pre-existing | `stage-sandbox-media.ts` imports from deleted `utils.ts` — needs pre-planning check | Run `tsc --noEmit` in frontend; verify CONFIG_DIR resolution before/after changes |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have automated or grep verification
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
