# MAX-48 发送确认总截止时间与安全重试

## 交付契约

仅修复 DirectAdapter 聊天发送确认；不迁移 `request()`，不修改 Agent 执行超时，不添加全局重试或无关功能。停止条件：范围内回归、受影响模块测试、类型检查、构建及后端去重联调完成，提交审阅。

- 默认从入队开始等待 60 秒；构造参数 `chatAcceptTimeoutMs` 可覆盖，只接受 1–2147483647 的安全整数毫秒。无新增环境变量或用户设置。
- 认证、每 15 秒重发、断线重连不刷新截止时间；后台计时器延迟时，发包前再次核对时间。
- 到期清除等待与重发计时器，提示“发送结果尚未确认”。这是接收状态未知，不是 Agent 执行失败。
- 同一页面、同一会话重新发送相同正文和附件时，复用原帧的 messageId/idempotencyKey，并给予这次手动核对新的有限等待窗口。后端以 `run.snapshot` 返回原执行状态；没有接收记录时可进行首次执行。
- 超时后仍接收迟到的会话分配和确认。确认已到达时旧 retry 回调不再发包；旧会话事件和超时不会清空用户当前的新会话。
- 重试身份只保存在客户端内存中，不提供刷新页面后的恢复能力。

## 版本与验证

最终代码候选：`d4df54b636f5ff3c6f6c9ed4377d20dbe87d75c2`，基于 `origin/main` 的 `ed46337`；分支 `agent/15codex/max-48-review`。后续仅添加本验证记录，不改变被测代码。

| 验收 | 命令/证据 | 结果 |
|---|---|---|
| 发送确认与 UI 定向回归 | `pnpm --filter slide-frontend test src/app/ui/direct-gateway.test.ts src/app/ui/controllers/chat-acceptance.test.ts` | 59 通过 |
| 前端完整回归（含历史分页、会话隔离、设备认证失败时 JWT 降级） | `pnpm --filter slide-frontend test` | 73 文件，471 通过 |
| 后端受影响模块 | `pnpm --filter slide-api test src/adapter/__tests__/direct-adapter.test.ts src/adapter/__tests__/agent-run-service.test.ts` | 47 通过 |
| 前后端类型检查 | `pnpm --filter slide-frontend typecheck`、`pnpm --filter slide-api typecheck` | 均通过 |
| 前端构建及 CSP | `pnpm --filter slide-frontend build` | 通过；存在既有 bundle 大小提示 |
| 真实传输与数据库去重 | 下述隔离联调 | 通过 |

新增回归已证明 RED→GREEN：迟到会话未保留、迟到确认后再次发包、旧会话抢占当前会话、旧发送超时清空新会话。其他用例覆盖认证等待、持续无确认、跨截止时间断线、后台延迟、重复手动超时、附件/身份保留和配置校验。未采集行覆盖率。

## 隔离后端联调

运行时间 2026-09-17 00:51:12 UTC；PID `95654`，监听 `127.0.0.1:51026`，上述候选版本。cwd 为交付工作树的 `apps/db-ops-api`，启动入口 `tests/chat-acceptance.integration.ts`，日志 `max48-final-integration.log`。现有 3000/28888 进程属于另一预览工作树，未作为本次验收实例。

复现命令：

```bash
DOTENV_CONFIG_PATH=<已有本地开发环境文件> pnpm --filter slide-api exec tsx tests/chat-acceptance.integration.ts
```

需要本地 MySQL CREATE/DROP DATABASE 权限。脚本克隆四张相关表的结构到唯一临时库，不复制业务数据；结束时清理数据库、套接字和临时工作目录。连接配置只从本地环境读取，不写入仓库。

实际运行 DirectAdapter、AgentRunner、WebSocket 和 MySQL；认证身份和 LLM 为确定性测试桩。丢弃首次 `session.created/run.started`，断线重连后重放完全相同的发送帧：先得到 `running` 快照，完成后再次重放得到同一 run 的 `completed` 快照。最终断言：LLM 调用 **1**、agent_runs **1**、会话 **1**、user/assistant 消息各 **1**。

未进行真实供应商 LLM、生产 JWT/数据库或浏览器人工端到端验收；上述联调不声称覆盖这些环境。

## 资源

硬预算未设定。子代理 0、最大深度 0、代理并发峰值 1。实际 raw/cached input、output token 和费用遥测不可用，未用内部估算冒充实测。
