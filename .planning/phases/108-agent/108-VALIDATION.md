---
phase: 108
slug: agent
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-25
---

# Phase 108 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `apps/db-ops-api/vitest.config.ts` |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run full suite
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| *(to be filled by planner)* | | | MIG-01 | — | — | unit | `npx vitest run` | — | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/db-ops-api/src/__tests__/agent-engine.test.ts` — IAgentEngine interface contract tests
- *(Existing test infrastructure covers remaining phase requirements.)*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Adapter switch dual-run comparison | MIG-01 | Requires both adapters running simultaneously with live LLM calls | Toggle `ENABLE_AGENT_ADAPTER_CHAT`, send same message to both paths, compare ChatEvent sequences |
| Streaming fidelity across adapters | MIG-01 | Requires real WebSocket connection and visual inspection of streaming | Open Chat in browser, send message, verify text appears incrementally without gaps or stalls |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
