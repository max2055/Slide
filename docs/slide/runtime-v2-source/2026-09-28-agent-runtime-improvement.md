# Slide Agent Runtime 能力提升实施计划

> **Execution:** Follow this plan within existing authorization and repository rules; use executing-plans when useful. Track task dependencies and acceptance evidence. Delegate only when useful and authorized.

**Goal:** 消除复读/截断被误判为完成，建立有界恢复、上下文治理与可取消的长任务能力，同时保留 Slide 的审批、幂等、checkpoint 和事务完成保障。

**Architecture:** 保留 AgentRunner 兼容入口，逐步抽取 TurnState、TurnLoop、CompletionSupervisor、RecoveryPolicy 与 ContextManager。runtime 只认定响应就绪，AgentRunService 仍是持久化 completed 的唯一权威；业务任务成功必须依据已有结构化执行证据。

**Tech Stack:** TypeScript、Vitest、Lit、Fastify、WebSocket、现有 Anthropic/OpenAI/Ollama provider abstraction、MySQL、现有 session/checkpoint 与工具审批/幂等机制。

---

## 0. 执行契约与基线

计划版本 v1，2026-09-28。源码基线：Slide `07b3e6ce458b0b4576d356a97d78ab17df3ddd66`；参考 ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。开始实施时记录实际 main SHA 与相对基线差异，保持以下兼容决定；不得在旧的 `fix/max-41-readable-colors` 上覆盖 main 已有修复。

范围：agent-core orchestration 与直接相关的四种调用入口、流式显示/历史、provider 超时、恢复计数、上下文压缩和集成验收。新工作仅因直接阻塞验收、已确认数据损坏风险或本次触达安全问题而进入范围。

排除：直接移植 ZCode、换模型供应商、任意自动模型 fallback、每轮 LLM judge、全面语义正确性判定、通用多代理平台重写、数据库业务工具全面重写、外部系统 exactly-once 承诺、无关界面重设计、MAX-84 的 TLS/WSS 基础设施整改和 MAX-85 的 Metrics V2 发布。

开发中运行 focused checks；阶段边界运行受影响模块测试；最终候选统一跑完整既有 gate 和本计划资格测试。未具备真实环境的验证明确为未完成，不能用单元测试代替。

硬预算：未设定。工期仅为估算：熟悉项目的 1 名开发者约 16–24 个工作日，真实环境准备与审批等待另计，不构成预算或排期承诺。没有真实 token/费用遥测时标记不可用。委派默认 0，确有独立任务再遵守 AGENTS.md 的深度/并发/总量约束。

停止/回退条件：出现重复副作用、已拒绝候选被写为最终答案、重复事务 completion、审批绕过、取消后新操作或旧 checkpoint 无法安全恢复，立即停止该批放量并切回上一已验证 policy。环境缺失只阻塞相应真实验收；不得扩成无关重构。

## 1. 核验结论与成功标准

现有 runner 在普通非空无工具文本上缺少有效性边界。确定性复现还确认连续 4 次 length 后 completed、续写只保留尾段、空响应补救绕过 length 判断。详情和 pinned links 见 `docs/reviews/2026-09-28-agent-runtime/review.md`。

ZCode 提供状态、Stop hooks、异常提醒和 compact 生命周期参考，但不提供“模型说完即业务正确”的保证。FinalGuard 负责可判定的格式/退化/资源与工具状态，业务结果沿用结构化证据；不得以文本相似度推断写操作已经成功。

| ID | 最终可验证标准 |
|---|---|
| A1 | 四个基线复现全部转为正确行为；拒绝的候选不进入最终 session/DB/history、重连结果或下一次 provider context。 |
| A2 | 冻结评测集中高置信复读全部拦截，至少 200 个正常答案误拒不超过 1%；正常中文短答、SQL、表格、JSON、日志和合法重复指令有明确样本。 |
| A3 | 受控 chat 在无显式 run deadline、其他预算足够时运行超过 120 秒且超过 40 个 model steps 后成功；用户取消与显式 deadline 均有效。 |
| A4 | 模型、流空闲、工具、恢复、资源预算均独立生效；长期有 token/heartbeat 也不能越过预算。 |
| A5 | length 续写完整；空响应/流失败/context overflow 使用有界恢复；401/403、审批拒绝/过期、已消费凭据、不确定副作用不盲重试。 |
| A6 | checkpoint 旧版本可读；恢复不重放已完成或不确定副作用；预算不因压缩/恢复重置；不序列化 AbortSignal/Promise/秘密。 |
| A7 | chat/invoke/subagent/cron 的 completed、partial、cancelled、timed_out、failed 一致；completion pending 重试只产生一条最终消息。 |
| A8 | trace 能串联 run/turn/model step/tool/recovery/compact/持久化完成，事件和指标脱敏、有界；所有必要 gate 和真实集成证据齐备。 |

## 2. 最小设计与兼容契约

### 2.1 组织方式

不预先建立报告建议的整棵类层级，先引入有独立行为的模块：

| 文件（相对仓库根） | 责任 |
|---|---|
| `packages/agent-core/src/runner.ts` | 兼容 façade；保留 run、setProvider、getDefaultModel、runTool 和旧 checkpoint 方法。 |
| `packages/agent-core/src/runtime/agent-runtime.ts` | 组合依赖，创建一次 run，返回 legacy result + 可选 resolution。 |
| `packages/agent-core/src/runtime/turn-state.ts` | 可序列化状态、版本、纯 transition 与不变量；初期无需独立 turn-machine 类。 |
| `packages/agent-core/src/runtime/turn-loop.ts` | 驱动 model → tools/candidate → recovery/terminal；不承载检测算法。 |
| `packages/agent-core/src/runtime/model-step.ts` | provider 请求、usage、signal、stream callbacks、settlement 跟踪。 |
| `packages/agent-core/src/runtime/tool-executor.ts` | 复用现有 runTool/partitionToolBatches，保持原有顺序与 concurrencySafe/exclusive。 |
| `packages/agent-core/src/runtime/checkpoint.ts` | 旧格式兼容、版本化 state snapshot 与恢复验证。 |
| `packages/agent-core/src/runtime/supervisor.ts` | 统一候选、预算、取消和完成决策。 |
| `packages/agent-core/src/runtime/anomaly-guard.ts` | 组合文本、工具连续签名、同 run 跨步骤无进展信号。 |
| `packages/agent-core/src/runtime/text-repetition.ts` | 有界确定性文本检测；不额外调用模型。 |
| `packages/agent-core/src/runtime/recovery-policy.ts` | 错误分类、恢复计数、退避和重试可行性。 |
| `packages/agent-core/src/runtime/output-continuation.ts` | 保留和合并截断片段，隔离 continuation prompt。 |
| `packages/agent-core/src/runtime/context-manager.ts` | 原治理函数、预算预检、原子工具消息组。 |
| `packages/agent-core/src/runtime/auto-compact.ts` | 有界摘要请求与历史 projection 替换。 |
| `packages/agent-core/src/runtime/rapid-refill.ts` | 压缩后快速回填检测。 |
| `packages/agent-core/src/runtime/contracts.ts` | RuntimePolicy、Resolution、Error、Event 的公共增量契约。 |

`src/context.ts` 继续负责 ContextBuilder/bootstrap/skills，不与模型历史压缩重复；`src/types.ts` 和 `index.ts` 增量导出，旧调用保持可编译。使用绝对工作目录运行本计划命令；表中路径供不同 checkout 定位。

### 2.2 State 与终态

建议契约（设计代码，不是现有 API）：

```ts
type TurnPhase = 'preparing' | 'model_running' | 'tools_running'
  | 'candidate_final' | 'recovering' | 'response_ready' | 'terminal';
type RecoveryKind = 'empty' | 'continuation' | 'stream' | 'repetition' | 'context';
interface TurnState {
  schemaVersion: 1;
  runId: string; turnId: string; traceId: string;
  phase: TurnPhase;
  modelSteps: number; providerAttempts: number; toolCalls: number;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number;
    unknownRequests: number; estimatedReservedTokens: number };
  recoveries: Record<RecoveryKind, number>; totalRecoveries: number;
  candidate: null | { attemptId: string; content: string; finishReason: string };
  progress: { epoch: number; lastMeaningfulAt: number; stalledSteps: number };
  context: { compactCount: number; toolBatchesSinceCompact: number; rapidRefills: number };
  // checkpoint 仅存脱敏摘要/安全指纹，不存原始敏感 tool 参数。
  recentTextFingerprints: string[];
}
interface RunControl {
  signal: AbortSignal;
  deadlineAt?: number;
  // promises / abort controllers 仅驻内存，绝不随 checkpoint 序列化。
  observeProviderRequest(request: Promise<unknown>): void;
  observeToolRequest(request: Promise<unknown>): void;
}
type RuntimeResolution = {
  kind: 'response_ready' | 'partial' | 'cancelled' | 'timed_out' | 'failed';
  reasonCode: string;
  retryable: boolean;
  safePartialContent?: string;
};
```

顺序：preparing → model_running → tools_running / candidate_final → recovering / response_ready / terminal。任何阶段都能取消或预算终止。新 injection 在最终提交前触发下一 model step；拒绝候选不得因为 injection 被追加进 messages。

`response_ready` 仅表示通过 runtime guard。兼容期 AgentRunResult.stopReason 可继续返回 `completed`，同时携带 `resolution`；外层仅在 AgentRunService.complete 事务提交后发 durable complete。runtime 不写业务数据库，不增加第二套 completion 事务。

| Resolution / 典型 code | legacy stopReason | 持久化/调用入口状态 |
|---|---|---|
| response_ready / VALID_FINAL | completed | 提交前 running；事务后 completed |
| partial / OUTPUT_LIMIT、RESOURCE_BUDGET、MAX_MODEL_STEPS、APPROVAL_REQUIRED | max_iterations（兼容）+ 精确 resolution | partial；展示真实原因，不谎称轮次耗尽 |
| cancelled / USER_CANCELLED | cancelled | cancelled |
| timed_out / RUN_DEADLINE、MODEL_REQUEST_TIMEOUT、STREAM_IDLE_TIMEOUT、TOOL_TIMEOUT | timed_out | timed_out |
| failed / MODEL_REPETITION_LOOP、PROVIDER_AUTH、CONTEXT_UNRECOVERABLE、APPROVAL_DENIED | error（兼容）+ 精确 resolution | failed |

内部重试成功后才产生 response_ready；error 字符串仅作展示，decision 读取 code/source/retryable。结构化业务失败不必自动终止整个回答，允许模型说明阻塞；需要业务成功的 outputSchema / 现有分析完成工具必须检查其明确结果。

### 2.3 Candidate 与流式历史

- 每个模型请求分配 attemptId，流式文本是临时候选；thinking 通道保持独立，检测默认只看正文。
- 基于已接受片段 + 当前 attempt 形成累积快照。guard 拒绝时撤回当前 attempt，hook 增加可选 `onCandidateRejected`；DirectAdapter 发兼容的 `text_delta` 累积快照（允许空串）清除 UI/cache，必要时附加 attemptId/revision。
- 更新 ChatResponse、gateway/controller 的空串覆盖逻辑及 flush 队列，丢弃过期 attempt/revision；事件通过已有有序 transport 分发。不能用 `newValue || oldValue` 恢复坏候选。
- provisional 文本可能已显示，拒绝后必须清除；不得把它标为 completed 或作为下次模型 history。合法被取消 partial 可保留，但必须有 interrupted/stopReason 标识。
- 被拒绝文本不写普通会话、最终 DB 消息、checkpoint 原文；审计只记录检测类别、计数、长度和脱敏证据摘要。临时恢复 reminder 只存在 provider projection。
- guard 拒绝后若落入 catch/取消/保存失败，fallback 也只能读 safePartialContent；测试覆盖全部退出路径。

### 2.4 检测与真实 progress

首版 deterministic：Unicode 正规化与空白整理，保留数字/SQL 关键差异；行/段重复覆盖率、局部 n-gram、最近最多 8 个当前 run 文本指纹。只分析至多 100k 字符的有界输入，长文本分窗，禁止对全部历史做平方级比较。

初始实验参数：至少 3 个重复块且覆盖率 >55%；跨 step 相似度 >92% 仅产生 warning，必须与无新证据/重复结果结合才拒绝。三者是可校准配置，不是生产真值。短答、代码块、表格、JSON、日志和用户明确要求重复的内容需要负样本和上下文豁免，不能以“相似”一票否决。

工具 guard 保留现有连续相同参数阈值 5 和不同参数可执行的行为；工具总量 warning 与硬预算分开。补充 A/B/A 交替重复且结果不变的无进展样本，但不改变单次业务拒绝的含义。

progress 为新工具证据/资源状态变化、明确完成工作项或可信工具进度推进；普通 token、调用计数、无变化 heartbeat、重复日志和“我正在分析”均不能无限重置预算。只读轮询有等待间隔/次数上限，进度信号不绕过 model/tool deadline。审批等待走既有审批生命周期；不发出自动确认，不重复消费审批。

### 2.5 Recovery 与副作用

- repetition：首次拒绝后一次 reminder 恢复；第二次拒绝后清理坏候选再试；第三次拒绝耗尽，MODEL_REPETITION_LOOP。最多两次额外请求，不自动换模型。
- empty：最多两次补救；补救返回结果经过同一 classifier/guard，不能直接赋 finalContent。
- continuation：最多三次续写；按片段顺序合并 finalContent，仅删除完全相同的边界重叠，不做语义改写。再次 length 后 OUTPUT_LIMIT/partial；continuation marker 不进入持久历史。
- stream：暂态网络/429/5xx 在安全锚点最多两次 runtime 恢复；退避 1s、2s，尊重可解析 Retry-After 且不超过剩余 deadline。provider transport 单次最多两次额外尝试；二者计数同一个 providerAttempts 和总恢复预算，禁止嵌套乘法失控。
- context：每次模型 step 最多一次 reactive compact，且计入 run 全局压缩与恢复预算。压缩不能重置其他计数。
- 每 run 默认总恢复上限 8，达到立即准确终止；上述分类上限不能互相绕过。配置可收紧，放宽需显式 policy。
- 401/403、无效参数、审批拒绝/过期、单次 credential_ref 消费、副作用执行结果不确定均不自动原样重试。provider 原始 status/errorCode 与 runtime code 同时保留。
- 工具启动前持久化 intent，已有完成结果复用；副作用超时只标不确定并保持隔离/占用，需既有 execution record 对账，不能靠 Promise.race 声称停止或重新发出工具。
- 已发出的迟到 delta/result 按 attempt/revision 丢弃；真实 request settlement 仍被跟踪。取消后不启动后续恢复、摘要和工具。

### 2.6 ContextManager

- prepare 顺序：规范化 tool call/result 配对 → 原 microcompact → 工具结果限额 → token 预算预检 → 必要 autoCompact → 再验证配对与预算 → provider projection。
- 三层分离：完整 session/audit；有限 provider history；当前临时候选/恢复 marker。压缩不覆盖原始审计、不把业务 tool 文本提升为 system 指令。
- 必须保留当前 user 目标、system/权限约束、未完成事项、已完成动作与 evidence 引用、审批/不确定操作状态、最近完整 tool batches。结构化 pins 从权威状态重建，不能由模型摘要修改授权事实。
- token 预算覆盖 system、tool schemas、messages、图片估算、输出预留和 safety buffer。可用 provider tokenizer 则用；否则保守估算并标 estimated，不能把 char/4 当实测。单条/system/tool schema 无法容纳时明确 CONTEXT_UNRECOVERABLE，不能悄悄发送越界 context。
- autoCompact 用同一 provider abstraction，默认 model 不切换、tools=[]，有 request/idle deadline 与 maxTokens，usage 纳入总账。摘要含 goal/constraints/evidence/done/pending/uncertain；结构化验证失败或取消时不提交新 projection，保留旧记录并明确错误。
- proactive watermark 初始按可用输入预算 80%，压缩后目标 <=50%；两者可配置并经样本校准。已完成摘要以 schemaVersion + source message range/hash 绑定，原子替换 projection。
- rapid refill：成功压缩后不足 3 个完整 tool batch 又需压缩记一次；连续 3 次触发 breaker。第一次压缩不计异常；正常间隔重置 streak，但 compactCount/总预算单调增加。
- 每 run 最多 4 次摘要请求，同时受总恢复预算 8 限制。工具超大结果优先分页/现有截断；不得为压缩而重执行副作用。

### 2.7 Lifecycle 与配置迁移

**先完成阶段 2–4，再开放长任务 policy。** 仅 interactive chat 的默认全局 deadline 可以缺省；invoke、subagent、Cron 默认仍为有界业务执行。所有入口接收已解析 policy，避免四份分散常量。

- 新配置 `AGENT_CHAT_RUN_TIMEOUT_MS`：缺省在 long-task policy 下表示无整轮 deadline；显式值为正整数。旧 `AGENT_RUN_TIMEOUT_MS` 仍被所有入口尊重，若两者同时存在则 chat 使用更具体的新值，并记录 policy 来源。非法、负值不解释为“无限”，启动校验应报清晰配置错误；原 legacy 模式保持原 fallback。
- 现有 `AGENT_MAX_ITERATIONS` / spec.maxIterations 是明确限制，不能悄悄失效。新 long-chat 默认 maxModelSteps=200、maxToolCalls=500、providerAttempts<=600，同时受真实/保守预留 token 预算；默认 total token 预算 1,000,000 为待灰度校准值，不是实测成本结论。
- interactive chat 的 request wall-clock 默认 300s、stream idle 60s；工具执行默认 60s，工具已声明更严格边界优先，允许经服务端验证的具体工具覆盖。审批等待不占用工具 handler 执行计时，仍受审批 expiry/显式 run deadline。
- invoke 保留 120s/8 步默认；subagent 保留 120s/25 步默认，可由父任务显式传入更紧或获准的长任务 policy，子额度不得超过父剩余额度；Cron 保留 job.timeout_seconds（默认 300s）和当前 40 步上限。不能因 chat 默认改变而误放开所有后台任务。
- inputTokens 已含 cachedInputTokens，total=inputTokens+outputTokens；续写、retry、compaction 都记账。SDK 未返回 usage 的请求不能算 0 成本，保留 estimated reservation 和 unknownRequests；有限 token budget 按保守上界消耗，不能因未知用量获得无限额度。
- 取消/时限抵达立即停止调度，合作操作收到 abort；非合作操作进入 pending settlement，保留 actor/session/cron 所有权或明确隔离，不允许同资源新副作用与之重叠。真正驱动取消必须验证，不能仅测试 signal.aborted。

### 2.8 Checkpoint / Event / Rollout

旧 checkpoint 继续支持 assistant_message/completed_tool_results/pending_tool_calls；新增可选 runtime_state_v1。新 reader 先读旧消息字段，再校验 state。旧 unknown version 不自动续跑副作用，保留可审计的中断状态。AbortSignal、Promise、凭据、原始敏感签名绝不落盘；安全 fingerprint 使用 run-scoped HMAC，持久化时不暴露密钥或可枚举秘密。

恢复先于 context build；恢复工具状态、recovery/usage/compact 计数后再请求模型。恢复不等于自动重放 pending tools。terminal 和 checkpoint 的保留/清理规则必须由 resolution 决定。

事件：schemaVersion、eventId、runId、turnId、traceId、step、attemptId、monotonic sequence、timestamp、kind、脱敏 payload。最少覆盖 model.request、candidate.accepted/rejected、anomaly、recovery、context.compact、tool、runtime.resolved；durable run.completed 仍由原事务路径写。按 provider/model/reason 聚合，指标标签不包含 runId、SQL、用户文本和秘密；trace 才使用关联 ID。事件队列有界，异常检测只存有限摘要，不建第二套全量对话日志。

兼容 rollout 配置建议：`AGENT_RUNTIME_SUPERVISOR_MODE=off|observe|enforce`、`AGENT_RUNTIME_CONTEXT_MODE=legacy|observe|auto`、`AGENT_RUNTIME_LONG_CHAT=false|true`，在一次 run 开始时固定，不中途切换状态机。observe 只记录检测，不新增模型请求，不再次执行工具。legacy 回退是行为 policy 回退，不能假定旧二进制安全消费所有新状态。

## 3. 任务划分、文件迁移与验收

依赖：T1 → T2 → T3 → T4 → T5 → T6。T3/T4 文件边界清楚后可做独立开发，但集成与放量保持顺序；不要对同一 runner 并行重复重构。

### T1：基线夹具与 Runtime 状态骨架（预计 3–4 日）

**文件：** 修改 `packages/agent-core/src/runner.ts`、`types.ts`、`index.ts`；新增 `runtime/{agent-runtime,turn-state,turn-loop,model-step,tool-executor,checkpoint,contracts}.ts`；新增 `src/__tests__/runtime-compatibility.test.ts` 和 `runtime-state.test.ts`；在四个既有 runner 测试文件补充迁移契约。

迁移映射：run 的局部变量 → TurnState；run 驱动 → TurnLoop；withTimeout/requestModel/requestFinalizationRetry 的调用边界 → ModelStep；runTool/executeTools/partitionToolBatches → ToolExecutor；checkpoint restore 与 emitCheckpoint → checkpoint；注入顺序暂随 TurnLoop；原 context helper 暂留原模块或仅委托，行为不改。

- [ ] 固定 current main SHA、四个复现输入及 expected legacy outputs，记录 hook、message、usage、checkpoint 事件序列。
- [ ] 为 compatibility tests 写上述正常/异常行为断言，包括 setProvider/getDefaultModel、公开 runTool、旧 checkpoint、并发顺序、thinking、mid-turn injection 和 onProviderRequest 实际 settlement。
- [ ] 提取 state/loop/executor，禁止空 provider 的临时 AgentRunner；通过依赖传入 executor。先只迁移，不同时改变默认时限/阈值/完成行为。
- [ ] transition 验证非法状态转移；计数单调、signal 分离、checkpoint roundtrip 无凭据。
- [ ] 跑 focused checks，再跑 agent-core 模块 test/typecheck；提交这一可单独审阅的结构迁移。

验收：原 33 项测试通过、新增 compatibility trace 与基线一致，全部公开入口可用，没有新模型请求、没有默认行为变化；已知复现缺陷作为 legacy fixture 明确标记，不能命名成“正确业务结果”。

```bash
pnpm --filter @slide/agent-core exec vitest run src/__tests__/runtime-compatibility.test.ts src/__tests__/runtime-state.test.ts src/__tests__/runner-lifecycle.test.ts src/__tests__/runner-checkpoint.test.ts src/__tests__/runner-timeout.test.ts src/__tests__/runner-resource-lifecycle.test.ts
pnpm --filter @slide/agent-core typecheck
pnpm --filter @slide/agent-core test
```

### T2：Candidate Final、复读监督与历史隔离（预计 3–5 日）

**依赖：** T1。

**文件：** 新增 `runtime/{supervisor,anomaly-guard,text-repetition}.ts`；修改 runtime loop/contracts 与 `types.ts`；修改 `apps/db-ops-api/src/adapter/{direct-adapter,chat-response,types,agent-run-service}.ts`（service 只补终态防线，保留事务）；修改 `apps/db-ops-api/src/agents/subagent-manager.ts`；修改 `frontend/src/app/ui/direct-gateway.ts`、`controllers/chat.ts`。新增 `runtime-supervisor.test.ts`、`text-repetition.test.ts`、`apps/db-ops-api/src/adapter/__tests__/candidate-final.test.ts`；扩展原 gateway、subagent、run-service tests。

- [ ] 先写 repeated_text_accepted 的失败回归以及合法重复负样本，覆盖空白/短中文/SQL/JSON/日志/表格/用户要求重复。
- [ ] 所有无工具响应先分类 candidate，检查 finish/error/未决副作用；同 run 复读与无进展组合判定，工具 guard 既有连续签名行为不变。
- [ ] 按 §2.5 实现最多两次 repetition 恢复，所有补救仍回到 classifier；不引入 LLM judge 或模型切换。
- [ ] attempt 拒绝清理 provisional stream，显式空串覆盖 ChatResponse/UI fallback，连同 catch、取消、DB error、重连 history 和 injection 路径验证。
- [ ] 子代理按 resolution/stopReason 映射真实状态，非 completed 不可写 completed；原 registry 只有较少状态时映射 failed 并保留精确 reason，不能伪造 success。
- [ ] 对 completion_pending / transaction fail / replay 增加断言，只发布一个 durable completion；observe 模式无额外模型或工具请求。
- [ ] 冻结至少 200 个正常和明确标注的高置信异常样本，输出按类型误拒/漏检表，再跑模块 gate。

验收：A1 中复读路径闭环；A2 达标；坏候选在内存/文件 session、DB、WS 重连、下次 context 中均不存在；精确 reason 可见且终态不重复。guard 通过只代表可接受回复，不宣称任务语义必然正确。

```bash
pnpm --filter @slide/agent-core exec vitest run src/__tests__/runtime-supervisor.test.ts src/__tests__/text-repetition.test.ts
pnpm --filter slide-api exec vitest run src/adapter/__tests__/candidate-final.test.ts src/adapter/__tests__/agent-run-service.test.ts src/agents/subagent-manager.test.ts
pnpm --filter slide-frontend exec vitest run src/app/ui/direct-gateway.test.ts
```

### T3：统一恢复、续写与执行收敛（预计 3–4 日）

**依赖：** T2。

**文件：** 新增 `runtime/{recovery-policy,output-continuation}.ts`；修改 model-step/loop/checkpoint/contracts、`packages/agent-core/src/openai-provider.ts`、`apps/db-ops-api/src/adapter/llm-provider.ts`、`apps/db-ops-api/src/cron/cron-executor.ts`。按实际错误/所有权传播需要修改 `apps/db-ops-api/src/tools/policy.ts` 与 `security/agent-tool-approval-execution.ts`，不改既有审批语义。新增 `runtime-recovery.test.ts`、`runtime-settlement.test.ts`；扩展 runner-timeout 和 Cron security tests。

- [ ] 将其余三个复现写为失败回归，验证完整输出、非成功终态与补救统一分类。
- [ ] 建立 typed RuntimeError（code/source/retryable/recoverable/causeCode/providerStatus/attemptId），保留现有 provider 归一化字段；细分用户取消/显式时限/idle/认证/网络/输出限制。
- [ ] 实现 §2.5 分类/总预算，SDK retries 与 runtime retries 共享尝试账本；恢复 marker 仅存在 provider projection。
- [ ] 从 model boundary 实施两个 provider 一致的 request+idle timer，任何 model 请求（含空补救/未来摘要）都带 signal；finally 清理 listeners/timers。
- [ ] 保留并扩展真实 provider/tool settlement 观测；终态之后的迟到结果不能提交或发流；不确定副作用不重放/不自动退还审批。
- [ ] 版本化 checkpoint 保存可恢复计数；修正恢复先于构建上下文、按 terminal 安全清理的 adapter 接线。
- [ ] 测试恢复种类交替到总预算上限、取消发生在 backoff/stream/checkpoint、旧格式加载、非合作工具、同 job 防重叠。

验收：A1 全部四个复现正确，A5/A6 与 MAX-52 的 settlement 契约保持；续写结果与最终历史内容一致。恢复总预算无法通过换错误类型/压缩/重启清零。

```bash
pnpm --filter @slide/agent-core exec vitest run src/__tests__/runtime-recovery.test.ts src/__tests__/runtime-settlement.test.ts src/__tests__/runner-timeout.test.ts src/__tests__/runner-checkpoint.test.ts
pnpm --filter slide-api exec vitest run src/cron/cron-security.test.ts src/adapter/__tests__/direct-adapter.test.ts src/security/agent-tool-approval-execution.test.ts
```

### T4：ContextManager、摘要与快速回填熔断（预计 3–4 日）

**依赖：** T3 的统一请求/恢复预算。

**文件：** 新增 `runtime/{context-manager,auto-compact,rapid-refill}.ts`；迁移 runner 的 dropOrphanToolResults/backfillMissingToolResults/microcompact/applyToolResultBudget/snipHistory/estimate helpers；修改 `runtime/{turn-loop,turn-state,checkpoint}.ts`；新增 `src/__tests__/runtime-context.test.ts` 与 `runtime-compact.test.ts`。ContextBuilder 保持原用途。

- [ ] 先用长中文、超大单工具结果、巨大 tool schemas、多模态估算、缺失/孤儿 tool results、连续 compact fixtures 建失败测试。
- [ ] 按 §2.6 实施预算和原子消息组；把裁剪后仍越界、context governance 异常明确上报，禁止 catch 后静默发原始越界请求。
- [ ] 加有界 tools=[] 摘要请求，验证 goal/constraints/done/pending/evidence/uncertain，权威 pins 从结构化状态注入；原历史不可变。
- [ ] 只有成功持久化并校验来源范围/hash 的 summary 才替换 projection；失败/取消不半提交、不覆盖新用户输入。
- [ ] 实现首次压缩、正常间隔、连续 rapid refill 的区分，以及 run 总 compact/recovery budget。
- [ ] 比较压缩前后同一 fixture 的目标、权限、资源 ID、完成证据和不确定操作均保留；恢复不重新调用已完成工具。

验收：最终 provider 请求在预算内；无法容纳时明确失败；third rapid refill 命中；原 session/audit 可追溯且摘要不会提升工具文本权限；摘要成本/取消/重试全计入 run。

```bash
pnpm --filter @slide/agent-core exec vitest run src/__tests__/runtime-context.test.ts src/__tests__/runtime-compact.test.ts src/__tests__/context.test.ts src/__tests__/runner-checkpoint.test.ts
```

### T5：按入口开放有界长任务与配置迁移（预计 2–3 日）

**依赖：** T2/T3/T4 已通过，不能先删除 120s 保护。

**文件：** 修改 `apps/db-ops-api/src/security/agent-runtime-limits.ts`、其测试；新增 `apps/db-ops-api/src/adapter/runtime-policy.ts` 及测试；修改 `direct-adapter.ts`、`agents/subagent-manager.ts`、`cron/cron-executor.ts` / `cron-manager.ts`；修改 core tool-executor/contracts；新增 `src/__tests__/runtime-budget.test.ts`、API `runtime-lifecycle.test.ts`；补充脱敏 `.env.example`（以实施时实际配置模板为准）和 `docs/slide/AGENT-RUNTIME-GUARD-AUDIT.md`。

- [ ] 为 §2.7 的入口/新旧配置优先级写参数矩阵测试，明确缺省与显式值；legacy 模式默认保持原值。
- [ ] 新 chat policy 启用时允许无 run deadline，仍强制有限 steps/tools/provider attempts/token/recovery；invoke/subagent/cron 按各自业务默认边界运行。
- [ ] 正确聚合 input+output、cached 子集、摘要/续写/重试用量；未知 usage 的保守预留不可无声清零；子额度不能超过父剩余限制。
- [ ] fake clock 跑 130s/45 steps 的正常进展，再分别触发显式 deadline、model idle、tool timeout、无进展和每种预算；测试文字/heartbeat 持续输出也不能规避上限。
- [ ] 超时发 typed reason；实际资源未收敛前 actor/session/cron 并发所有权仍安全，Stop 后不得启动新业务操作。
- [ ] 更新四入口终态映射和配置文档，完成模块测试后才允许试验环境打开 LONG_CHAT。

验收：A3/A4/A7；已有显式限制不失效、Cron deadline 不改变、旧 env 有明确迁移路径；未证明底层已停止时不报“全部终止”。

```bash
pnpm --filter @slide/agent-core exec vitest run src/__tests__/runtime-budget.test.ts src/__tests__/runtime-settlement.test.ts
pnpm --filter slide-api exec vitest run src/security/agent-runtime-limits.test.ts src/adapter/runtime-policy.test.ts src/adapter/__tests__/runtime-lifecycle.test.ts src/agents/subagent-manager.test.ts src/cron/cron-security.test.ts
```

### T6：全链路资格验收、观测与灰度回退（预计 2–4 日）

**依赖：** T1–T5 全部完成。

**文件：** 新增 `tests/qualification/agent-runtime.ts`、`scripts/qualification/run-agent-runtime.sh`、`frontend/e2e/agent-runtime.spec.ts`、`docs/slide/agent-runtime-v2.md`；扩展 API run-service 的真实 MySQL 集成测试；更新 qualification coverage matrix/CI 精确接入必要门禁、runtime event 到既有 platform logs 的桥接。不新建通用监控平台。

- [ ] runner→DirectAdapter→WS→UI→history→AgentRunService 真实 MySQL 链路复现 candidate reject/recovery、length、cancel、deadline、storage pending/reconnect，并验证唯一最终消息。
- [ ] 四种入口按矩阵验收，不合作操作注入、crash 后恢复、并发 batch、审批失效/拒绝/已消费、同 messageId 重发、恢复预算不归零。
- [ ] 真实模型联调至少覆盖当前部署的 Anthropic、一个 OpenAI 兼容 provider（含部署实际使用的 Ollama 时纳入其版本），记录 provider/model/参数/请求 ID/usage；没有的 provider 写未验证，不伪称全覆盖。
- [ ] 30 分钟持续正常进展 soak 与 >40 步用可控服务/只读测试工具，另跑真实 provider 代表任务；不得制造无价值付费 token 消耗来凑时长。确认取消、连接/句柄/内存没有持续增长，无遗留执行。
- [ ] 建立 T2 样本评测及脚本化流故障重放；detector 对 100k 字符基准 p95 目标 <50ms，记录机器与数据，内存随窗口上限而非 session 长度增长。
- [ ] 事件/指标证明可关联每个 recovery/compact/final commit，秘密扫描和原始用户文本泄漏样本均为零；输出预算分解及正常任务额外请求率。
- [ ] 新 runtime 先 observe（至少 200 个代表 turn，不重复业务工具），再 enforce 小批 session（至少 100 个且观测 24h），之后 long-chat 试点，再放量。正常样本误拒<=1%；明确退化输出被标 completed=0；重复副作用/重复 durable final/权限绕过=0；正常短答无额外模型调用；p95 应用层额外延迟目标<=5%（不含网络波动，记录样本量）。
- [ ] 任一数据一致性/安全不变量失败立即回退；比例门槛失败停止放量、分析本范围原因。回退新 run 的 policy，等待或安全取消在途 run，保留旧/新 checkpoint 与业务审计；不能直接降级二进制后自动重放。
- [ ] 汇总 A1–A8 的命令、SHA、policy、环境、输出和证据链接；真实验证缺失的阶段不得标生产完成。最终候选只统一跑一次完整 gate，后续相关变更仅重跑受影响项。

新增资格入口需要 T6 同步实现，预定命令：

```bash
bash scripts/qualification/run-agent-runtime.sh --mode deterministic
bash scripts/qualification/run-agent-runtime.sh --mode mysql
bash scripts/qualification/run-agent-runtime.sh --mode soak --duration-seconds 1800
bash scripts/qualification/run-agent-runtime.sh --mode provider
pnpm --filter slide-frontend exec playwright test agent-runtime.spec.ts agent-cancellation.spec.ts --workers=1
```

脚本启动隔离测试服务与测试 schema；每次记录 PID→端口→cwd→启动命令→SHA→日志。provider 凭据由环境安全注入，不写文件/Issue；只用授权测试资源。清理只处理脚本创建的资源与进程。

最终代码门禁（当前脚本已存在；新增 qualification 入口另计）：

```bash
pnpm --filter @slide/agent-core typecheck
pnpm --filter @slide/agent-core test
pnpm --filter slide-api typecheck
pnpm --filter slide-api test
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend test
pnpm --filter slide-frontend build
pnpm --filter slide-sandbox-controller typecheck
pnpm --filter slide-sandbox-controller test
pnpm lint
pnpm contracts:check
pnpm qualification:matrix
pnpm security:audit
pnpm security:scan
```

另外按 `.github/workflows/ci.yml` 保持 browser、browser-qualification、recovery-qualification 及发布 gate；不因本计划只列核心命令而跳过仓库必须检查。失败分类为本次引入/相关既有/无关既有/环境问题；无关失败不扩大代码修改，但仍遵守合并/发布门禁。发布产物仅在发布阶段需要，统一 `40-Slide/outputs`，单 tar <=300,000,000 字节并生成校验和。

## 4. 交付与依赖

每阶段独立 commit/PR，PR 写明触发条件、行为变化、兼容风险与实际测试；不要求六阶段强塞进四个 PR。文档和 fixtures 随第一个实施 PR 纳入仓库，避免任务依赖未提交的本地路径。Multica 父任务附计划和复核文档，子任务写明可独立读取的范围、验收及前置编号。

- MAX-52（done）：作为 Cron 取消/底层 settlement 回归基线，不重复建单或倒退其修复。
- MAX-84（blocked）：同触及 gateway/reconnect，保持去重/重连契约；TLS/WSS 生产条件由原任务负责，不是 runtime 开发前置。
- MAX-85（blocked）：指标生产启用与本计划无直接代码依赖，不等待其完成。

任务组织采用一个总任务与六个实施子任务，按依赖逐阶段验收；每个子任务的完成证据回链总任务。

## 5. 覆盖追踪与版本记录

| 原报告主题 | 本计划落点 |
|---|---|
| AgentRuntime / TurnState / façade | T1、§2.1–2.2 |
| candidate final、文本/跨步/工具/no-progress | T2、§2.3–2.4 |
| typed errors、空答、续写、stream recovery | T3、§2.5 |
| ContextManager / autoCompact / rapid-refill | T4、§2.6 |
| optional deadline / maxIterations / 资源边界 | T5、§2.7 |
| checkpoint、幂等、审批、并发、注入、thinking | T1–T6 的兼容门禁 |
| 全链路 RuntimeEvent、效果评测和上线 | T6、§2.8 |
| 报告未覆盖的 stream/history 与 subagent 假完成 | T2/T3，A1/A7 |

v1：由报告“四个 PR、lifecycle 先于 supervisor”调整为六阶段，理由是先取消保护会暴露 provider idle、无进展和副作用收敛缺口；无业务代码变更。后续范围/默认策略变更追加 v2 记录原因与累计资源，不覆盖本版本或重置统计。
