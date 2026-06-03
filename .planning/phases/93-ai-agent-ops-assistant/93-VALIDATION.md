---
phase: 93
slug: ai-agent-ops-assistant
status: active
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-15
---

# Phase 93 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | grep-based source assertion (no formal test framework for this project) |
| **Config file** | none |
| **Quick run command** | `bash .planning/phases/93-ai-agent-ops-assistant/verify.sh` |
| **Full suite command** | same as quick run |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run per-task `<verify><automated>` commands
- **After every plan wave:** Run per-plan `must_haves` verification checks
- **Before `/gsd-verify-work`:** Run full must_haves check against ROADMAP success criteria
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 93-01-01 | 01 | 1 | AI-02 | T-93-01 | N/A | source | `grep "ai-settings" frontend/src/openclaw/ui/navigation.ts` | ✅ | ✅ |
| 93-01-02 | 01 | 1 | AI-02 | T-93-02 | N/A | source | `grep -c "ai-settings" frontend/src/openclaw/ui/views/ai-settings.ts` | ✅ | ✅ |
| 93-01-03 | 01 | 1 | AI-02 | T-93-03 | N/A | source | `grep "_toggleEnabled" frontend/src/openclaw/ui/views/ai-settings.ts` | ✅ | ✅ |
| 93-01-04 | 01 | 1 | AI-02 | T-93-04 | N/A | source | `grep "POST\|PUT" apps/db-ops-api/server.ts \| grep "ai/config"` | ✅ | ✅ |
| 93-02-01 | 02 | 1 | Phase 93 SC5 | T-93-05 | N/A | source | `grep "activeRunIdBeforeEvent" frontend/src/openclaw/ui/app-gateway.ts` | ✅ | ✅ |
| 93-02-02 | 02 | 1 | Phase 93 SC6 | T-93-06 | N/A | source | `grep "shouldQueueLocalSlashCommand" frontend/src/openclaw/ui/app-chat.ts` | ✅ | ✅ |
| 93-02-03 | 02 | 1 | Phase 93 SC5 | T-93-07 | N/A | source | `grep "sessionMatches" frontend/src/openclaw/ui/controllers/chat.ts` | ✅ | ✅ |
| 93-02-04 | 02 | 1 | Phase 93 SC5 | T-93-08 | N/A | source | `grep "handleTerminalChatEvent" frontend/src/openclaw/ui/app-gateway.ts` | ✅ | ✅ |
| 93-03-01 | 03 | 1 | AI-02 | T-93-09 | N/A | source | `grep "list_active_alerts" apps/db-ops-api/src/tools/ops/list_active_alerts.ts` | ✅ | ✅ |
| 93-03-02 | 03 | 1 | AI-02 | T-93-10 | N/A | source | `grep "get_instance_summary" apps/db-ops-api/src/tools/ops/get_instance_summary.ts` | ✅ | ✅ |
| 93-03-03 | 03 | 1 | AI-02 | T-93-11 | RBAC inheritance | source | `grep "classifyIntent" apps/db-ops-api/src/agent-service.ts` | ✅ | ✅ |
| 93-03-04 | 03 | 1 | AI-02 D-04 | T-93-12 | N/A | source | `grep "getAgentGreeting" apps/db-ops-api/src/agent-service.ts` | ✅ | ✅ |
| 93-04-01 | 04 | 1 | AI-02 | T-93-13 | N/A | source | `grep "renderBackLinks" frontend/src/openclaw/ui/controllers/chat.ts` | ✅ | ✅ |
| 93-04-02 | 04 | 1 | AI-02 | T-93-14 | N/A | source | `grep "slide-navigate" frontend/src/openclaw/ui/controllers/chat.ts` | ✅ | ✅ |
| 93-04-03 | 04 | 1 | Phase 93 | T-93-15 | N/A | source | `grep "isHeartbeatAckText" frontend/src/openclaw/ui/controllers/chat.ts` | ✅ | ✅ |
| 93-05-01 | 05 | 2 | AI-02 SC2 | T-93-16 | info disclosure (200-char truncation) | source | `grep "metricsDatabaseService.getSlowQueries" apps/db-ops-api/src/agent-service.ts` | ❌ W0 | ⬜ pending |
| 93-06-01 | 06 | 2 | AI-02 D-04 | T-93-17 | tampering (JSON parse fallback) | source | `grep "chat/greeting" apps/db-ops-api/server.ts` | ❌ W0 | ⬜ pending |
| 93-06-02 | 06 | 2 | AI-02 D-04 | T-93-18 | XSS (toSanitizedMarkdownHtml) | source | `grep "chat/greeting" frontend/src/openclaw/ui/app-chat.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `93-05-01` — `executeSqlOptimization` calls `metricsDatabaseService.getSlowQueries` (replace stub)
- [ ] `93-06-01` — `GET /api/chat/greeting` route returns `getAgentGreeting()` output
- [ ] `93-06-02` — Chat welcome section fetches and displays greeting from API

*Wave 0 covers gap-closure plans only (93-05, 93-06). Plans 93-01 through 93-04 are already verified green.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Chat AI answers slow query questions in real chat | AI-02 SC2 | Requires live Gateway + LLM session | Open Chat, type "最近的慢查询是什么", verify AI responds with real slow query data (not "功能开发中") |
| New chat session shows greeting | AI-02 D-04 | Requires live browser session | Open Chat, start new session (/new or fresh load), verify greeting message with capability hints appears |
| Intent classification routes to correct prompt | AI-02 D-02 | Requires live LLM interaction | Send messages about alerts, slow queries, instances, and general chat — verify each routes to correct system prompt |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 10s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** 2026-05-15
