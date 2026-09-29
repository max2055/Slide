# Agent Runtime Guard Audit

更新时间：2026-08-29

## 本次已修复

| 机制 | 原行为 | 当前行为 | 验证 |
| --- | --- | --- | --- |
| 重复工具调用闸门 | 只按工具名累计，第 6 次调用阻断合法批量操作 | 按 `toolName + 规范化参数签名` 计数；不同参数不会互相污染 | `packages/agent-core/src/__tests__/runner-lifecycle.test.ts` |
| 并发工具批次 | 并发调用共享工具名计数，批量操作一起被误伤 | 每个参数签名独立计数；命中只返回该调用的错误结果 | 同上；`concurrentTools` 使用同一计数对象仍是安全的同步自增 |
| 闸门错误升级 | `failOnToolError=true` 时闸门命中升级为整轮 fatal error | 闸门命中 `error=null`，其他调用和后续迭代继续 | 同上 |
| 工作区越界闸门 | 没有越界输入信号，却对每次工具调用累计，第 4 次替换为越界提示 | 移除该无条件计数路径；工作区访问控制应由实际文件/沙箱工具执行层判断 | agent-core 全量测试 |
| 凭据/重复纳管终态 | 重复实例不返回可复用 ID；Agent 容易用同参数重试 | `INSTANCE_EXISTS` 返回已有 `instanceId`；无效凭据和连接失败标记 `retryable=false` | `add_database.test.ts` |
| 批量纳管工具 | 每个实例必须单独调用，批量任务容易触发轮次、循环闸门和上下文限制 | 新增 `slide_add_database_batch`，逐项复用单实例流程并返回 `created/pending_credentials/already_managed/failed`、`instanceId`、`errorCode`、`retryable` | `add_database_batch.test.ts` |
| 批量部分失败语义 | 任一条目失败都返回整体失败，Agent 容易重放已成功条目 | 批量执行完成即返回 `success=true,status=warning`，逐项结果决定后续动作；只重试已修正且 `retryable=true` 的条目 | `add_database_batch.test.ts` |

## 工具级场景审计（本轮）

| 工具/链路 | 已覆盖的异常场景 | 当前处理 | 仍需关注 |
| --- | --- | --- | --- |
| `slide_add_database` / `_batch` | 非法类型、无效端口、重复纳管、无效/已消费凭据、连接失败、单项异常 | 访问外部服务前校验；重复实例返回 ID；单项失败不拖垮批次；错误含终态/重试提示 | 批量受控并发、进度事件和跨进程幂等键 |
| `slide_test_connection` | 实例/直连参数混用、目标不存在、直连缺凭据、凭据无效、已有连接复用、连接失败 | 互斥校验；已有连接优先 `SELECT 1`；错误区分可恢复检查项 | 临时连接的连接池释放需继续在数据库服务层监控 |
| `slide_update_db_config` | 空更新、非法端口、空字段、ID/名称混用、凭据消费后更新失败、更新后连接失败 | 保留显式值；更新后连接失败为 `warning`，明确配置已保存；凭据消费状态写入 details | 更新与凭据消费的事务化/补偿机制 |
| `list_database_instances` / `get_instance_summary` | 无 actor、越权、无效/不存在实例、空列表 | 无 actor 明确失败；不存在实例不再伪装成成功空结果；保留空数据兼容字段 | REST 与 Agent 资源过滤应继续保持同一 scope |
| `list_active_alerts` | 非法级别、非法时间、超限/小数 limit、无 actor、空结果 | 参数在查询前拒绝；limit 固定 1-100；结果带摘要 | since 过滤目前仍在内存中，数据量扩大后应下推数据库 |
| `query_metrics` | 不存在实例、未知指标、非法模式/时间粒度、无实时/历史数据 | 不存在目标和未知指标明确失败；无数据为 `warning` 并给出采集排查动作 | 指标存储不可用与“确实无数据”仍需更细错误码 |
| Oracle ASH/AWR/表空间 | 时间倒序/过大范围、快照倒序、空报告、权限不足、空表空间 | 在查询前校验；ISO 时间规范化；空结果为 warning；权限错误保留明确终态 | Oracle 报告输出仍需真实版本/许可证环境回归 |
| `slide_check_status` | 单实例连接探测卡住、部分服务失败、无 LLM/无实例 | 单连接探测 5 秒超时并汇总；整体不健康用 warning 而非抛异常 | `getAllInstances()` 本身仍依赖数据库调用超时配置 |
| 工具发现/注册 | 动态导入失败、只加载部分工具、重试启动 | 加载异常不再缓存空 registry，下一次可重试；安全目录仍 fail closed | 多进程/打包产物需要启动阶段显式健康检查 |

## 本次对话链路审计已修复

| 机制 | 原行为 | 当前行为 | 验证 |
| --- | --- | --- | --- |
| 复制入口 | 聊天、代码块、Agent ID、连接命令各自直接调用 Clipboard API；HTTP/权限受限时无降级 | 统一使用 `copyTextToClipboard`，Clipboard API 失败时降级到隐藏 textarea + `execCommand` | `copy-as-markdown.test.ts` |
| WS 重连待发送队列 | `connect()` 每次重连清空队列，认证前已排队消息可能静默丢失 | 重连保留队列，认证成功后按原幂等键发送 | `direct-gateway.test.ts` |
| `chat.send` 成功语义 | WebSocket 不存在时 `sendChat()` 只告警，兼容 `request()` 仍 resolve，调用方误以为消息已提交 | `sendChat()` 返回接受结果；未连接时 `request('chat.send')` reject | `direct-gateway.test.ts` |
| reasoning 流 | reasoning 被拼接进答案流，前端先看到答案或思考顺序错乱 | `thinking_delta* -> thinking_end -> text_delta* -> complete`，前端独立渲染思考区 | `direct-adapter.test.ts`, `direct-gateway.test.ts` |
| 空响应补救 | finalization retry 未继承超时、取消信号、maxTokens、reasoningEffort，原运行终止后仍可能挂起 | 复用同一运行约束，并将 retry 超时/提供方错误转为明确终态 | `runner-timeout.test.ts` |

## 可配置项

循环闸门默认仍为 5 次相同参数调用，第 6 次阻断。可以在 `AgentRunSpec.loopGuardThreshold` 中为单次运行设置阈值，或设置环境变量 `AGENT_LOOP_THRESHOLD`（1-1000）。`AgentRunSpec` 优先于环境变量；非法值回退到 5。

参数签名会对对象键排序，数组保持顺序。凭据、密码、token、API key 等字段在日志中脱敏，但签名计数仍保留其实际值，因此不同 `credential_ref` 不会被错误合并。

## 仍会影响后续使用的停止/降级机制

以下机制不是本次误伤的同一个根因，但会造成 Agent 提前停止、降级或看起来像“锁死”，需要在运行监控中分开识别：

1. **最大迭代数**：`AgentRunSpec.maxIterations` 到达上限后返回 `stopReason=max_iterations`。DirectAdapter 使用运行时配置（默认 40），subagent 最多 25，背景 invoke 固定 8，cron 最多 40。长批量任务仍可能因轮数不足结束。
2. **运行/模型超时**：DirectAdapter 有整次运行超时，runner 有 LLM wall-clock/stream idle 超时，cron 还有额外 `Promise.race` 硬超时。超时会中断未完成工具并依赖 checkpoint 恢复，不能当作工具失败重试。
3. **`failOnToolError`**：真实工具抛异常时仍可把整轮升级为 `stopReason=tool_error`。这对不可恢复错误合理，但批量工具应返回结构化逐项结果而不是用异常表达单项失败。
4. **上下文治理**：`microcompact`、工具结果截断、历史 snip 和孤儿消息清理会丢弃旧上下文；被截断的工具结果可能让 Agent 重复查询。需要结合 `toolEvents` 与上下文预算日志判断。
5. **注入保护**：每轮注入最多 `MAX_INJECTIONS_PER_TURN=3`，最多 `MAX_INJECTION_CYCLES=5`。达到上限会停止继续注入，不是工具循环。
6. **空响应/长度恢复**：空响应重试最多 2 次，长度恢复最多 3 次；达到上限后会落入错误或最大迭代路径。
7. **并发分批规则**：只有工具声明 `concurrencySafe=true` 才会进入并发批次；非安全工具会强制串行。批量操作的吞吐和顺序因此取决于工具元数据，错误声明会造成竞态或不必要的延迟。
8. **工具注册/参数校验**：未知工具、Schema 参数错误在 `ToolRegistry.execute` 中转换为字符串错误并追加重试提示。若模型持续发送同一非法调用，会被重复调用闸门最终阻断；调用方应优先修正提示或参数生成。
9. **凭据引用单次消费**：`credential_ref` 被消费后不可复用。`slide_add_database` 的流程是“先不传凭据创建 `pending_credentials` 实例，再用 `slide_update_db_config` + 新凭据引用补充”，不能在同一引用失败后原样重试。
10. **审批与资源策略**：工具策略、审批过期、实例/目标范围拒绝会在工具进入业务 handler 前终止调用。这些拒绝不应被循环闸门吞并，前端和审计应展示 `reasonCode`。
11. **外部服务/数据库层限制**：连接测试、数据库连接池、目标网络策略和并发运行限制可能产生真实失败。它们与 loop guard 无关，应按 `errorCode`、实例 ID 和请求 ID 聚合。
12. **故障恢复 checkpoint**：fatal 工具错误发生在批次执行后，如果仍保留 `pending_tool_calls`，恢复会重放已经完成的副作用调用。runner 现在会先提交 `tools_completed` checkpoint，避免重复执行。
13. **subagent 上下文预算**：subagent 原先未提供 `contextWindowTokens`，runner 的历史裁剪因此被跳过。现在与主 agent 一样显式设置 200k 上下文和 4096 输出预算。
14. **session 并发写入（已修复主要风险）**：`DirectAdapter.chat()` 和 `invoke()` 现在按 `sessionKey` 串行化，避免上下文、checkpoint 和回复交叉；WS 消息 ID 已改用 UUID。多进程部署仍应使用数据库序列号保证跨进程排序。
15. **空响应最终重试（已修复）**：`requestFinalizationRetry()` 现在继承 `llmTimeoutS`、`signal`、`maxTokens`、`reasoningEffort`，并将补救请求的超时/提供方错误转换为明确终态。
16. **异常语义丢失（已修复）**：`ToolRegistry.execute()` 现在保留 handler 抛出的异常，由 runner 按 `failOnToolError` 决定终态；结构化 `{ success: false }` 仍作为业务结果返回。
17. **宽松数字转换（已修复）**：`castToolParams()` 现在要求完整数字字符串匹配后才转换，`"3306oops"` 不会再被转换为 `3306`。
18. **OpenAI `<think>` 标签解析（已修复）**：流式解析现在只保留可能的 opening tag 前缀，跨 chunk 标签不会重复发送已经展示的普通文本；仍建议补充真实 provider chunk 的集成测试。
19. **REST 历史读取静默降级（已修复）**：`DirectGatewayClient.request('chat.history')` 现在透传 fetch/HTTP 错误，由聊天控制器显示错误状态，不再伪装成空历史。

## 后续建议

- `slide_add_database_batch` 当前默认顺序执行；后续可在有明确幂等和连接池上限后增加可配置并发度。
- 将 runner 的 guard/timeout/context/approval 事件统一写入结构化 trace，至少包含 `tool`, 脱敏 signature, `iteration`, `count`, `threshold`, `stopReason`。
- 为 `maxIterations`、超时、注入上限和上下文截断增加独立指标，避免所有中断都被归类为“工具失败”。


## Runtime T5：有界长任务与迁移（MAX-91）

配置入口统一为 `adapter/runtime-policy.ts`。DirectAdapter 构造时校验并冻结配置；修改环境后须重建 adapter/重启服务，新 policy 不改写在途执行。LONG_CHAT 默认 false，本次不修改部署环境；试点仍须遵循 T6 的 observe/enforce/long-chat 顺序。

| 入口 | legacy 默认 | LONG_CHAT=true | deadline 来源 |
| --- | --- | --- | --- |
| chat | 120s / 40 steps | 无整轮 deadline / 200 steps | 新 `AGENT_CHAT_RUN_TIMEOUT_MS` > 旧 `AGENT_RUN_TIMEOUT_MS` > policy 默认 |
| invoke | 120s / 8 steps | 保持有界 | 旧 timeout；request 保持 60s |
| subagent | 120s / 25 steps | 保持有界，父剩余额度可收紧 | 旧 timeout 与 120s 取小，父 deadline 再收紧 |
| cron | job timeout / 40 steps | 保持有界 | job.timeout_seconds（默认 300s）仍独立且权威，不改为 chat/旧全局 120s |

旧 `AGENT_MAX_ITERATIONS` 和服务端显式 `maxIterations` 均生效，后台入口取更严格步数。新模式显式 timeout/iterations 必须是正整数字符串；空串、0、负数、小数、非数字报配置错误，绝不解释为无限。legacy 模式仍按原范围 fallback；新 chat timeout 在 legacy 模式不启用。LONG_CHAT 本身仅接受 true/false。

新模式四入口有 500 工具、600 provider attempts、1,000,000 total tokens 和 12 个无新工具证据步骤的有限上限。Chat 模型 request 300s、stream idle 60s、工具 60s；服务端工具 `timeoutMs` 更严格时优先。当前审批以 pending 结果返回，不在工具调用内等待人工，因此不会把用户审批等待计入 handler 超时；审批过期/消费/拒绝机制保留。文本 token 与 heartbeat 只能刷新流 idle，不能刷新 request/tool/run deadline 或资源预算。进展证据仅保留有界 HMAC 摘要，密钥不持久化；进程重启后首次工具结果只重建比较基线，不获得无法验证的进展额度。

计账口径：`prompt_tokens + completion_tokens`，cached_tokens 为 prompt 的子集。每次普通、重试、续写、摘要请求开始前，先按 context window + max output 预留；usage 不完整时保留 reservation 和 unknownRequests。真实 usage 返回后核对上限，再接受结果/调度工具。恢复、压缩不清零累计计数；deadline 以绝对时间持久化，恢复不能重新获得整轮时长。同 request key 重试沿用原账本；不同请求只有在前轮已终止且无 pending tool intent 时才启动新预算，避免过期 deadline 永久锁死会话。旧无 request key 的 checkpoint 保守按恢复处理。

子任务通过 runtime 异步上下文预留父额度，模型无法从参数伪造额度。分配在子任务启动前写 checkpoint；并发分配互斥于同步账本扣减。默认最多分配父剩余 token/attempt/tool 额度的一半，步数不超过子入口 25 和父剩余步数。预留不退款，单独记在 `delegated` 中，不冒充实际 usage；这会保守地限制多子任务吞吐，但避免异步结束/崩溃重复使用预算。父 Stop 信号传给子任务。

| 情形 | core resolution | 入口映射 |
| --- | --- | --- |
| 合格最终候选 | response_ready | chat/invoke completed；subagent completed；cron success；DB completed 仍由原事务决定 |
| steps/tools/attempts/tokens/no-progress 耗尽 | partial + typed reason | chat/invoke 保留 partial resolution；subagent legacy failed + resolution；cron partial |
| Stop | cancelled / USER_CANCELLED | chat/invoke cancelled；subagent legacy failed + cancelled resolution；cron保留 stop_reason |
| run/model/idle/tool 超时 | timed_out / 对应 typed reason | chat/invoke timed_out；subagent legacy failed + timed_out resolution；cron timeout |
| 不确定工具 intent 恢复 | failed / TOOL_SETTLEMENT_UNKNOWN | 禁止自动重放，等待对账 |

工具 timeout 仅请求取消：API 观察原始 Promise，session、WS actor、subagent actor 和 cron job 的所有权直到真实 settlement 才释放。未收敛工具保留 pending intent；迟到结果及 progress 不回填，Stop 后不启动下一工具。没有 settlement observer 的 core 调用仍等待原操作结束，避免提前释放调用方所有权。外部副作用无法承诺 exactly-once。

确定性验收入口：核心 `runtime-budget.test.ts` / `runtime-settlement.test.ts` / `runtime-compact.test.ts`；API `runtime-policy.test.ts` / `runtime-lifecycle.test.ts` / `agent-runtime-limits.test.ts` / `subagent-manager.test.ts` / `cron-security.test.ts`。130s/45 steps 使用 fake clock；不等同于 T6 真实部署 provider、30 分钟 soak、MySQL/WS/UI 资格与灰度验收。默认 1M token 只是待校准策略，不是实测成本。
