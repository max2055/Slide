---
phase: 113-ai-cron-agent
created: 2026-05-27
status: discussed
---

# Phase 113: AI Agent Cron — 自然语言驱动定时任务

## Objective

将 Phase 112 的 DB 驱动调度器升级为 **AI Agent 驱动的自然语言定时任务系统**。
用户用自然语言描述任务要做什么，Agent 自主调用 tools/skills 执行，
替代现有的 13 个硬编码 TypeScript handler。

## Locked Decisions

### D-01: 任务范围 — 13 种子 + 可自由新建
用户可创建任意数量定时任务。13 个现有 handler 转为 NL 描述的种子数据，
不作为代码保留。

### D-02: Agent 执行模式 — 多轮自主执行
Agent 可以连续调用多个 tool，分析中间结果，决定下一步操作。
例如：查慢查询 → 发现异常 → 深入分析 → 生成报告。

### D-03: 执行结果 — 写入日志，UI 查看
结果写入 `cron_job_logs`。日志包含 Agent 完整执行过程。
用户通过定时任务管理界面的 Logs 子行查看。

### D-04: 会话管理 — 每次执行新建 Gateway 会话
每个 cron 执行周期创建一个新的 Gateway 会话（`chat.send` via port 28789/ws），
Agent 执行完毕后会话关闭。隔离性好，每个任务独立上下文。

### D-05: 旧 handler 处理 — 全部转为 NL，删除硬编码
`cron-job-handlers.ts` 中的 13 个 handler 函数全部删除。
`cron_jobs.handler` 字段替换为 `task_description`（自然语言文本）。
种子数据中每条记录包含对应的 NL 描述（基于原 handler 逻辑转写）。

### D-06: 执行超时 — 5 分钟
Agent 单次执行超时 5 分钟。超时后 Gateway 会话关闭，日志记为 `error`/`timeout`。

### D-07: Gateway 集成 — 复用现有 sendGatewayChat
已有 `apps/db-ops-api/src/adapter/openclaw/gateway-client.ts`：
- `sendGatewayChat({ sessionKey, message })` — WebSocket → `chat.send`
- 需要扩展以收集 Agent 响应（当前只 fire-and-forget）
- 需要支持 `chat.history` 拉取完整执行记录

### D-08: UI — 完整任务构建器
- 新建/编辑任务表单：名称、描述、NL 任务内容（textarea）、cron 表达式、启停开关
- 编辑图标已添加（Phase 112 收尾）
- 执行日志查看器已存在

### D-09: 权限模型
- `cron:view` — 查看任务列表和日志（已有）
- `cron:manage` — 新建/编辑/删除/启停/手动触发（已有，扩展覆盖新建/删除）

## Interfaces

### 现有 Gateway 客户端（gateway-client.ts）
```typescript
export function sendGatewayChat(params: {
  sessionKey: string;
  message: string;
}): Promise<void>;
```
需扩展为返回 Agent 执行结果。

### 现有 cron_jobs 表（需迁移）
```sql
-- handler 字段替换为 task_description
ALTER TABLE cron_jobs 
  DROP COLUMN handler,
  ADD COLUMN task_description TEXT NOT NULL AFTER name;
```

### CronManager 执行流程变更
```
旧: CronManager → getHandler(name) → handler() → 写日志
新: CronManager → 创建 Gateway session → chat.send(task_description) 
    → 等待 Agent 执行完成 → chat.history 拉取结果 → 写日志
```

## Deferred Ideas
- Agent 执行过程实时流式推送到 UI
- 任务执行失败自动重试（指数退避）
- 任务间依赖（任务 A 完成后触发任务 B）
- NL 任务模板库（常用场景预置模板）

## Next Steps
- Phase 目录需在 ROADMAP.md 中重命名（当前 113 为 "Verification 清账"）
- 准备进入 `/gsd:plan-phase 113`
