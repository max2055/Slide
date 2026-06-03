# Phase 111 Gateway 简化 — Discussion Log

## 完全失效的 Controller（9 个）

**Q: 如何处理 9 个所有 RPC 方法都 throw 的 controller？**
- 选项: 全部删除 | 删除 controller 保留 view 骨架 | 全部保留不动
- 选择: **删除 controller，保留 view 骨架**
- 理由: 删除无用的 RPC 调用代码，view 改为占位页避免用户点击后报错

## 部分失效的 Controller（3 个）

**Q: sessions/agents/chat 部分方法可用，如何处理？**
- 选项: 保留可用方法删失效方法 | 全部保留不动
- 选择: **保留可用方法，删失效方法**
- 理由: sessions.list、agents.list、chat.send/history 通过 REST API 可用，保留。mutation 方法和 tools catalog 等删掉，对应 UI 按钮隐藏

## Slash Command 清理（8 个）

**Q: 8 个断掉的 slash command 如何处理？**
- 选项: 删 handler 保留命令名+友好提示 | 全部删掉
- 选择: **全部删掉**
- 理由: 从注册和 handler 中完全移除，不留残余

## Protocol/ 目录

**Q: openclaw/protocol/ 目录何时处理？**
- 选项: Phase 111 处理 | Phase 112 统一处理
- 选择: **Phase 111 不动，留给 Phase 112**
- 理由: protocol/ 是独立 schema 目录，Phase 112 整体重命名时一起处理更干净
