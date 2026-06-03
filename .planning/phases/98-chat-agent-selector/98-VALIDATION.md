---
phase: 98
slug: chat-agent-selector
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-19
---

# Phase 98 -- Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 3.2.x |
| **Config file** | `frontend/vitest.config.ts` |
| **Quick run command** | `cd frontend && npx vitest run src/openclaw/ui/select-options.test.ts src/openclaw/ui/thinking-labels.test.ts src/openclaw/ui/chat/session-controls.test.ts src/openclaw/ui/phase-98-artifacts.test.ts` |
| **Full suite command** | `cd frontend && npx vitest run` |
| **Estimated runtime** | ~3 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick command above
- **After every plan wave:** Run `cd frontend && npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 98-01-01 | 01 | 1 | `pushUniqueTrimmedSelectOption` adds unique trimmed values, skips empty/duplicates | -- | N/A -- pure helper | unit | `npx vitest run src/openclaw/ui/select-options.test.ts` | ✅ | green |
| 98-01-01 | 01 | 1 | `normalizeThinkingOptionValue` normalizes thinking level values | -- | N/A -- pure helper | unit | `npx vitest run src/openclaw/ui/thinking-labels.test.ts` | ✅ | green |
| 98-01-01 | 01 | 1 | `formatInheritedThinkingLabel` and `formatThinkingOverrideLabel` format inherited/override labels | -- | N/A -- pure helper | unit | `npx vitest run src/openclaw/ui/thinking-labels.test.ts` | ✅ | green |
| 98-01-01 | 01 | 1 | `GatewayThinkingLevelOption` type exists in `types.ts` | -- | N/A -- type def | unit | `npx vitest run src/openclaw/ui/phase-98-artifacts.test.ts` | ✅ | green |
| 98-01-01 | 01 | 1 | `CHAT_SESSIONS_REFRESH_LIMIT=100` constant in `app-chat.ts` | -- | N/A -- constant | unit | `npx vitest run src/openclaw/ui/phase-98-artifacts.test.ts` | ✅ | green |
| 98-01-01 | 01 | 1 | i18n key `chat.selectors.agentFilter` in `en.ts` and `zh-CN.ts` | -- | N/A -- i18n key | unit | `npx vitest run src/openclaw/ui/phase-98-artifacts.test.ts` | ✅ | green |
| 98-01-02 | 01 | 1 | `session-controls.ts` created with minimum 800 lines | -- | N/A -- artifact | unit | `npx vitest run src/openclaw/ui/phase-98-artifacts.test.ts` | ✅ | green |
| 98-01-02 | 01 | 1 | `export function renderChatAgentSelect` present in session-controls.ts | -- | N/A -- export | unit | `npx vitest run src/openclaw/ui/phase-98-artifacts.test.ts` | ✅ | green |
| 98-01-02 | 01 | 1 | i18n import path correct for ui/chat/ location (`../../i18n/index.ts`) | -- | N/A -- import | unit | `npx vitest run src/openclaw/ui/phase-98-artifacts.test.ts` | ✅ | green |
| 98-01-03 | 01 | 1 | `renderChatAgentSelect` import added to `app-render.helpers.ts` | -- | N/A -- import | unit | `npx vitest run src/openclaw/ui/phase-98-artifacts.test.ts` | ✅ | green |
| 98-01-03 | 01 | 1 | Agent selector wired with `switchChatSession` handler in `renderChatSessionSelect` | T-98-01 / T-98-02 | No user data crosses trust boundary; Lit auto-escapes XSS | unit | `npx vitest run src/openclaw/ui/phase-98-artifacts.test.ts` | ✅ | green |
| 98-01-03 | 01 | 1 | Single agent -> `renderChatAgentSelect` returns `""` (no selector shown) | -- | N/A -- behavior | unit | `npx vitest run src/openclaw/ui/chat/session-controls.test.ts` | ✅ | green |
| 98-01-03 | 01 | 1 | Multiple agents -> `renderChatAgentSelect` returns rendered TemplateResult | -- | N/A -- behavior | unit | `npx vitest run src/openclaw/ui/chat/session-controls.test.ts` | ✅ | green |
| 98-01-03 | 01 | 1 | `t("chat.selectors.agentFilter")` called in aria-label when selector renders | -- | N/A -- i18n | unit | `npx vitest run src/openclaw/ui/chat/session-controls.test.ts` | ✅ | green |

*Status: green = test passes*

---

## Wave 0 Requirements

- [x] `frontend/src/openclaw/ui/select-options.test.ts` -- behavioral tests for `pushUniqueTrimmedSelectOption`
- [x] `frontend/src/openclaw/ui/thinking-labels.test.ts` -- behavioral tests for thinking label formatters
- [x] `frontend/src/openclaw/ui/chat/session-controls.test.ts` -- behavioral tests for `renderChatAgentSelect` single/multi-agent behavior
- [x] `frontend/src/openclaw/ui/phase-98-artifacts.test.ts` -- structural verification of types, constants, i18n keys, imports, wiring

*Existing infrastructure covers all phase requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Agent dropdown visually appears in Chat page top bar when multiple agents registered | Must-have 1 | Requires running the full frontend with gateway connection and multiple agents registered | Start backend (`cd apps/db-ops-api && npx tsx server.ts`), start frontend (`cd frontend && npm run dev`), ensure gateway is running with at least 2 registered agents, navigate to Chat page, verify agent dropdown appears above session select |
| Switching agent switches to that agent's main session | Must-have 3 | Requires gateway with multiple agents and session data | With multiple agents registered, open Chat page, select a different agent from dropdown, verify session list refreshes to show that agent's sessions |

*These behaviors are verified structurally (function exists, exports present, wiring confirmed via source checks) but require full integration test environment for visual/end-to-end verification.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: all phase tasks have automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 5s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
