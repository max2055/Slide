# Phase 98: Chat Agent Selector UI

## Goal

移植最新 OpenClaw 的 Agent/Session/Model/Thinking 四个下拉选择器到 Slide Chat 页面。

## Scope

### In scope
- 移植 `ui/src/ui/chat/session-controls.ts` 及其依赖到 Slide 前端
- 在 Chat 页面顶部渲染 Agent/Session/Model/Thinking 四个 select
- Agent 下拉框显示已注册的 agent（从 gateway 的 agentsList 获取）
- 切换 agent 时自动切换到该 agent 的主 session

### Out of scope
- 创建新的 agent 配置（后续 Phase）
- 后端 agent 工具分配（后续 Phase）
- Model catalog 同步机制改进

## Reference

最新 OpenClaw 源码在 `/tmp/openclaw-latest/ui/src/ui/chat/session-controls.ts`
Slide 的 Chat 组件在 `frontend/src/openclaw/ui/views/chat.ts`

## Files to port from latest OpenClaw

| Source | Dest | Notes |
|--------|------|-------|
| `ui/src/ui/chat/session-controls.ts` | `frontend/src/openclaw/ui/chat/session-controls.ts` | Core component |
| `ui/src/ui/chat-model-select-state.ts` | `frontend/src/openclaw/ui/chat-model-select-state.ts` | Model select state |
| `ui/src/ui/chat-model-ref.ts` | `frontend/src/openclaw/ui/chat-model-ref.ts` | Model override ref |
| `ui/src/ui/thinking.ts` | `frontend/src/openclaw/ui/thinking.ts` | Thinking levels |
| `ui/src/ui/thinking-labels.ts` | `frontend/src/openclaw/ui/thinking-labels.ts` | Thinking labels |
| `ui/src/ui/session-key.ts` | `frontend/src/openclaw/ui/session-key.ts` | Session key parsing |
| `ui/src/ui/select-options.ts` | `frontend/src/openclaw/ui/select-options.ts` | Select helpers |

## Success criteria

1. Chat 页面顶部显示 Agent / Session / Model / Thinking 四个下拉框
2. Agent 下拉框列出所有已注册 agent
3. 切换 Agent 时 session 列表联动刷新
4. Model/Thinking 切换生效（通过 gateway sessions.patch API）
