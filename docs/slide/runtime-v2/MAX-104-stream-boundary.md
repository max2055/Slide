MAX-104 将 text/reasoning/partial tool intent 置于共同撤回边界，只有持久化 checkpoint 确认后才更新 anchor；`response_ready` 仍由原完成事务决定是否成为最终 assistant。

## 执行契约与基线

- 范围：stream attempt/sequence、持久化 anchor、撤回与晚到事件、重启恢复、原工具 settlement/审批与完成事务回归。
- 排除：工具提前执行、新重试体系、通用重构、生产发布；未新增业务数据库表或迁移。
- 复核原始基线：`6c22d2a51d7bf17ec3cd36526032671b104849dd`。实施基线：main `34c67dbb1b75bb41cfd55750a1cfdeb6923ccf1e`，MAX-98 PR #103 与 MAX-103 PR #107 均核验已合并。
- 保留初始本地工作树的 AGENTS.md 和旧基线提交；独立分支 `agent/15astra/max-104-stream` 只携带本任务变更。
- 范围 v1 保持不变；同一 run 的恢复投影会切掉已保存 tool facts，直接阻塞崩溃恢复验收，因此修正该路径。取消时保存未提交半句的旧断言改为撤回尾部，保留已保存锚点。
- 停止条件：所需本地门禁与真实故障注入通过后提交 PR；CI 由平台条件唤醒继续核验/合并，不本地轮询。
- 硬资源预算：未设定。子代理数 0、最大深度 0、代理并发峰值 1。模型 raw/cached input、output tokens 和费用实测遥测不可用，未用内部计数冒充实际吞吐。

## 契约

`stream_state_v1` 保存递增 attempt、checkpoint 水位 sequence、源请求关联 UUID、已知 discarded bytes 和 anchor。anchor 包含 checkpoint ID、稳定 canonical message IDs、可恢复 text/reasoning；预先构造候选锚点，持久化 callback 成功返回后才在运行态发布。工具返回、hook 成功与最终响应可用均不能替代持久化。

- 初始安全边界以第一个持久化 checkpoint 建立；没有 anchor 的 transport recovery 返回 `STREAM_ANCHOR_UNAVAILABLE`。
- 只在完整工具批次 checkpoint 或接受并保存的 continuation 前缀推进锚点；清空 continuation 或保存 `final_response` 不会提交新 candidate reasoning。
- `text_delta` 的 cumulative replace 保持兼容，新增可选 `reset` 与 reasoning snapshot；新 UI 同时替换 thinking/text，拒绝旧 attempt、重复 sequence、terminal 后晚到事件。旧客户端仍替换 text，最终 thinking 由清理后的 terminal 内容提供。
- 取消或失败撤回未提交尾部；最终保存失败回滚 JSONL 内存缓存；新格式 `final_response` 不被 checkpoint restore 当作 canonical final。
- `chat.watch` 只补发当前有效 attempt 的替换快照，终态移除快照；历史读取继续由已有 durable canonical 路径提供。
- 已完成工具与审批凭据沿用原执行机制，未知 settlement 保留 pending intent 并禁止自动重放。
- 源请求关联 ID 是本地 request UUID，不冒充 provider HTTP request-id。provider-specific reasoning fields 保持原有解析/上下文兼容。
- 进程崩溃后未持久化的尾部字节不能精确重建，标记 `discardedBytesIncomplete=true`，不虚报为完整零字节；未结算 provider usage 保留原 unknown/reserved 累计预算。

## 验证

| 层级 | 命令/样本 | 结果 |
| --- | --- | --- |
| core | `pnpm --filter @slide/agent-core test`、typecheck | 597 项通过，27 个文件 |
| backend | `pnpm --filter slide-api test`、typecheck | 2776 项最终覆盖通过；129 项环境可选测试跳过，未计作通过 |
| frontend | `pnpm --filter slide-frontend test`、typecheck、build | 542 项通过；生产 build/CSP 校验通过 |
| API contract | `pnpm contracts:check` | 通过 |
| 审批/实际 intent | `src/security/agent-tool-approval-execution.mysql.test.ts`，显式启用隔离 MySQL | 14 项通过，包括审批消费、未知 intent 与事务回归 |
| canonical | `tests/qualification/canonical-history-mysql.ts`，独立临时 schema | 505 facts/JSONL 往返、COMMIT ack 丢失、唯一最终答案、并发 completion pending 恢复、缓存重建通过 |
| stream/reconnect/crash | `tests/qualification/agent-runtime-mysql.ts`，真实 MySQL/WS、受控 provider | thinking-only、partial args、工具 checkpoint 后 reset、取消/超时、重连有效快照、OS 崩溃恢复与 unknown settlement 不重放通过 |

开发先复现三项 thinking 污染（拒绝/仅推理断流/partial args），再修复。新增正例保留已保存工具/continuation 的 reasoning；晚到 callback、UI 队列 reset、最终 checkpoint 取消、最终保存失败、无 anchor 与非法恢复状态均有聚焦回归。最后一次 backend 完整运行有 2775 项通过，新增证据目录触发唯一文档布局失败；已把证据移至既有 `docs/slide/runtime-v2/`，11 项文档布局聚焦检查通过后组合验收覆盖全部 2776 项。完整 gate 只在相关实现变动后重跑；未变动的 frontend、canonical 与审批证据复用。

真实采样 IDs 与计数见相邻 `MAX-104-stream-boundary-probes.json`，不包含敏感正文、token 或凭据。WS 样本：thinking-only 丢弃 19 bytes；partial args 与工具后 reset 各丢弃 60 bytes；工具只执行一次，最终 assistant 只有一条。重启从 attempt 2 继续至 3；unknown settlement 重启后 provider 请求 0、pending intent 1。崩溃通过真实子进程退出 75/76 注入；完成事务回滚另有退出 74 样本。

真实测试使用随机隔离 schema、临时 JSONL 和动态 WS 端口，结束后关闭实例并删除其 schema；不触及生产会话。未调用付费真实 LLM；OpenAI/Anthropic reasoning 兼容由现有 provider 单测验证。浏览器真实生产渲染未在本地验证，前端单测/build 已通过，仓库 browser CI 仍按原门禁执行。CI 结果和合并状态由 PR 与 Multica 条件唤醒记录。
