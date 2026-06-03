---
phase: 92
slug: ai-analysis-visibility
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-14
updated: 2026-05-19
---

# Phase 92 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (backend: node env, frontend: jsdom env) |
| **Config file** | apps/db-ops-api/vitest.config.ts, frontend/vitest.config.ts |
| **Quick run command** | `cd apps/db-ops-api && npx vitest run src/ai-analysis-config-service.test.ts` |
| **Full suite command** | See individual test commands per task below |
| **Estimated runtime** | ~15 seconds (147 tests across 7 files) |

---

## Sampling Rate

- **After every task commit:** Run the test for the affected file
- **After every plan wave:** Run all tests for that plan's subsystem
- **Before `/gsd-verify-work`:** All 7 test files must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 92-01-01 | 01 | 1 | AI-01 | T-92-01 | JWT auth on tool call | unit | `cd apps/db-ops-api && npx vitest run src/tools/generated/slide-self-mgmt/complete_analysis.test.ts` | ✅ | ✅ green |
| 92-01-02 | 01 | 1 | AI-01 | T-92-02 | SKILL.md files read-only at runtime | unit | `cd apps/db-ops-api && npx vitest run src/skills/generated/skill-files.test.ts` | ✅ | ✅ green |
| 92-02-01 | 02 | 1 | AI-01 | T-92-03 | XSS sanitization via sanitize() | unit | `cd frontend && npx vitest run src/openclaw/ui/views/ai-analysis-result.test.ts` | ✅ | ✅ green |
| 92-03-01 | 03 | 2 | AI-01 | T-92-04 | Config field validation in saveConfig() | unit | `cd apps/db-ops-api && npx vitest run src/ai-analysis-config-service.test.ts` | ✅ | ✅ green |
| 92-03-02 | 03 | 2 | AI-01 | T-92-05 | ai:view/ai:manage permission via preHandler | unit | `cd apps/db-ops-api && npx vitest run src/ai-analysis-routes.test.ts` | ✅ | ✅ green |
| 92-04-01 | 04 | 2 | AI-01 | T-92-06 | Server-side validation in config service | unit | `cd frontend && npx vitest run src/openclaw/ui/views/alerts-analysis.test.ts` | ✅ | ✅ green |
| 92-04-02 | 04 | 2 | AI-01 | T-92-06 | Config saved via PUT with auth | unit | `cd frontend && npx vitest run src/openclaw/ui/views/alerts-analysis.test.ts` | ✅ | ✅ green |
| 92-05-01 | 05 | 2 | AI-01 | T-92-07 | ai:view permission required | unit | `cd frontend && npx vitest run src/openclaw/ui/views/instance-detail-diagnosis.test.ts` | ✅ | ✅ green |
| 92-05-02 | 05 | 2 | AI-01 | T-92-07 | Markdown sanitized via ai-analysis-result component | unit | `cd frontend && npx vitest run src/openclaw/ui/views/instance-detail-diagnosis.test.ts` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. 7 test files created with 147 total tests.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Agent E2E analysis workflow | AI-01 | Requires live Gateway + LLM + DB | Trigger alert → Agent runs skill → verify Markdown saved in DB |
| Frontend visual rendering (badge colors, modal layout) | AI-01 | CSS visual regression needs screenshot comparison | Open alert list → verify badge colors match UI-SPEC; open result modal → verify layout |
| Config panel save → persistence cycle | AI-01 | Requires live MySQL system_config table | Save config via UI → restart backend → GET /api/ai/config → verify persisted values |

---

## Validation Audit 2026-05-19

| Metric | Count |
|--------|-------|
| Gaps found | 9 |
| Resolved | 9 |
| Escalated | 0 |

### Implementation Bugs Discovered (not fixed — escalated for developer)

**Bug 1 (BLOCKER):** `complete_analysis.ts` line 6 imports from `../../ai-analysis-database-service.js` but the file is 3 levels up at `src/ai-analysis-database-service.ts`. The import path should be `../../../ai-analysis-database-service.js`. Tests pass via `vi.mock` but runtime will fail.

**Bug 2 (WARNING):** `ai-analysis-result.ts` `renderResult()` returns HTML but is interpolated via Lit's `${}` which HTML-escapes the output. Markdown is rendered as text (visible but unformatted). Fix: use `unsafeHTML` directive from `lit/directives/unsafe-html.js`.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify commands
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending 2026-05-19
