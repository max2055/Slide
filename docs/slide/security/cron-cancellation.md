# Cron Agent 超时与执行所有权（MAX-52）

基线：`main@de02dc0`。范围为 `CronManager → CronExecutor → AgentRunner` 的 Agent 任务；有 `handler_key` 的 Worker 任务和 script 任务不属于本变更。

## 行为与收敛边界

- 每次执行创建独立 AbortController，wall-clock 超时先记录超时，再向 Runner、provider 和工具 context 发出取消。成功、异常、超时均清理 Cron timer。
- 超时调用及时返回 `stopReason=timeout`、error 和独立的 partial trace 快照；迟到结果不能覆盖为 success。
- `executionSettled` 总是 resolve，等待 Runner 与全部真实 provider 请求 settle。Runner 内部的取消 race 可以早于网络请求返回，所以通过可选 `onProviderRequest` 观察原请求；不改变其他 Runner 调用者的取消返回语义。
- Manager 在日志写入期间持有 runningFlags；即使日志失败，仍等 `executionSettled` 才释放。相同 job 跳过，其他 job 继续调度。不会为了恢复调度强制释放仍在执行的 job。
- 超时当下仍有工作未收敛时，在现有 `partial_trace` 字段保存 `cancellation_pending=true`、`outcome=unknown`、`scheduling=blocked_until_settled`。这是该次超时的历史快照，不是实时状态。

## 逐层取消核对

| 层 | 已核对行为 | 不支持取消时的处理 |
| --- | --- | --- |
| Runner | `spec.signal` 传给 provider；每轮和每个新工具前检查取消 | 不再开始后续工具；等待已开始的工具 Promise |
| OpenAI / Ollama | OpenAIProvider 将 signal 传给 SDK；Ollama 使用该兼容 provider | 追踪实际请求 Promise，不以 Runner 返回表示网络请求结束 |
| Anthropic | `llm-provider.ts` 的 chat/chatStream 均传 SDK signal | 同上；取消不等于远端推理已停止或不计费 |
| Cron registry | 只开放 actor/read 和 completion；read 工具 context 经 policy 传播 signal | 权限/审计异步检查完成后再次检查，禁止迟到启动 handler |
| Completion | 仅做参数校验和构造结果，没有数据库写入；Runner 在调用前检查 signal | 日志由 Manager 按超时结果保存，不接受迟到 success |
| 只读工具与驱动 | 实例/指标/告警查询、Oracle 报告及 server 工具并未统一消费 AbortSignal；数据库/SSH 调用没有统一的强制取消确认协议 | 作为不合作操作处理：不把工具 Promise 包在提前返回的取消 race 内，持有 job 直到 handler settle；不宣称 abort 已停止数据库/远端命令 |

`slide_check_status` 和 `slide_test_connection` 属于 execute，不会进入 Cron 的 read registry；它们的内部超时逻辑不属于本链。生产权限不是任意写工具权限，测试计数器仅复现执行重叠。

若 handler 或 provider 永不 settle，调用方不会挂死：超时已返回并记录，但该 job 保持隔离。应先禁用该 job、核查数据库活动会话/远端命令/供应商请求并由运维确认清理，再恢复服务与调度；不提供盲目解锁。进程内 guard 不是跨进程租约，重启会丢失 guard，因此不能把重启当成远端终止的证明。驱动拒绝或断线只证明本地 Promise 结束，远端结果仍可能不确定；本变更不提供跨进程 exactly-once 或数据库 KILL 协议。

## 验证入口

`apps/db-ops-api/src/__tests__/cron-cancellation.test.ts` 将 2026-09-16 审计 overlap 探针转换为常规回归：真实 AgentRunner、fake timers、可控 provider/工具、模拟日志存储。涵盖旧操作未收敛时不重入、收敛后恢复、合作工具取消、禁止下一工具、provider 晚返回/晚失败、同步/异步异常、timer 清理和日志失败。

`src/tools/policy.test.ts` 覆盖策略检查期间取消；agent-core 的 `runner-resource-lifecycle.test.ts` 覆盖流式/非流式请求的真实收敛观察，并继续运行既有 lifecycle/timeout 测试。此验证不使用真实数据库或 LLM，不声称验证远端强制终止。

## 本次验证结果（2026-09-17）

- RED：新增 Cron 回归最初 7 失败、1 通过，明确命中重叠、缺失 signal、timer 泄漏；policy 迟到启动回归 1 失败。
- GREEN：Cron 回归 8/8；policy 迟到启动回归通过。
- 受影响模块检查：Cron、policy、DirectAdapter 共 131 项通过。
- 最终 gate：`pnpm --filter slide-api test`：252 文件通过、1 文件跳过；2144 测试通过、13 跳过。MySQL script 集成按原配置在未设置 `CRON_TEST_MYSQL_PORT` 时跳过；不属于本次 Agent 路径。
- `pnpm --filter @slide/agent-core test`：10 文件、87 测试全部通过（包括 lifecycle、resource lifecycle、timeout）。
- `pnpm --filter slide-api typecheck`、`pnpm --filter @slide/agent-core typecheck`、`git diff --check` 均通过。
- 未测量覆盖率百分比，未做真实 LLM/数据库强制终止验收。
- 硬预算未设定；未委派子代理；实际 token/cached token/费用遥测不可用，不以估算冒充实测。
