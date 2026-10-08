# MAX-130 对话与登录提示修复计划 v1

执行契约：以任务正文 v1 为既定方案，范围限于对话操作错误、连接与恢复提醒及相邻登录通知。排除后端协议改造、充值、提供商切换、全站通知重构和无关问题。未设硬预算；建议 90 分钟；不委派；raw/cached/output token 与费用遥测不可用。

1. 基于 main 804edf0 隔离修复；原工作树与无关基线文件保留。任务提到的 codex/fix-chat-error-visibility 分支不在当前 Git/worktree 清单，按等效行为补回自动历史刷新保留错误，并添加失败快照测试。
2. 先添加 RED 回归：完整原因唯一渲染、API Key 原文、发送失败无假 assistant、异步会话隔离、失败/恢复历史刷新保留提示、登录通知不重复。
3. 运行错误沿用 lastError；新增 connectionError 和 chatRecoveryNotice，避免连接恢复清除运行错误。共享 app-notice 使用 Shadow DOM、token、alert/status 语义，聊天与登录复用。仅精确错误码翻译，具体文案原样保留。去掉聊天页头错误标签和重复 callout。
4. 保持草稿、确认状态及幂等重试；清理边界为下一次发送、明确刷新和会话切换。自动历史加载与恢复不清错误。
5. focused Vitest 后运行受影响模块测试；最终前端构建/CSP、桌面与窄屏 Playwright 验收八类错误计数及登录/发送/流式工具恢复。附截图与计数报告。达到验收即停止；提交 PR 并按实际门禁完成无冲突合并。
