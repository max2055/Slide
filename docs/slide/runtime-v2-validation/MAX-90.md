# MAX-90 — T4 ContextManager、摘要与快速回填熔断

## 执行契约与基线

- 实施基线/latest main：`371d2c28b677cf29ab029e72d5f0683222793cfd`；分支 `agent/15astra/5ebcc24aa332`。相对原始 `07b3e6c` 已包含 MAX-87 提取、MAX-88 完成监督和 MAX-89 恢复/settlement。
- MAX-88 PR #96、MAX-89 PR #97 均经 Multica pull-requests 核验为 merged，8 项 CI passed；MAX-87 使用已批准的 PR #95 例外。
- 范围为已批准计划 §2.6/T4；不改变 T5 入口默认时限，不声称 T6 真实模型、soak、灰度完成。硬预算未设定；无子代理，深度 0，并发峰值 1。实际 input/cached/output/费用遥测不可用。
- 验收要求：最终请求不越配置预算，无法容纳明确失败；摘要先持久化再替换投影；原始历史和权威权限独立；恢复/摘要成本累计且第三次快速回填熔断。发现权限提升、半提交、重复工具执行或必需门禁失败即停止交付并修复。

## 实现与边界

- `ContextManager` 统一原子工具消息组、microcompact 和工具结果限额，删除原来 catch 后发送未治理原始请求的路径。孤儿/重复结果移出投影，缺失结果补不确定标记，不自动执行工具。
- 工具原始结果保留在 run history/checkpoint；截断只作用于投影。原始 system 和 user 消息在压缩时独立保留；最近两组工具调用/结果保留为完整原子组。已完成/不确定工具的 ID、名称、参数及审计来源索引由原记录重建，`result_recorded` 不等同成功。
- 输入限额计入 system/messages/schema、图片估算、输出预留和 1024 safety buffer。可选 provider tokenizer；缺少时以 UTF-8 byte 数、消息 framing 和每图 4096 allowance 保守估算，明确标记 `estimated`，不声称真实 tokenizer 测量。最终 ModelStep 在实际 dispatch 前再次检查当前 schema 和完整投影，覆盖 hook/checkpoint 后变更。
- 默认 proactive 80%、目标 50%，可配置。摘要调用使用同一 provider/model、tools=[]、有界 maxTokens、wall/idle deadline，内部流不对用户输出。六个字段严格验证；不完整结果、工具意图、取消、源变化和持久化错误均拒绝发布。
- summary record 包含 schemaVersion/sourceStart/sourceEnd/sourceHash；来源范围必须完整匹配，成功保存后才激活。保存期间新增 suffix 保留，改变已摘要 prefix 则明确失败。缺少 checkpoint 持久化能力时不提交摘要。
- 摘要和工具证据均使用明确标注为非授权信息的 user 数据消息，绝不转成 system；模型不能修改来自原消息或调用者结构化状态的 pins。保留引用不等于模型摘要语义绝对无损；真实模型质量仍需 T6 联调/评测。
- 每 run 最多 4 次摘要请求，与总恢复预算共用账本。首次压缩不计 refill；不足 3 个完整 batch 再压缩递增 streak，第三次阻断；正常间隔只重置 streak。checkpoint 恢复 compact/usage/recovery 计数，不重执行工具。
- 摘要请求、失败/超时、缺失 usage 均计账；unknown 保留预留值。cached input 是 input 子集。timeout 保留真实 provider promise 的 settlement 观测并准确报告 timed_out；取消不调度后续模型。
- compatibility 当前快照更新新增 compact checkpoint 字段和独立 hook projection 行为；原始 legacy trace 仍保留于 `runtime-v2-source/legacy-runtime-traces.snap`，无正常短答额外模型请求。

## 验证证据

环境：macOS arm64，Node v24.18.0，pnpm 11.19.0，Vitest 4.1.8。

- 初始两个新增 suite 因缺少实现失败；随后逐步加入中文、巨大 schema/工具结果、图片、配对、连续 compact、来源/persistence/cancel、权限和恢复夹具。
- `pnpm --filter @slide/agent-core exec vitest run src/__tests__/runtime-context.test.ts src/__tests__/runtime-compact.test.ts src/__tests__/context.test.ts src/__tests__/runner-checkpoint.test.ts`：51 项通过；后续补充第 4 次正常间隔压缩耗尽测试，在最终全模块中通过。
- `pnpm --filter @slide/agent-core typecheck`、`pnpm --filter @slide/agent-core test`：最终 423 项通过。
- `pnpm --filter slide-api typecheck`、`pnpm --filter slide-api test`：2694 passed / 129 skipped。最终相关 DirectAdapter 回归 50 项通过。
- frontend typecheck、541 tests、build（含 CSP）通过；sandbox typecheck、22 passed / 4 skipped。
- `pnpm lint`：0 errors（仓库既有 warnings）；`pnpm contracts:check`、`pnpm qualification:matrix`（37/37）、`pnpm security:audit`（无已知漏洞）、`pnpm security:scan` 通过。
- 最终小修仅涉及摘要保护投影和超时分类；重跑 agent-core 全模块/typecheck、DirectAdapter 相关测试，其余未变化门禁复用已有结果。

跳过的环境用例未算通过。此阶段未调用付费部署模型、未跑 T6 30 分钟 soak/生产灰度；CI 的 browser/recovery/release 检查结果在 PR 和任务交付评论记录，不能以本地单元测试代替。
