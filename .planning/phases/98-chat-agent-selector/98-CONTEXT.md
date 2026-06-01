# Phase 98: Chat Agent Selector UI - Context

**SPEC:** `98-SPEC.md`
**Reference:** `/tmp/openclaw-latest/ui/src/ui/chat/session-controls.ts` (869 lines)

## Locked Decisions

**D-01:** 从最新 OpenClaw 源码直接移植文件，不自己写逻辑
**D-02:** 端口 `session-controls.ts` 及其 6 个依赖文件
**D-03:** 只渲染 Agent 选择器（下拉框），Model/Thinking/Session 选择器暂缓
**D-04:** Agent 列表从 gateway `agentsList` 获取（已有接口）
**D-05:** 切换 agent 时调用 `buildAgentMainSessionKey` 生成 session key

## Dependency Analysis

`session-controls.ts` imports from:
| Import | Slide has? | Action |
|--------|-----------|--------|
| `lit` html/repeat | ✅ | |
| `../../i18n/index.ts` | ✅ `../i18n/index.ts` | path adjust |
| `../app-chat.ts` (CHAT_SESSIONS_*) | ✅ | |
| `../app-view-state.ts` (AppViewState) | ✅ | |
| `../chat-model-ref.ts` | ❌ | port |
| `../chat-model-select-state.ts` | ❌ | port (or stub) |
| `../controllers/agents.ts` | ✅ | |
| `../controllers/sessions.ts` | ✅ | |
| `../select-options.ts` | ❌ | port |
| `../session-key.ts` | ❌ | Slide has `routing/session-key.ts` — check |
| `../string-coerce.ts` | ✅ | |
| `../thinking-labels.ts` | ❌ | port (or stub if Model/Thinking deferred) |
| `../thinking.ts` | ❌ | port (or stub) |
| `../types.ts` | ✅ some | check GatewayThinkingLevelOption |

## Strategy

1. **Port core files** — copy `session-controls.ts` + needed deps from `/tmp/openclaw-latest/`
2. **Adapt imports** — adjust paths to match Slide's directory structure
3. **Stub Model/Thinking** — if dependency chain too deep, stub those selectors
4. **Wire into chat.ts** — render `renderChatAgentSelect` at top of chat page
5. **Agent selection flow** — on change → `buildAgentMainSessionKey` → switch session
