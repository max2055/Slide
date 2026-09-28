# Slide / ZCode Agent Runtime 对比复核

复核日期：2026-09-28（Asia/Shanghai）。结论：**有条件采纳报告方向，采用渐进式内核拆分；不建议直接移植 ZCode，也不建议先撤掉时限再补治理。**

## 1. 基线、范围与证据强度

- 输入：`202609282307-Slide项目Agent完善建议.md`，来源为用户指定的 Obsidian 文档。报告未提供两仓库的 commit SHA。
- Slide：远端 main 与本地 `40-Slide-main-runtime` 均为 `07b3e6ce458b0b4576d356a97d78ab17df3ddd66`。核验相关源码无未提交变更；该 checkout 的 AGENTS.md 有已有修改。
- 当前交付目录 `40-Slide` 是 `fix/max-41-readable-colors@5a742967`，落后于 main。不能用此分支否定 main 已合并的事务 completion / 请求 settlement 改进。本文全部 Slide 源码结论指向上述 main。
- ZCode：只读下载并核验 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，Apache-2.0。仅借鉴设计；若未来复制代码，须保留许可和归属。
- 已完成静态链路检查、四个使用真实 AgentRunner 的本地确定性复现、4 个现有测试文件共 33 项测试。未调用付费模型、未操作真实业务库，未证明线上故障由同一版本触发；没有运行 ZCode 性能或质量基准。
- 范围为报告确认、完整实施计划与 Multica 建单，未实施 runtime 功能、发布或变更运行配置。硬预算未设定；本次子代理 0、最大代理深度 0；真实 input/cached input/output/费用遥测不可用，不以估算冒充实测。

## 2. 逐项确认与修正

| 报告判断 | 结论 | 核验与修正 |
|---|---|---|
| runner 同时承担状态、模型、工具、恢复、上下文和终态 | 确认 | `runner.ts:113` 起的 run 与同文件工具、checkpoint、裁剪辅助函数耦合；显式状态和可测试决策边界有价值。文件大本身不是重写理由。 |
| 默认整轮 120 秒会打断正常任务 | 确认默认行为，线上归因待证 | limits 默认 120000ms；WS chat、invoke、subagent 都有计时器。交互式长任务可改 optional deadline；Cron 的业务 deadline 应保留。 |
| 无工具非空文本直接当 completed | 确认 | 初始 stopReason=completed；最终普通文本不经独立有效性检查即追加到 messages。确定性复现成立。 |
| Slide 没有文本复读检测 | 确认所查 runtime 路径 | 未发现文本/跨步骤复读检测。已有的是工具连续相同签名 guard；不同参数会重置 streak，A/B/A 交替不等于同一连续序列。 |
| ZCode 有状态化 loop、异常提醒和 compact tracking | 确认 | RegularTurnLoopState、while loop、ModelAnomalyWarning、rapid-refill breaker 均有真实实现。 |
| ZCode 有可靠的业务完成验证器 | 不成立 | `finishModelStepWithoutToolCalls` 先持久化 assistant，再处理 guide / Stop hooks，然后 success；未发现通用“业务已完成”证明器。它提供更好的边界，不保证答案正确。 |
| ZCode 有独立异常 supervisor | 部分确认 | 真实实现是 helper + turn 方法 + 事件，而不是报告建议的统一 RuntimeSupervisor 类。Slide 可采用组合模块，无须照抄类层级。 |
| ZCode 消除了所有硬限制 | 不成立 | 它仍有 continuation 上限 3、stream recovery 上限 10、rapid-refill 次数限制等。for 改 while 本身不会提高能力。 |
| 去掉默认 120 秒即可支持 30 分钟 | 不充分且有风险 | streaming 在 runner 外层 timeout=0；OpenAI idle 默认可能未设置，Anthropic adapter 未消费 streamIdleTimeoutS。须先补模型/流/工具边界、预算和取消收敛。 |
| maxIterations 应降级为保险丝 | 有条件采纳 | 保留明确配置与兼容含义；新 chat policy 可允许 >40 步，但仍有有限 model/tool/recovery 预算。工具 heartbeat 不能无限续命。 |
| 现有 error 只有字符串 | 部分准确 | run result 主要 string；LLMResponse 已有 errorKind/errorCode/providerStatus，normalizeProviderError 已做认证、网络等归类。应保留原码，增加 runtime 分类，不另造丢信息的包装。 |
| 现有 checkpoint 已能恢复并防重放 | 部分准确 | 会还原已完成结果、补 interrupted 标记；这不是 durable TurnState 自动续跑，也不能保证任意外部副作用 exactly-once。必须保留审批 intent / 幂等及不确定执行状态。 |
| Context 应成为一等模块 | 采纳 | microcompact/snip 等现有能力保留；增加统一预算、真正摘要、来源边界和 rapid-refill。当前约 4 chars/token 为粗估，不能冒充中文/多模态精确计量。 |
| 必须等完整骨架重构后才能修复复读 | 不采纳为硬前提 | 建议小步抽出 completion/state seam 后立即落地 guard；无需先实现报告列出的所有抽象。 |
| 4 个 PR 顺序固定 | 调整 | 先基线与骨架，再 completion、recovery、context，之后放宽 lifecycle，最后真实集成和灰度验收；每个阶段独立可回退。 |

## 3. 可重复的行为证据

复现脚本和 JSON 结果位于本目录。脚本仅使用 mock provider 和空 registry，但运行的是 main 的真实 AgentRunner；不存在外部模型或数据库副作用。

```bash
SLIDE_REVIEW_ROOT=/Users/max/Coding/40-Slide-main-runtime \
  /Users/max/Coding/40-Slide-main-runtime/apps/db-ops-api/node_modules/.bin/tsx \
  /Users/max/Coding/40-Slide/docs/reviews/2026-09-28-agent-runtime/probe.mts
```

| 复现 | 输入 | 实测结果 | 要求的行为 |
|---|---|---|---|
| repeated_text_accepted | 同一行重复 20 次，finish=stop | 1 次请求，completed；坏文本进入 messages | candidate 被拒绝，有界恢复，耗尽后失败 |
| length_exhaustion_accepted | 连续 4 次 length | 4 次请求后 completed，只有第四段 finalContent | partial + OUTPUT_LIMIT，绝不伪装成功 |
| continuation_final_drops_prefix | 第一段 length，第二段 stop | finalContent 仅第二段；messages 有两段 | 合并合法续写，最终结果和历史一致 |
| empty_finalization_length_bypasses_recovery | 两次空，补救返回 length | 第 3 次请求后 completed | 所有补救结果重新经过同一 classifier 和 final guard |

已运行：

```bash
cd /Users/max/Coding/40-Slide-main-runtime
pnpm --filter @slide/agent-core exec vitest run \
  src/__tests__/runner-lifecycle.test.ts src/__tests__/runner-checkpoint.test.ts \
  src/__tests__/runner-timeout.test.ts src/__tests__/runner-resource-lifecycle.test.ts
```

结果：4 files / 33 tests passed，Vitest 4.1.8，测试执行约 1.06 秒。说明现有取消、checkpoint 和 guard 基线可复用，**不代表上述新需求已通过**。未运行无关完整 gate。

## 4. 必須纳入计划的集成风险

1. **流式拒绝边界**：`mapHookEventToChatEvent` 累加所有文本；`runChat` 在失败时读取 streamHolder；`ChatResponse` 用 `||` 回退旧缓存。只清空 runner.finalContent 仍会把拒绝内容带入 session/DB/UI。候选 attempt 必须可撤销，显式空串必须覆盖旧缓存，坏候选不再进入后续 prompt。用户可能已看到 provisional stream，不能承诺从未显示，只能保证撤回与不作为最终结果保存。
2. **子代理完成误报**：`subagent-manager.ts:182` 无条件写 completed，未检查 result.stopReason。它直接阻塞统一终态验收，应在本范围修复；不得顺势重写整个多代理系统。
3. **取消不等于底层执行已结束**：main 的 `onProviderRequest` 与 Cron `executionSettled/cancellationPending` 是最近的可靠性改进（关联 MAX-52），必须保留。非合作工具超时后不得释放执行所有权并重放副作用。
4. **checkpoint 只是历史物化**：当前 runChat 在构建 contextMessages 后才 restore checkpoint，且注释“成功后清理”对应的代码并未按 stopReason 限制。迁移时必须让恢复先于 context build，按阶段与终态保留/清理，增加实际恢复链路测试。
5. **真正 completion 在事务边界**：runtime 返回 response-ready 后，只有 AgentRunService.complete 的持久化事务提交成功才能向用户发布最终 completed。storage pending 仍应可恢复，禁止第二套终态写入。
6. **No-progress 不是没有 token/工具次数少**：只读轮询得到新状态、审批等待和长工具实际进度不应误伤；相同结果和重复心跳也不能不断重置预算。跨步骤指同一 run 的 model steps；不同用户 turn 的相似问题不互相惩罚。
7. **拒绝与失败分开**：APPROVAL_REQUIRED 是受阻并等待操作的业务状态，不能当模型异常自动重试；鉴权失败、审批过期、拒绝、凭据已消费、副作用结果不确定都不进入盲目重试。

## 5. 精确源码锚点

下列链接固定 commit，避免后续 main 变化导致行号失真：

- [Slide runner 与默认 completed](https://github.com/max2055/Slide/blob/07b3e6ce458b0b4576d356a97d78ab17df3ddd66/packages/agent-core/src/runner.ts#L113)
- [Slide candidate / empty / length 路径](https://github.com/max2055/Slide/blob/07b3e6ce458b0b4576d356a97d78ab17df3ddd66/packages/agent-core/src/runner.ts#L321)
- [Slide streaming request 边界](https://github.com/max2055/Slide/blob/07b3e6ce458b0b4576d356a97d78ab17df3ddd66/packages/agent-core/src/runner.ts#L473)
- [Slide context snip](https://github.com/max2055/Slide/blob/07b3e6ce458b0b4576d356a97d78ab17df3ddd66/packages/agent-core/src/runner.ts#L925)
- [Slide repeated tool guard](https://github.com/max2055/Slide/blob/07b3e6ce458b0b4576d356a97d78ab17df3ddd66/packages/agent-core/src/runner.ts#L1178)
- [Slide runtime limits](https://github.com/max2055/Slide/blob/07b3e6ce458b0b4576d356a97d78ab17df3ddd66/apps/db-ops-api/src/security/agent-runtime-limits.ts#L26)
- [Slide transactional completion](https://github.com/max2055/Slide/blob/07b3e6ce458b0b4576d356a97d78ab17df3ddd66/apps/db-ops-api/src/adapter/agent-run-service.ts#L44)
- [Slide stream / session persistence](https://github.com/max2055/Slide/blob/07b3e6ce458b0b4576d356a97d78ab17df3ddd66/apps/db-ops-api/src/adapter/direct-adapter.ts#L844)
- [Slide subagent terminal](https://github.com/max2055/Slide/blob/07b3e6ce458b0b4576d356a97d78ab17df3ddd66/apps/db-ops-api/src/agents/subagent-manager.ts#L145)
- [Slide Cron actual settlement](https://github.com/max2055/Slide/blob/07b3e6ce458b0b4576d356a97d78ab17df3ddd66/apps/db-ops-api/src/cron/cron-executor.ts#L63)
- [ZCode TurnState](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/turn-loop-state.ts#L76)
- [ZCode TurnLoop](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts#L43)
- [ZCode tool anomaly](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/helpers/model-anomaly.ts#L21)
- [ZCode no-tool stop](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/turn-stop.ts#L157)
- [ZCode output continuation](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/turn-output-token-continuation.ts#L18)
- [ZCode stream recovery](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/streaming-recovery.ts#L20)

## 6. 方案取舍

| 方案 | 收益 | 代价/局限 | 决策 |
|---|---|---|---|
| runner 内追加 detector | 最短修复路径 | 仍不能解决流式污染、终态和多种恢复组合 | 仅保留“小步抽出 guard 接缝”的思想 |
| 渐进拆分 state / supervisor / context | 复用成熟工具/业务能力，可逐段验证回退 | 需要完成 adapter、history、policy 集成 | 推荐 |
| 移植 ZCode / 全量重写 | 可获得更多 Coding Agent 功能 | 复杂度、许可证集成、业务安全兼容成本高；没有能力提升实测保证 | 不采用 |

配套计划：`docs/superpowers/plans/2026-09-28-agent-runtime-improvement.md`。验收重点是错误终态、数据一致性和有界长任务，文件数量、类名和 while loop 不作为能力指标。
