# MAX-89 — T3 恢复、续写与执行收敛

## 执行契约

- 范围：T3 的统一恢复计数、续写合并、模型边界 request/idle 取消、真实 settlement、checkpoint 恢复与直接入口接线。排除 T4 摘要压缩、T5 长任务默认值、T6 生产灰度及无关工具重构。
- 基线：`a02c60a6ebc32f26e71b6dbc6fbc8f01ae9f1ab9`，2026-09-29 fetch 后 HEAD 与 origin/main 一致。相对原始 `07b3e6c`，包含 MAX-87 状态提取、MAX-88 候选监督/历史隔离，以及 MAX-88 已授权的依赖漏洞修复。
- 前置：MAX-87 PR #95 merged（按专属关联例外）；MAX-88 PR #96 Multica 关联 state=merged，8 项 CI passed，已有 MySQL/WS 验收证据沿用其版本。
- 分支：`agent/15astra/3c0c72bb6752`。硬预算未设定；无子代理，深度 0，并发峰值 1；模型实际 input/cached/output/费用遥测不可用，不以内部计数冒充实测。
- 验收：三项截断复现由失败转正确，保留 T2 复读回归；恢复分类与总预算跨工具/重启不重置；模型取消不释放未收敛操作所有权；旧 checkpoint 可读且先恢复再构建上下文。focused → 模块 → 最终 gate；合并需全部仓库 CI 通过。
- 停止条件：重复副作用、坏候选进入历史、未知 checkpoint 被自动续跑、迟到结果提交或仓库门禁失败。发现后修复对应范围，不绕过检查。

## 实现与兼容决定

- `RecoveryPolicy` 的默认分类上限 empty=2、repetition=2、continuation=3、stream=2，统一总恢复上限 8。所有请求通过同一 loop；关闭两种 SDK 隐式 retries，运行时进行最多两次暂态恢复，避免嵌套重试乘法。退避 1s/2s，并尊重 Retry-After；run signal 在退避期间仍能取消。
- `RuntimeError` 保留 source/code/retryable/recoverable/causeCode/providerStatus/attemptId。401/403/无效参数不自动重试。context overflow 明确分类并停止；reactive compact 的实现仍属于 T4，context 计数槽已预留。
- 按顺序合并续写，只消除完全一致的边界重叠。第 4 次 length 返回 OUTPUT_LIMIT/partial；续写提示仅存在 provider projection。修复 OpenAI 流式及非流式忽略 finish_reason 的根因；未收到终结原因的断流不能冒充完成，截断工具参数不能执行。
- request/idle timers 统一位于 model boundary；真实 provider Promise 继续接受 settlement 观测。超时/取消后屏蔽迟到 delta；非合作工具 await 实际结束，不发迟到成功 hook。DirectAdapter 的 session 锁保留至真实请求结束，但超时结果可及时返回；Cron 继续沿用 MAX-52 executionSettled 所有权机制。
- `runtime_state_v1` 保存累计 model/provider/tool/recovery/usage 计数；每次请求前保守预留未知 usage，缺失 usage 不按零处理。cached input 是 input 的子集。未知 checkpoint version 拒绝运行；pending intent 必须对账，不能自动重放。
- 兼容旧 snake_case 和当前 camelCase checkpoint 消息。新 ledger 不随消息 materialize 清除；已 materialize 的消息只恢复一次，避免后续用户消息破坏后缀去重。按成功/非成功终态清理或保留 checkpoint。
- 冻结 legacy trace 原件保留在 `docs/slide/runtime-v2-source/legacy-runtime-traces.snap`。当前快照仅更新 T3 预期变化：新增计账 checkpoint、typed errors、正确的续写/终态。

## 验证

环境：macOS arm64，Node v24.18.0，pnpm 11.19.0，Vitest 4.1.8。首次三项 recovery 测试均失败，分别证实错误 completed、只保留尾段、空补救后丢前文；修复后通过。

- agent-core typecheck 与模块测试通过；包含 recovery、settlement、timeout、旧/新 checkpoint、公开 runner API、thinking、并发工具、mid-turn injection、四项历史复现。
- API typecheck 与全模块：2694 passed / 129 skipped；相关最终 focused：78 passed，覆盖 DirectAdapter、Cron security、MAX-52 cron-cancellation、审批 execution 和 provider transport。
- frontend typecheck、541 tests、build 通过；sandbox typecheck、22 passed / 4 skipped。
- lint、contracts:check、qualification:matrix（37/37）、security:audit（无已知漏洞）、security:scan 通过。
- 真实 OpenAI/Anthropic SDK 对本地 HTTP fixture：首 token 前 idle 取消、真实请求 settlement、401 状态保留及单次请求均通过。这是实际 SDK/transport 验证，不是真实部署模型或付费模型联调。
- 专项行为：交替恢复达到总上限 8；JSON checkpoint 重启不重置；Retry-After 延迟；backoff/stream/checkpoint 取消；迟到 delta/结果隔离；同 session 和同 Cron job 保持占用；未知副作用不重放；恢复证据先于 context build。
- 全 gate 发现的取消部分输出覆盖回归已修复，并重跑受影响模块。未变化的 frontend/sandbox/静态门禁复用同环境结果。

未将跳过的数据库/环境集成用例算作通过。本阶段未执行真实部署模型、30 分钟 soak 或生产灰度；这些属于 T6。未修改审批/退款语义，也未宣称外部副作用 exactly-once。
